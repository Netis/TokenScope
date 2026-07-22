//! Unit tests for the pure, extractable helpers of the composition root —
//! `StageTask::Display` and `Pipeline::supervise`. Both are re-exported from
//! `heron::` (`lib.rs`), so they're testable here without going through the
//! binary's private `cmd` module.
//!
//! `supervise` is the panic/cancel detector: it resolves as soon as any
//! stage task exits with a `JoinError` (panic or cancellation), and returns
//! `None` when every stage exits cleanly. These two outcomes drive the
//! shutdown coordinator in `main.rs`, so the contract is worth pinning.

use std::time::Duration;

use heron::{Pipeline, StageTask};

fn task(stage: &'static str, shard: Option<usize>, pipeline: Option<&str>) -> StageTask {
    StageTask {
        stage,
        shard,
        pipeline: pipeline.map(String::from),
    }
}

// ---- StageTask::Display ----

#[test]
fn stagetask_display_pipeline_and_shard() {
    // Per-pipeline sharded worker: the canonical "pipeline.stage.shard" label.
    let t = task("protocol", Some(3), Some("local"));
    assert_eq!(t.to_string(), "local.protocol.3");
}

#[test]
fn stagetask_display_pipeline_no_shard() {
    // Per-pipeline singleton stage (e.g. a single dispatcher): "pipeline.stage".
    let t = task("dispatcher", None, Some("local"));
    assert_eq!(t.to_string(), "local.dispatcher");
}

#[test]
fn stagetask_display_shard_no_pipeline() {
    // Shared stage with shards (none exist today, but the format must stay
    // stable): "stage.shard", no leading pipeline dot.
    let t = task("storage_sink", Some(0), None);
    assert_eq!(t.to_string(), "storage_sink.0");
}

#[test]
fn stagetask_display_no_pipeline_no_shard() {
    // Shared singleton stage (the actual storage_sink / pair_sweeper shape):
    // just the stage name.
    let t = task("pair_sweeper", None, None);
    assert_eq!(t.to_string(), "pair_sweeper");
}

#[test]
fn stagetask_display_pipeline_dotname_is_preserved() {
    // A pipeline name containing a dot is emitted verbatim — the label is
    // for humans/logs, not re-parsed, so dots in names don't need escaping.
    let t = task("metrics", Some(1), Some("us-east-1"));
    assert_eq!(t.to_string(), "us-east-1.metrics.1");
}

// ---- Pipeline::supervise ----

#[tokio::test]
async fn supervise_returns_none_when_all_stages_exit_cleanly() {
    let handles: Vec<(StageTask, tokio::task::JoinHandle<()>)> = vec![
        (task("dispatcher", None, Some("local")), tokio::spawn(async {})),
        (task("protocol", Some(0), Some("local")), tokio::spawn(async {})),
        (task("storage_sink", None, None), tokio::spawn(async {})),
    ];
    let result = Pipeline::supervise(handles).await;
    assert!(result.is_none(), "all-clean exit → None (drained); got {result:?}");
}

#[tokio::test]
async fn supervise_surfaces_first_panicking_stage() {
    // A panicking stage resolves `supervise` with the panicking task's label,
    // so the shutdown coordinator can name the dead worker. The clean stages
    // are still in the set; `supervise` returns on the first JoinError.
    let panic_label = task("protocol", Some(2), Some("local"));
    let handles: Vec<(StageTask, tokio::task::JoinHandle<()>)> = vec![
        (task("dispatcher", None, Some("local")), tokio::spawn(async {}),
        (
            panic_label.clone(),
            tokio::spawn(async {
                panic!("synthetic protocol worker panic");
            }),
        ),
        (task("storage_sink", None, None), tokio::spawn(async {})),
    ];
    let result = Pipeline::supervise(handles).await;
    let (label, err) = result.expect("panic → Some((label, JoinError))");
    assert_eq!(label.to_string(), "local.protocol.2");
    assert!(err.is_panic(), "the error should be a panic; got {err:?}");
}

#[tokio::test]
async fn supervise_returns_none_for_empty_handle_set() {
    // No stages at all → trivially drained. Guards the JoinSet::join_next loop
    // against an empty-input edge case.
    let result = Pipeline::supervise(Vec::new()).await;
    assert!(result.is_none(), "empty handle set → None");
}

#[tokio::test]
async fn supervise_returns_none_when_stages_exit_after_short_work() {
    // Stages that do real (tiny) work then finish cleanly must still drain.
    // Catches a regression where a slow-but-clean stage is misreported as
    // a failure due to a select!/timeout interaction.
    let handles: Vec<(StageTask, tokio::task::JoinHandle<()>)> = vec![
        (
            task("llm", Some(0), Some("local")),
            tokio::spawn(async {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }),
        ),
        (
            task("turn", Some(0), Some("local")),
            tokio::spawn(async {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }),
        ),
    ];
    let result = Pipeline::supervise(handles).await;
    assert!(result.is_none(), "short clean work → None; got {result:?}");
}
