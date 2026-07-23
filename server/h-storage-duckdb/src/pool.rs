//! Async-friendly connection pool over sync DuckDB read connections.
//!
//! `acquire()` is async (awaits a semaphore permit); the returned handle
//! dereferences to `&Connection` and is safe to move into `spawn_blocking`.
//!
//! The pool's contents are reachable via an `Arc<ReadPoolInner>`
//! indirection so that the **entire** working set can be swapped at
//! once via [`ReadPool::replace_all`]. This is what `reopen_all_connections`
//! relies on to recover from a DuckDB in-process-instance FATAL: a
//! `PooledConn` holds a private `Arc` snapshot to the inner taken at
//! `acquire` time, so when it drops it pushes the connection back into
//! its own (possibly already-orphaned) inner — not into the post-swap
//! current pool. The old inner is then dropped once the last in-flight
//! caller releases it, taking its stale connections with it. Net effect:
//! no stale connection ever re-enters circulation.
use std::sync::{Arc, Mutex as StdMutex};

use duckdb::Connection;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use h_common::error::{AppError, Result};

struct ReadPoolInner {
    conns: StdMutex<Vec<Connection>>,
}

#[derive(Clone)]
pub(crate) struct ReadPool {
    inner: Arc<StdMutex<Arc<ReadPoolInner>>>,
    semaphore: Arc<Semaphore>,
    #[cfg(feature = "fault-injection")]
    fault_set: crate::fault_injection::FaultSet,
}

impl ReadPool {
    pub(crate) fn new(
        conns: Vec<Connection>,
        #[cfg(feature = "fault-injection")] fault_set: crate::fault_injection::FaultSet,
    ) -> Self {
        let size = conns.len();
        let inner = Arc::new(ReadPoolInner {
            conns: StdMutex::new(conns),
        });
        Self {
            inner: Arc::new(StdMutex::new(inner)),
            semaphore: Arc::new(Semaphore::new(size)),
            #[cfg(feature = "fault-injection")]
            fault_set,
        }
    }

    pub(crate) async fn acquire(&self) -> Result<PooledConn> {
        #[cfg(feature = "fault-injection")]
        {
            use crate::fault_injection::FaultPoint;
            if self.fault_set.should_fire(FaultPoint::ReadPoolPoisoned) {
                return Err(crate::fault_injection::read_pool_poisoned_error());
            }
        }
        let permit = self
            .semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| AppError::Storage(format!("read pool closed: {e}")))?;
        let inner_snapshot = {
            let guard = self
                .inner
                .lock()
                .map_err(|e| AppError::Storage(format!("read pool poisoned: {e}")))?;
            guard.clone()
        };
        let conn = {
            let mut guard = inner_snapshot
                .conns
                .lock()
                .map_err(|e| AppError::Storage(format!("read pool conns poisoned: {e}")))?;
            guard
                .pop()
                .ok_or_else(|| AppError::Storage("read pool invariant violated".to_string()))?
        };
        Ok(PooledConn {
            conn: Some(conn),
            inner: inner_snapshot,
            _permit: permit,
        })
    }

    /// Atomically replace the pool's connection set with `new_conns`.
    /// The caller is responsible for ensuring `new_conns.len()` equals
    /// the pool's original size (the semaphore's permit count is left
    /// unchanged; passing a different size would either over-issue
    /// permits or stall acquires).
    ///
    /// In-flight `PooledConn` handles taken before this call drop back
    /// into the previous inner, which then has no other Arc references
    /// and is freed along with its now-stale connections. Subsequent
    /// `acquire()` calls see the new inner.
    pub(crate) fn replace_all(&self, new_conns: Vec<Connection>) -> Result<()> {
        let new_inner = Arc::new(ReadPoolInner {
            conns: StdMutex::new(new_conns),
        });
        let mut guard = self
            .inner
            .lock()
            .map_err(|e| AppError::Storage(format!("read pool poisoned: {e}")))?;
        *guard = new_inner;
        Ok(())
    }
}

pub(crate) struct PooledConn {
    conn: Option<Connection>,
    inner: Arc<ReadPoolInner>,
    _permit: OwnedSemaphorePermit,
}

impl Drop for PooledConn {
    fn drop(&mut self) {
        if let Some(c) = self.conn.take() {
            if let Ok(mut g) = self.inner.conns.lock() {
                g.push(c);
            }
        }
    }
}

impl std::ops::Deref for PooledConn {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.conn.as_ref().expect("conn present until drop")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a `ReadPool` over `conns`, threading a fresh `FaultSet` only when
    /// the `fault-injection` feature is on (the param is `#[cfg]`-gated on
    /// `ReadPool::new`, so the call site must match).
    fn pool(conns: Vec<Connection>) -> ReadPool {
        #[cfg(feature = "fault-injection")]
        {
            ReadPool::new(conns, crate::fault_injection::FaultSet::new())
        }
        #[cfg(not(feature = "fault-injection"))]
        {
            ReadPool::new(conns)
        }
    }

    /// Open an isolated in-memory DuckDB connection and stamp a single-row
    /// sentinel table into it so the pool can tell connections apart.
    fn conn_with_sentinel(label: &str) -> Connection {
        let conn = Connection::open(":memory:").expect("open in-memory");
        conn.execute(
            &format!("CREATE TABLE sentinel AS SELECT '{label}' AS who"),
            [],
        )
        .expect("create sentinel");
        conn
    }

    /// Read the `who` column from a pooled connection's sentinel table.
    fn who(conn: &PooledConn) -> String {
        let mut stmt = conn.prepare("SELECT who FROM sentinel").expect("prepare");
        let s: String = stmt.query_row([], |row| row.get(0)).expect("query_row");
        s
    }

    #[tokio::test]
    async fn acquire_returns_a_usable_connection() {
        let p = pool(vec![conn_with_sentinel("A")]);
        let conn = p.acquire().await.expect("acquire");
        assert_eq!(who(&conn), "A");
    }

    #[tokio::test]
    async fn dropping_a_handle_returns_the_connection_to_the_pool() {
        // One connection, one permit. After dropping the first acquire, the
        // same connection must re-enter the pool and be re-acquirable.
        let p = pool(vec![conn_with_sentinel("A")]);

        let first = p.acquire().await.expect("first acquire");
        assert_eq!(who(&first), "A");
        drop(first);

        let second = p.acquire().await.expect("second acquire (post-drop)");
        assert_eq!(who(&second), "A");
    }

    #[tokio::test]
    async fn acquire_round_robin_across_pool_size() {
        // A pool of two distinct connections hands them out one at a time;
        // after both are dropped they're available again.
        let p = pool(vec![conn_with_sentinel("A"), conn_with_sentinel("B")]);

        let h1 = p.acquire().await.expect("acquire 1");
        let h2 = p.acquire().await.expect("acquire 2");
        let labels = std::collections::HashSet::from([who(&h1), who(&h2)]);
        assert_eq!(labels.len(), 2, "both distinct connections served");
        assert!(labels.contains("A"));
        assert!(labels.contains("B"));
        drop(h1);
        drop(h2);

        // After releasing both, two more acquires must succeed again.
        let _ = p.acquire().await.expect("re-acquire 1");
        let _ = p.acquire().await.expect("re-acquire 2");
    }

    #[tokio::test]
    async fn replace_all_swaps_in_a_new_working_set() {
        // Start with one connection (sentinel A). replace_all swaps in a
        // different connection (sentinel B); the next acquire must see B.
        let p = pool(vec![conn_with_sentinel("A")]);

        let pre = p.acquire().await.expect("pre-swap acquire");
        assert_eq!(who(&pre), "A");
        drop(pre);

        p.replace_all(vec![conn_with_sentinel("B")]).expect("replace_all");

        let post = p.acquire().await.expect("post-swap acquire");
        assert_eq!(who(&post), "B");
    }

    #[tokio::test]
    async fn in_flight_handle_drops_into_old_inner_not_new_pool() {
        // The core `reopen_all_connections` contract: a handle taken before
        // replace_all holds a private Arc snapshot of the *old* inner, so on
        // drop it returns its connection to the orphaned old inner — never to
        // the new pool. Use a size-2 pool so a fresh acquire can proceed while
        // the stale handle still holds one permit.
        let p = pool(vec![conn_with_sentinel("A"), conn_with_sentinel("A")]);

        // Hold a handle across the swap — it still reads the old connection.
        let in_flight = p.acquire().await.expect("in-flight acquire");
        assert_eq!(who(&in_flight), "A");

        p.replace_all(vec![conn_with_sentinel("B"), conn_with_sentinel("B")])
            .expect("replace_all");

        // One permit is still held by the stale handle, but the pool has two,
        // so a fresh acquire proceeds and must see a *new* (B) connection.
        let fresh = p.acquire().await.expect("fresh acquire post-swap");
        assert_eq!(who(&fresh), "B");
        drop(fresh);

        // Dropping the stale handle returns its A connection to the orphaned
        // old inner (freed with it) — NOT to the new pool. A subsequent
        // acquire must still see only B, proving no stale connection re-enters
        // circulation.
        drop(in_flight);
        let after = p.acquire().await.expect("acquire after stale drop");
        assert_eq!(who(&after), "B");
    }

    #[tokio::test]
    async fn acquire_blocks_when_pool_is_exhausted_then_resumes_on_drop() {
        // One connection / one permit: a second concurrent acquire must wait
        // until the first handle is dropped, then complete.
        let p = pool(vec![conn_with_sentinel("A")]);
        let p2 = p.clone(); // ReadPool is Clone (shares inner + semaphore)
        let h1 = p.acquire().await.expect("first acquire");

        let join = tokio::spawn(async move {
            // Will block until h1 is dropped below.
            let h2 = p2.acquire().await.expect("second acquire after drop");
            who(&h2)
        });
        // Give the spawned task a moment to park on the semaphore.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(!join.is_finished(), "second acquire must be parked");
        drop(h1);
        let label = join.await.expect("join");
        assert_eq!(label, "A");
    }
}
