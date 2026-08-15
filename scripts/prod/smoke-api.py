#!/usr/bin/env python3
"""Read-path smoke: one request to every endpoint the console calls.

The deploy health gate asks whether the process came up and is capturing. That
question is answered by a binary whose storage backend cannot serve a single
query — the pipeline writes, the API listens, and every page in the console is
a 500. This walks the read paths instead, so "deployed successfully" means the
console works, not merely that the port is open.

Empty is fine: an instance with no traffic yet answers every list with zero
rows, and detail lookups are skipped when there is no row to look up. Only a
non-200 fails.

    smoke-api.py <base-url> [--window-secs N]

Exit 0 when every endpoint answered 200, 1 otherwise (offending endpoints and
the first line of their error are printed).
"""

import json
import sys
import time
import urllib.error
import urllib.request

TIMEOUT_SECS = 60


def endpoints(window_secs):
    now = int(time.time())
    w = f"start={now - window_secs}&end={now}"
    # `fields` is validated against a backend allowlist, so a typo here is a
    # 500, not a skipped check. These six are what the overview page requests.
    metric_fields = "call_count,ttft_avg,ttft_p95,total_output_tokens,error_count,active_calls_max"
    return [
        ("health", "/api/health"),
        ("internal-metrics", "/api/internal-metrics"),
        ("spans", f"/api/spans?{w}&page_size=5"),
        # Page 2 of a small page size: a list whose ORDER BY has no total order
        # can hand back rows already seen on page 1.
        ("spans page 2", f"/api/spans?{w}&page_size=2&page=2"),
        ("traces", f"/api/traces?{w}&page_size=5"),
        ("traces summary", f"/api/traces/summary?{w}"),
        ("traces activity", f"/api/traces/activity?{w}"),
        ("agent-sessions", f"/api/agent-sessions?{w}&page_size=5"),
        ("http-exchanges", f"/api/http-exchanges?{w}&page_size=5"),
        ("metrics summary", f"/api/metrics/summary?{w}"),
        ("metrics timeseries", f"/api/metrics/timeseries?{w}&granularity=1m&fields={metric_fields}"),
        ("metrics ts by model", f"/api/metrics/timeseries?{w}&granularity=1m&fields=call_count&group_by=model"),
        ("metrics finish-reasons", f"/api/metrics/finish-reasons?{w}&granularity=1m"),
        ("metrics models", f"/api/metrics/models?{w}"),
        ("services", f"/api/services?{w}"),
        ("services topology", f"/api/services/topology?{w}"),
        ("filters models", "/api/filters/models"),
        ("filters server-ips", "/api/filters/server-ips"),
        ("filters wire-apis", "/api/filters/wire-apis"),
        ("filters agent-kinds", f"/api/filters/agent-kinds?{w}"),
        ("filters finish-reasons", "/api/filters/finish-reasons"),
    ]


def get(base, path):
    req = urllib.request.Request(base + path, headers={"Accept": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECS) as r:
            return r.status, r.read(), (time.time() - t0) * 1000
    except urllib.error.HTTPError as e:
        return e.code, e.read(), (time.time() - t0) * 1000
    except Exception as e:  # noqa: BLE001 — connection refused, DNS, timeout
        return 0, str(e).encode(), (time.time() - t0) * 1000


def describe(payload):
    """One-line summary of a response, and its `data` for follow-up lookups."""
    try:
        data = json.loads(payload).get("data")
    except Exception:  # noqa: BLE001
        return "unparseable body", None
    if isinstance(data, dict):
        if "items" in data:
            return f"items={len(data['items'])} total={data.get('total')}", data
        if "nodes" in data:
            return f"nodes={len(data['nodes'])} edges={len(data.get('edges', []))}", data
        if "series" in data and "timestamps" in data:
            return f"series={len(data['series'])} buckets={len(data['timestamps'])}", data
        if "series" in data:
            return f"series={len(data['series'])}", data
        return "keys=" + ",".join(sorted(data)[:5]), data
    if isinstance(data, list):
        return f"rows={len(data)}", data
    return type(data).__name__, data


def main():
    argv = sys.argv[1:]
    if not argv:
        sys.exit(__doc__)
    base = argv[0].rstrip("/")
    window = 3600
    if "--window-secs" in argv:
        window = int(argv[argv.index("--window-secs") + 1])

    failures = []
    ids = {}
    print(f"read-path smoke → {base}")
    print(f"{'endpoint':<24}{'code':>5}{'ms':>8}  shape")
    print("-" * 76)

    for name, path in endpoints(window):
        code, body, ms = get(base, path)
        shape, data = describe(body)
        print(f"{name:<24}{code:>5}{ms:>8.0f}  {shape}")
        if code != 200:
            failures.append((name, code, body[:200].decode("utf-8", "replace")))
            continue
        # Remember one id per entity so the detail routes get exercised too.
        if isinstance(data, dict) and data.get("items"):
            first = data["items"][0]
            if name == "spans":
                ids["span"] = first.get("id")
            elif name == "traces":
                ids["trace"] = first.get("id") or first.get("turn_id")
            elif name == "http-exchanges":
                ids["exchange"] = first.get("id")

    print()
    for name, key, template in (
        ("span detail", "span", "/api/spans/{}"),
        ("trace detail", "trace", "/api/traces/{}"),
        ("trace spans", "trace", "/api/traces/{}/spans"),
        ("exchange detail", "exchange", "/api/http-exchanges/{}"),
    ):
        rid = ids.get(key)
        if not rid:
            print(f"{name:<24}{'-':>5}{'-':>8}  (no row in the window to look up)")
            continue
        code, body, ms = get(base, template.format(rid))
        shape, _ = describe(body)
        print(f"{name:<24}{code:>5}{ms:>8.0f}  {shape}")
        if code != 200:
            failures.append((name, code, body[:200].decode("utf-8", "replace")))

    print()
    if failures:
        print(f"FAILED — {len(failures)} endpoint(s) did not answer 200:")
        for name, code, snippet in failures:
            print(f"  {name}: HTTP {code} — {snippet}")
        return 1
    print("OK — every read path answered 200")
    return 0


if __name__ == "__main__":
    sys.exit(main())
