//! Table-driven tests for `heron config validate` and `heron doctor` —
//! the pre-flight diagnostic subcommands.
//!
//! These exercise the **process-level** wiring that's invisible to unit
//! tests: clap parsing, exit-code contracts, and JSON output shape. The
//! `run` functions live in the private `cmd` module of the binary crate, so
//! the only way to drive them (and assert on their printed output) is to
//! spawn the compiled `heron` binary with `-c <tmpfile>` and inspect stdout
//! + the exit status — the same shape `cli_smoke.rs` uses for `--help`.
//!
//! Configs are written to temp files (tempfile) so every case is hermetic
//! and no real capture/storage is touched. None of these need
//! CAP_NET_RAW/root — `validate` never opens a NIC, and `doctor`'s
//! capture-capability check only *reads* `/proc/self/status`. The cases
//! below pin behavior to the documented exit-code table:
//!
//! validate: 0 = valid, 1 = validation issues, 2 = IO/parse error
//! doctor:   0 = no `fail` check, 1 = ≥1 `fail` check

use std::fs;
use std::process::Command;

use serde::Deserialize;
use tempfile::TempDir;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_heron")
}

/// Run `heron <subcommand> --config <path>` (plus optional extra args) and
/// return (exit_code, stdout, stderr). `--config` is a global flag so it
/// works for both `config validate` and `doctor`.
fn run(args: &[&str], config_path: &str) -> (i32, String, String) {
    let out = Command::new(bin())
        .args(args)
        .arg("--config")
        .arg(config_path)
        .output()
        .unwrap_or_else(|e| panic!("spawn heron {:?}: {e}", args));
    let code = out.status.code().unwrap_or(-1);
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    (code, stdout, stderr)
}

/// Write `contents` to a `config.toml` inside a fresh temp dir and return
/// `(dir, config_path)`. The TempDir is held by the caller for the test's
/// duration so the file outlives the spawned child.
fn write_config(contents: &str) -> (TempDir, String) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("config.toml");
    fs::write(&path, contents).expect("write config");
    (dir, path.to_string_lossy().into_owned())
}

/// A minimal valid config: one pipeline with one pcap-file source. Retention
/// defaults (spans=traces=30) are clean so `validate()` returns no issues.
/// `validate`/`doctor` never open the pcap file, so its path need not exist.
/// The API binds `127.0.0.1:0` so `doctor`'s `api.bind` check passes
/// deterministically (OS-assigned ephemeral port). The DuckDB path lives
/// under `data_dir` so `doctor`'s `storage.path` writability probe passes
/// without depending on the test CWD being writable, and there's no
/// cross-run file pollution.
fn valid_config_for(data_dir: &std::path::Path) -> String {
    let duckdb_path = data_dir.join("heron.duckdb").to_string_lossy().into_owned();
    format!(
        r#"[storage]
backend = "duckdb"
[storage.duckdb]
path = "{duckdb_path}"

[api]
listen = "127.0.0.1"
port = 0

[[pipeline]]
name = "local"
[[pipeline.sources]]
type = "pcap-file"
path = "/tmp/does-not-need-to-exist.pcap"
"#
    )
}

/// Write a valid config to a fresh temp dir and return `(dir, config_path)`.
fn write_valid_config() -> (TempDir, String) {
    let dir = tempfile::tempdir().expect("tempdir");
    let cfg = valid_config_for(dir.path());
    let path = dir.path().join("config.toml");
    fs::write(&path, &cfg).expect("write config");
    (dir, path.to_string_lossy().into_owned())
}

/// Write a valid config + extra appended TOML sections to a fresh temp dir.
/// The base config's DuckDB path is anchored to that temp dir so the
/// appended `[storage.*]` overrides compose correctly.
fn write_valid_config_plus(extra: &str) -> (TempDir, String) {
    let dir = tempfile::tempdir().expect("tempdir");
    let cfg = format!("{}\n{extra}", valid_config_for(dir.path()));
    let path = dir.path().join("config.toml");
    fs::write(&path, &cfg).expect("write config");
    (dir, path.to_string_lossy().into_owned())
}

#[derive(Deserialize)]
struct ValidateJson {
    ok: bool,
    config_path: String,
    issues: Vec<serde_json::Value>,
}

fn issue_codes(v: &ValidateJson) -> Vec<String> {
    v.issues
        .iter()
        .filter_map(|i| i["code"].as_str().map(String::from))
        .collect()
}

// ---- validate: success paths ----

#[test]
fn validate_valid_config_exits_zero_and_reports_ok() {
    let (_dir, path) = write_valid_config();
    let (code, stdout, _stderr) = run(&["config", "validate"], &path);
    assert_eq!(code, 0, "valid config must exit 0; stdout:\n{stdout}");
    let v: ValidateJson =
        serde_json::from_str(stdout.trim()).expect("validate emits JSON by default");
    assert!(v.ok, "ok=true for valid config; got {v:?}");
    assert!(v.issues.is_empty(), "no issues for valid config; got {:?}", v.issues);
    assert!(
        v.config_path.ends_with("config.toml"),
        "config_path echoes the file: {v:?}"
    );
}

#[test]
fn validate_text_mode_lists_ok_for_valid_config() {
    let (_dir, path) = write_valid_config();
    let (code, stdout, _stderr) = run(&["config", "validate", "--text"], &path);
    assert_eq!(code, 0, "valid config --text must exit 0; stdout:\n{stdout}");
    assert!(
        stdout.contains("ok") && stdout.contains("config valid"),
        "text mode reports ok for valid config; got:\n{stdout}"
    );
}

#[test]
fn validate_empty_config_is_warn_only_and_exits_zero() {
    // No [[pipeline]] → NoPipelines (Warn). No error issues → exit 0. The
    // runtime tolerates this (idle-API mode), so validate must NOT fail it.
    let dir = tempfile::tempdir().expect("tempdir");
    let cfg = valid_config_for(dir.path());
    // Strip the [[pipeline]] block: keep only storage + api.
    let base = cfg.split("\n\n[[pipeline]]").next().unwrap().to_string();
    let path = dir.path().join("config.toml");
    fs::write(&path, &base).expect("write");
    let (code, stdout, _stderr) = run(&["config", "validate"], &path.to_string_lossy());
    assert_eq!(code, 0, "NoPipelines is a warning, not an error — exit 0; stdout:\n{stdout}");
    let v: ValidateJson = serde_json::from_str(stdout.trim()).expect("JSON");
    assert!(v.ok, "ok=true despite the warn; got {v:?}");
    assert_eq!(v.issues.len(), 1, "exactly the NoPipelines warn; got {v:?}");
    assert_eq!(v.issues[0]["code"], "no_pipelines", "warn code is no_pipelines; got {:?}", v.issues[0]);
    assert_eq!(v.issues[0]["severity"], "warn");
    // Hold the temp dir for the test duration.
    drop(dir);
}

// ---- validate: error paths (exit 1) ----

#[test]
fn validate_duplicate_pipeline_name_exits_one() {
    let extra = "[[pipeline]]\nname = \"dup\"\n[[pipeline.sources]]\ntype = \"pcap-file\"\npath = \"/tmp/x.pcap\"\n\
                 [[pipeline]]\nname = \"dup\"\n[[pipeline.sources]]\ntype = \"pcap-file\"\npath = \"/tmp/y.pcap\"\n";
    let (_dir, path) = write_valid_config_plus(extra);
    let (code, stdout, _stderr) = run(&["config", "validate"], &path);
    assert_eq!(code, 1, "duplicate pipeline name is an error → exit 1; stdout:\n{stdout}");
    let v: ValidateJson = serde_json::from_str(stdout.trim()).expect("JSON");
    assert!(!v.ok);
    assert!(
        issue_codes(&v).contains(&"duplicate_pipeline_name".to_string()),
        "expected duplicate_pipeline_name issue; got {:?}",
        issue_codes(&v)
    );
}

#[test]
fn validate_duplicate_source_id_exits_one() {
    // Two pcap-file sources with the same basename → same resolved source_id.
    let extra = "[[pipeline]]\nname = \"p\"\n[[pipeline.sources]]\ntype = \"pcap-file\"\npath = \"/tmp/same.pcap\"\n\
                 [[pipeline.sources]]\ntype = \"pcap-file\"\npath = \"/elsewhere/same.pcap\"\n";
    let (_dir, path) = write_valid_config_plus(extra);
    let (code, stdout, _stderr) = run(&["config", "validate"], &path);
    assert_eq!(code, 1, "duplicate source_id is an error; stdout:\n{stdout}");
    let v: ValidateJson = serde_json::from_str(stdout.trim()).expect("JSON");
    assert!(issue_codes(&v).contains(&"duplicate_source_id".to_string()));
}

#[test]
fn validate_traces_outliving_spans_exits_one() {
    let (_dir, path) = write_valid_config_plus("[storage.retention]\nspans = 7\ntraces = 30\n");
    let (code, stdout, _stderr) = run(&["config", "validate"], &path);
    assert_eq!(code, 1, "traces>spans retention is an error → exit 1; stdout:\n{stdout}");
    let v: ValidateJson = serde_json::from_str(stdout.trim()).expect("JSON");
    assert!(issue_codes(&v).contains(&"traces_retention_exceeds_spans".to_string()));
}

#[test]
fn validate_traces_zero_with_finite_spans_exits_one() {
    // traces=0 is the "never expire" sentinel; with finite spans it violates
    // the no-JOIN read-path constraint.
    let (_dir, path) = write_valid_config_plus("[storage.retention]\nspans = 7\ntraces = 0\n");
    let (code, stdout, _stderr) = run(&["config", "validate"], &path);
    assert_eq!(code, 1, "traces=0 with finite spans is an error; stdout:\n{stdout}");
    let v: ValidateJson = serde_json::from_str(stdout.trim()).expect("JSON");
    assert!(issue_codes(&v).contains(&"traces_retention_exceeds_spans".to_string()));
}

#[test]
fn validate_spans_zero_satisfies_any_traces() {
    // spans=0 = infinite, so any finite traces is fine → exit 0.
    let (_dir, path) = write_valid_config_plus("[storage.retention]\nspans = 0\ntraces = 999\n");
    let (code, stdout, _stderr) = run(&["config", "validate"], &path);
    assert_eq!(code, 0, "spans=0 (infinite) satisfies traces=999; stdout:\n{stdout}");
}

#[test]
fn validate_unknown_retention_granularity_exits_one() {
    let (_dir, path) =
        write_valid_config_plus("[storage.retention.metrics]\n\"10sec\" = 5\n");
    let (code, stdout, _stderr) = run(&["config", "validate"], &path);
    assert_eq!(code, 1, "unknown granularity typo is an error; stdout:\n{stdout}");
    let v: ValidateJson = serde_json::from_str(stdout.trim()).expect("JSON");
    assert!(issue_codes(&v).contains(&"unknown_retention_granularity".to_string()));
}

#[test]
fn validate_unsafe_pcap_dump_pipeline_name_exits_one() {
    // pipeline name ".." sanitizes to an unsafe path component when
    // pcap_dump is enabled → UnsafePcapDumpPipelineName (Error).
    let extra = "[[pipeline]]\nname = \"..\"\n[[pipeline.sources]]\ntype = \"pcap-file\"\npath = \"/tmp/x.pcap\"\n\
                 [pipeline.pcap_dump]\nenabled = true\ndir = \"/tmp/dumps\"\n";
    let (_dir, path) = write_valid_config_plus(extra);
    let (code, stdout, _stderr) = run(&["config", "validate"], &path);
    assert_eq!(code, 1, "unsafe pcap_dump name is an error; stdout:\n{stdout}");
    let v: ValidateJson = serde_json::from_str(stdout.trim()).expect("JSON");
    assert!(issue_codes(&v).contains(&"unsafe_pcap_dump_pipeline_name".to_string()));
}

#[test]
fn validate_no_sources_is_warn_not_error() {
    // A pipeline with zero sources is a Warn (runtime tolerates it), so the
    // overall exit is 0 — guards against a regression that turns it into an
    // error and breaks idle-API deployments.
    let (_dir, path) = write_valid_config_plus("[[pipeline]]\nname = \"empty\"\n");
    let (code, stdout, _stderr) = run(&["config", "validate"], &path);
    assert_eq!(code, 0, "NoSourcesInPipeline is a warn → exit 0; stdout:\n{stdout}");
    let v: ValidateJson = serde_json::from_str(stdout.trim()).expect("JSON");
    assert!(v.ok);
    assert!(issue_codes(&v).contains(&"no_sources_in_pipeline".to_string()));
}

// ---- validate: IO/parse error paths (exit 2) ----

#[test]
fn validate_missing_file_exits_two() {
    let dir = tempfile::tempdir().expect("tempdir");
    let missing = dir.path().join("absent.toml").to_string_lossy().into_owned();
    let (code, stdout, _stderr) = run(&["config", "validate"], &missing);
    assert_eq!(code, 2, "missing config file → exit 2; stdout:\n{stdout}");
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).expect("JSON");
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"], "io");
}

#[test]
fn validate_unparseable_toml_exits_two() {
    // Missing a closing quote → TOML parse error (not a validation issue).
    let (_dir, path) = write_config("[storage]\nbackend = \"duckdb\n");
    let (code, stdout, _stderr) = run(&["config", "validate"], &path);
    assert_eq!(code, 2, "unparseable TOML → exit 2; stdout:\n{stdout}");
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).expect("JSON");
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"], "parse");
}

// ---- doctor ----

#[derive(Deserialize)]
struct DoctorReport {
    ok: bool,
    checks: Vec<DoctorCheck>,
}

#[derive(Deserialize)]
struct DoctorCheck {
    name: String,
    status: String,
    detail: String,
}

fn doctor_check<'a>(report: &'a DoctorReport, name: &str) -> &'a DoctorCheck {
    report
        .checks
        .iter()
        .find(|c| c.name == name)
        .unwrap_or_else(|| panic!("missing check {name}; got {:?}", report.checks))
}

/// Status of a named check as `&str` — keeps `assert_eq!` comparisons as
/// `&str == &str` (avoids `&String`-vs-`&str` ambiguity).
fn doctor_status(report: &DoctorReport, name: &str) -> &str {
    doctor_check(report, name).status.as_str()
}

#[test]
fn doctor_valid_config_passes_config_checks() {
    // `doctor` aggregates every check. On an unprivileged host the
    // capture.capabilities check may be `fail` (flipping the overall exit to
    // 1), so this asserts on the *config* checks (discovery, parse, validate,
    // storage.path, api.bind) being `pass` rather than pinning the overall
    // exit code — the capture-privilege outcome is environment-dependent.
    let (_dir, path) = write_valid_config();
    let (_code, stdout, _stderr) = run(&["doctor"], &path);
    let report: DoctorReport = serde_json::from_str(stdout.trim()).expect("doctor emits JSON");
    assert_eq!(doctor_status(&report, "config.discovery"), "pass");
    assert_eq!(doctor_status(&report, "config.parse"), "pass");
    assert_eq!(doctor_status(&report, "config.validate"), "pass");
    assert_eq!(doctor_status(&report, "storage.path"), "pass");
    assert_eq!(doctor_status(&report, "api.bind"), "pass");
    let cap = doctor_status(&report, "capture.capabilities");
    assert!(
        cap == "pass" || cap == "warn" || cap == "fail",
        "capture.capabilities is one of pass/warn/fail; got {cap}"
    );
}

#[test]
fn doctor_missing_config_fails_discovery_check() {
    let dir = tempfile::tempdir().expect("tempdir");
    let missing = dir.path().join("absent.toml").to_string_lossy().into_owned();
    let (code, stdout, _stderr) = run(&["doctor"], &missing);
    let report: DoctorReport = serde_json::from_str(stdout.trim()).expect("JSON");
    assert_eq!(
        doctor_status(&report, "config.discovery"), "fail",
        "missing file fails config.discovery"
    );
    assert_eq!(code, 1, "a fail check flips doctor to exit 1; stdout:\n{stdout}");
    // parse/validate are skipped (warn), not re-failed, when discovery fails.
    assert_eq!(doctor_status(&report, "config.parse"), "warn");
}

#[test]
fn doctor_unparseable_config_fails_parse_check() {
    let (_dir, path) = write_config("[storage]\nbackend = \"duckdb\n");
    let (code, stdout, _stderr) = run(&["doctor"], &path);
    let report: DoctorReport = serde_json::from_str(stdout.trim()).expect("JSON");
    assert_eq!(
        doctor_status(&report, "config.parse"), "fail",
        "parse error fails config.parse"
    );
    assert_eq!(code, 1, "parse fail → exit 1; stdout:\n{stdout}");
}

#[test]
fn doctor_validation_error_fails_validate_check() {
    let (_dir, path) = write_valid_config_plus("[storage.retention]\nspans = 7\ntraces = 30\n");
    let (code, stdout, _stderr) = run(&["doctor"], &path);
    let report: DoctorReport = serde_json::from_str(stdout.trim()).expect("JSON");
    assert_eq!(
        doctor_status(&report, "config.validate"), "fail",
        "a validation error (traces>spans) fails config.validate"
    );
    assert_eq!(code, 1, "validate fail → exit 1; stdout:\n{stdout}");
}

#[test]
fn doctor_text_mode_runs_and_mentions_overall() {
    let (_dir, path) = write_valid_config();
    let (_code, stdout, _stderr) = run(&["doctor", "--text"], &path);
    assert!(
        stdout.contains("overall:"),
        "text mode prints an 'overall:' line; got:\n{stdout}"
    );
}

/// When the DuckDB file already exists, `doctor` probes it read/write instead
/// of the creatability path — covers the `path.exists()` arm of
/// `check_storage_path`.
#[test]
fn doctor_existing_duckdb_file_probes_rw() {
    let dir = tempfile::tempdir().expect("tempdir");
    // Pre-create an empty file at the configured DuckDB path.
    let duckdb = dir.path().join("existing.duckdb");
    fs::write(&duckdb, b"").expect("create empty duckdb file");
    let cfg = valid_config_for(dir.path())
        .replace("heron.duckdb", "existing.duckdb");
    let path = dir.path().join("config.toml");
    fs::write(&path, &cfg).expect("write config");
    let (_code, stdout, _stderr) = run(&["doctor"], &path);
    let report: DoctorReport = serde_json::from_str(stdout.trim()).expect("JSON");
    assert_eq!(
        doctor_status(&report, "storage.path"), "pass",
        "an existing empty file is openable rw → pass"
    );
}

/// A non-duckdb backend skips the path probe entirely — covers the
/// `backend != "duckdb"` early return in `check_storage_path`.
#[test]
fn doctor_clickhouse_backend_skips_path_probe() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut cfg = valid_config_for(dir.path());
    // Swap the backend to clickhouse; validate() only probes duckdb paths, so
    // the swap keeps config.validate clean.
    cfg = cfg.replace("backend = \"duckdb\"", "backend = \"clickhouse\"");
    let path = dir.path().join("config.toml");
    fs::write(&path, &cfg).expect("write config");
    let (_code, stdout, _stderr) = run(&["doctor"], &path);
    let report: DoctorReport = serde_json::from_str(stdout.trim()).expect("JSON");
    assert_eq!(doctor_status(&report, "storage.path"), "pass");
    let storage = doctor_check(&report, "storage.path");
    assert!(
        storage.detail.contains("backend=clickhouse"),
        "detail notes the backend and skipped probe; got: {}",
        storage.detail
    );
}

/// Global `--config` must be accepted ahead of the subcommand too (clap
/// global flag), not only after it. Guards against an arg-ordering regression
/// that would force users to repeat `-c` after the subcommand.
#[test]
fn config_flag_before_subcommand_still_works() {
    let (_dir, path) = write_valid_config();
    let out = Command::new(bin())
        .arg("--config")
        .arg(&path)
        .args(["config", "validate"])
        .output()
        .expect("spawn");
    let code = out.status.code().unwrap_or(-1);
    assert_eq!(
        code, 0,
        "global -c before subcommand; stdout:\n{}",
        String::from_utf8_lossy(&out.stdout)
    );
}
