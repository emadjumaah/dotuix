use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read, Write};
use std::net::IpAddr;
use std::path::Component;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use futures::{stream, StreamExt};
use tauri::{
    http::{Method, Request, Response},
    AppHandle, Emitter, Manager, State,
};

// Derived from Cargo.toml (kept in sync with tauri.conf.json) so the version
// reported to apps, used for minViewer gating, and stamped into exports can
// never drift from the real build.
const VIEWER_VERSION: &str = env!("CARGO_PKG_VERSION");

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

struct AppState {
    /// Raw file bytes from the .uix archive, shared with the uix:// protocol handler.
    files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    /// Writable SQLite for cart / orders — persisted in $APP_DATA/<app-id>/state.db.
    state_db: Mutex<Option<rusqlite::Connection>>,
    /// Read-only SQLite for product data — opened from a temp copy of data.db in .uix.
    data_db: Mutex<Option<rusqlite::Connection>>,
    /// manifest.id of the currently loaded app.
    app_id: Mutex<String>,
    /// Absolute path to the open .uix file; used for repack-on-close and lock management.
    uix_path: Mutex<String>,
    /// Pre-computed path to state.db on disk; avoids needing AppHandle in close handler.
    state_db_path: Mutex<Option<std::path::PathBuf>>,
    /// Path to the temp copy of data.db extracted from the .uix archive.
    data_db_path: Mutex<Option<std::path::PathBuf>>,
    /// Path to the .uix file set from argv on launch; consumed once by get_initial_file.
    initial_path: Mutex<Option<String>>,
    /// manifest.name of the currently loaded app; used to prefix dynamic window titles.
    app_name: Mutex<String>,
    /// manifest.permissions — gates raw-sql and other optional bridge capabilities.
    permissions: Mutex<Vec<String>>,
    /// manifest.state.mode — "file" (default, repack on close) or "device" (never repack).
    state_mode: Mutex<String>,
    /// Data schema version stored in state.db meta table; read on open, updated via schema_version_set.
    stored_schema_version: Arc<Mutex<u32>>,
    /// Content-Security-Policy served with uix:// HTML responses for the current app.
    content_security_policy: Arc<Mutex<String>>,
    /// manifest.sync.endpoint — HTTP(S) URL of Sync Hub (None if not configured; may be auto-discovered).
    sync_endpoint: Mutex<Option<String>>,
    /// manifest.sync.secret — base64 shared secret for the sync server.
    sync_secret: Mutex<Option<String>>,
    /// Files from the archive pending PIN-based decryption.
    pending_files: Mutex<Option<HashMap<String, Vec<u8>>>>,
    /// Parsed manifest pending completion after PIN unlock.
    pending_manifest: Mutex<Option<serde_json::Value>>,
    /// .uix path whose load is awaiting PIN entry.
    pending_path: Mutex<Option<String>>,

    /// Temporary extracted web root for iframe fallback mode.
    temp_web_root_path: Mutex<Option<std::path::PathBuf>>,

    /// Cached license payload for the currently open app; None when no license block or unlicensed.
    license_info: Mutex<Option<LicensePayload>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            files: Arc::new(Mutex::new(HashMap::new())),
            state_db: Mutex::new(None),
            data_db: Mutex::new(None),
            app_id: Mutex::new(String::new()),
            uix_path: Mutex::new(String::new()),
            state_db_path: Mutex::new(None),
            data_db_path: Mutex::new(None),
            initial_path: Mutex::new(None),
            app_name: Mutex::new(String::new()),
            permissions: Mutex::new(Vec::new()),
            state_mode: Mutex::new("file".to_string()),
            stored_schema_version: Arc::new(Mutex::new(1)),
            content_security_policy: Arc::new(Mutex::new(csp_for_network(false).to_string())),
            sync_endpoint: Mutex::new(None),
            sync_secret: Mutex::new(None),
            pending_files: Mutex::new(None),
            pending_manifest: Mutex::new(None),
            pending_path: Mutex::new(None),
            temp_web_root_path: Mutex::new(None),
            license_info: Mutex::new(None),
        }
    }
}

// ---------------------------------------------------------------------------
// Load result — returned by load/probe commands
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum LoadResult {
    /// App loaded successfully; caller receives the serialised manifest JSON.
    Loaded { manifest: String, path: String },
    /// App requires a PIN; caller must show a PIN dialog and call unlock_with_pin.
    PinRequired { app_name: String, app_id: String },
    /// App requires a .uixlicense; caller must prompt the user to install one then retry.
    LicenseRequired { app_name: String, app_id: String, device_id: String, uix_path: String },
}

// ---------------------------------------------------------------------------
// Record type — mirrors the @dotuix/core `records` table schema
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
struct Record {
    id: String,
    #[serde(rename = "type")]
    r#type: String,
    body: String,
    created_at: i64,
    updated_at: i64,
}

/// Parsed payload section of a `.uixlicense` file.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
struct LicensePayload {
    #[serde(rename = "appId")]
    app_id: String,
    #[serde(rename = "issuedTo")]
    issued_to: String,
    #[serde(rename = "issuedAt")]
    issued_at: String,
    #[serde(rename = "expiresAt", default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
    #[serde(default)]
    features: Vec<String>,
    #[serde(rename = "maxDevices", default, skip_serializing_if = "Option::is_none")]
    max_devices: Option<u32>,
    #[serde(rename = "deviceId", default, skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
}

/// On-disk format of a `.uixlicense` file: payload object + detached Ed25519 signature.
#[derive(serde::Deserialize)]
struct LicenseFile {
    payload: LicensePayload,
    signature: String,
}

/// Public license info returned to bridge callers via `uix.license.get()`.
#[derive(serde::Serialize, Clone)]
struct LicenseInfo {
    #[serde(rename = "issuedTo")]
    issued_to: String,
    #[serde(rename = "issuedAt")]
    issued_at: String,
    #[serde(rename = "expiresAt")]
    expires_at: Option<String>,
    features: Vec<String>,
    valid: bool,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn desktop_observability_enabled() -> bool {
    std::env::var("DOTUIX_OBSERVABILITY")
        .map(|v| v.to_lowercase() != "false")
        .unwrap_or(true)
}

fn emit_desktop_event(
    code: &str,
    severity: &str,
    app_id: Option<&str>,
    reason: Option<&str>,
    metadata: Option<serde_json::Value>,
) {
    if !desktop_observability_enabled() {
        return;
    }

    let mut payload = serde_json::Map::new();
    payload.insert("schemaVersion".to_string(), serde_json::json!(1));
    payload.insert("component".to_string(), serde_json::json!("desktop-viewer"));
    payload.insert("ts".to_string(), serde_json::json!(now_ms()));
    payload.insert("code".to_string(), serde_json::json!(code));
    payload.insert("severity".to_string(), serde_json::json!(severity));

    if let Some(value) = app_id {
        if !value.is_empty() {
            payload.insert("appId".to_string(), serde_json::json!(value));
        }
    }

    if let Some(value) = reason {
        if !value.is_empty() {
            payload.insert("reason".to_string(), serde_json::json!(value));
        }
    }

    if let Some(value) = metadata {
        payload.insert("metadata".to_string(), value);
    }

    let line = format!("[dotuix-obs] {}", serde_json::Value::Object(payload));

    match severity {
        "error" => eprintln!("{line}"),
        "warn" => eprintln!("{line}"),
        _ => println!("{line}"),
    }
}

/// Returns true if a process with the given PID is currently running.
/// On Unix we send signal 0 (no-op) — succeeds iff the process exists.
/// On Windows we open a handle with SYNCHRONIZE rights.
fn pid_is_running(pid: u32) -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        const SYNCHRONIZE: u32 = 0x00100000;
        let handle = unsafe { windows_sys::Win32::System::Threading::OpenProcess(SYNCHRONIZE, 0, pid) };
        if handle == std::ptr::null_mut() { return false; }
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
        true
    }
    #[cfg(not(any(unix, windows)))]
    { let _ = pid; false }
}

/// Parse the PID from a lock file written by this app: {"pid":12345,...}
fn lock_file_pid(lock_path: &str) -> Option<u32> {
    std::fs::read_to_string(lock_path).ok()
        .and_then(|s| s.split("\"pid\":").nth(1).map(str::to_string))
        .and_then(|s| s.split([',', '}']).next().map(str::to_string))
        .and_then(|s| s.trim().parse::<u32>().ok())
}

fn canonical_uix_path(path: &str) -> String {
    std::fs::canonicalize(path)
        .ok()
        .and_then(|p| p.to_str().map(|s| s.to_string()))
        .unwrap_or_else(|| path.to_string())
}

fn running_lock_owner(path: &str) -> Option<u32> {
    let lock_path = format!("{path}.lock");
    match lock_file_pid(&lock_path) {
        Some(pid) if pid_is_running(pid) => Some(pid),
        Some(_) => {
            // Remove stale lock files left by crashed/force-closed processes.
            let _ = std::fs::remove_file(&lock_path);
            None
        }
        None => None,
    }
}

#[cfg(target_os = "macos")]
fn focus_process_by_pid(pid: u32) -> bool {
    let script = format!(
        "tell application \"System Events\" to set frontmost of (first process whose unix id is {pid}) to true"
    );
    std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn focus_process_by_pid(_pid: u32) -> bool {
    false
}

fn gen_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ---------------------------------------------------------------------------
// MIME
// ---------------------------------------------------------------------------

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs"   => "application/javascript",
        "css"           => "text/css",
        "json"          => "application/json",
        "png"           => "image/png",
        "jpg" | "jpeg"  => "image/jpeg",
        "gif"           => "image/gif",
        "svg"           => "image/svg+xml",
        "wasm"          => "application/wasm",
        "ico"           => "image/x-icon",
        "woff2"         => "font/woff2",
        "woff"          => "font/woff",
        _               => "application/octet-stream",
    }
}

fn protocol_path_candidates(path: &str) -> Vec<String> {
    let mut candidates = Vec::with_capacity(6);
    let mut push_unique = |value: String| {
        if !value.is_empty() && !candidates.iter().any(|existing| existing == &value) {
            candidates.push(value);
        }
    };

    push_unique(path.to_string());
    push_unique(path.trim_start_matches("./").trim_start_matches(".\\").to_string());

    let slash = path.replace('\\', "/");
    push_unique(slash.clone());
    push_unique(slash.trim_start_matches("./").to_string());

    let backslash = slash.replace('/', "\\");
    push_unique(backslash.clone());
    push_unique(backslash.trim_start_matches(".\\").to_string());

    candidates
}

fn protocol_get_file<'a>(
    files: &'a HashMap<String, Vec<u8>>,
    requested_path: &str,
) -> Option<&'a Vec<u8>> {
    for candidate in protocol_path_candidates(requested_path) {
        if let Some(data) = files.get(&candidate) {
            return Some(data);
        }
    }
    None
}

fn decode_hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (
                decode_hex_nibble(bytes[i + 1]),
                decode_hex_nibble(bytes[i + 2]),
            ) {
                output.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }

        output.push(bytes[i]);
        i += 1;
    }

    String::from_utf8_lossy(&output).into_owned()
}

fn normalize_protocol_request_path(raw_path: &str) -> String {
    let decoded_path = percent_decode_path(raw_path.trim_start_matches('/'));
    let path = decoded_path
        .trim_start_matches("./")
        .trim_start_matches(".\\");

    if path.is_empty() {
        "index.html".to_string()
    } else {
        path.to_string()
    }
}

fn archive_relative_path(raw: &str) -> Option<std::path::PathBuf> {
    let normalized = raw.replace('\\', "/");
    let trimmed = normalized
        .trim_start_matches("./")
        .trim_start_matches('/');

    if trimmed.is_empty() {
        return None;
    }

    let mut out = std::path::PathBuf::new();
    for component in std::path::Path::new(trimmed).components() {
        match component {
            Component::Normal(segment) => out.push(segment),
            Component::CurDir => {}
            Component::ParentDir
            | Component::Prefix(_)
            | Component::RootDir => return None,
        }
    }

    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn html_with_injected_bridge(
    html_bytes: &[u8],
    manifest_json: &str,
    stored_schema_version: u32,
) -> Vec<u8> {
    let script = format!(
        "{}{}",
        diagnostics_script(),
        bridge_script(manifest_json, stored_schema_version)
    );
    let html = String::from_utf8_lossy(html_bytes);

    if html.contains("<head>") {
        html.replacen("<head>", &format!("<head>{script}"), 1)
            .into_bytes()
    } else {
        let mut out = script.into_bytes();
        out.extend_from_slice(html_bytes);
        out
    }
}

fn script_tag_to_source(script_tag: &str) -> String {
    script_tag
        .strip_prefix("<script>")
        .and_then(|body| body.strip_suffix("</script>"))
        .unwrap_or(script_tag)
        .to_string()
}

fn fallback_bridge_script_source(manifest_json: &str, stored_schema_version: u32) -> String {
    let mut out = String::new();
    out.push_str(&script_tag_to_source(diagnostics_script()));
    out.push('\n');
    out.push_str(&script_tag_to_source(&bridge_script(
        manifest_json,
        stored_schema_version,
    )));
    out
}

fn html_with_external_bridge_loader(html_bytes: &[u8], bridge_file_name: &str) -> Vec<u8> {
    let script_tag = format!(r#"<script src="./{bridge_file_name}"></script>"#);
    let html = String::from_utf8_lossy(html_bytes);

    if html.contains("<head>") {
        html.replacen("<head>", &format!("<head>{script_tag}"), 1)
            .into_bytes()
    } else {
        let mut out = script_tag.into_bytes();
        out.extend_from_slice(html_bytes);
        out
    }
}

fn network_allowed(manifest: &serde_json::Value) -> bool {
    manifest.get("network").and_then(|v| v.as_str()) == Some("allowed")
}

fn csp_for_network(allowed: bool) -> &'static str {
    if allowed {
        "default-src 'self' uix: data: blob: https:; \
         script-src 'self' 'unsafe-inline' uix: https:; \
         style-src 'self' 'unsafe-inline' uix: https:; \
         img-src 'self' uix: data: blob: https:; \
         font-src 'self' uix: data: https:; \
         media-src 'self' uix: data: blob: https:; \
         connect-src 'self' uix: https: wss:; \
         worker-src 'self' uix: blob: https:; \
         frame-src 'self' uix: https:; \
         object-src 'none'; \
         base-uri 'none'; \
         form-action 'none'"
    } else {
        "default-src 'self' uix: data: blob:; \
         script-src 'self' 'unsafe-inline' uix:; \
         style-src 'self' 'unsafe-inline' uix:; \
         img-src 'self' uix: data: blob:; \
         font-src 'self' uix: data:; \
         media-src 'self' uix: data: blob:; \
         connect-src 'self' uix:; \
         worker-src 'self' uix: blob:; \
         frame-src 'self' uix:; \
         object-src 'none'; \
         base-uri 'none'; \
         form-action 'none'"
    }
}

fn csp_for_manifest(manifest: &serde_json::Value) -> &'static str {
    csp_for_network(network_allowed(manifest))
}

// ---------------------------------------------------------------------------
// .uix loading helpers
// ---------------------------------------------------------------------------

fn read_uix(path: &str) -> Result<HashMap<String, Vec<u8>>, String> {
    let data = std::fs::read(path).map_err(|e| format!("Cannot read file: {e}"))?;
    let cursor = Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid ZIP: {e}"))?;
    let mut files = HashMap::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        if entry.is_dir() { continue; }
        let name = entry.name().to_string();
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        files.insert(name, buf);
    }
    Ok(files)
}

fn clear_temp_web_root(state: &AppState) {
    if let Some(path) = state.temp_web_root_path.lock().unwrap().take() {
        let _ = std::fs::remove_dir_all(path);
    }
}

fn clear_temp_data_db(state: &AppState) {
    if let Some(path) = state.data_db_path.lock().unwrap().take() {
        let _ = std::fs::remove_file(path);
    }
}

fn ensure_state_schema(conn: &rusqlite::Connection, app_id: &str) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS records (
            id          TEXT    PRIMARY KEY,
            type        TEXT    NOT NULL,
            body        TEXT    NOT NULL DEFAULT '{}',
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS records_type_idx ON records(type);
        CREATE INDEX IF NOT EXISTS records_created_at_idx ON records(created_at);
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT
        );",
    )
    .map_err(|e| e.to_string())?;

    // Enable WAL for better read concurrency; incremental auto-vacuum so freed
    // pages can be reclaimed via PRAGMA incremental_vacuum without a full VACUUM.
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA auto_vacuum = INCREMENTAL;")
        .map_err(|e| e.to_string())?;

    // Populate meta once; INSERT OR IGNORE is a no-op on subsequent opens.
    conn.execute_batch(&format!(
        "INSERT OR IGNORE INTO meta VALUES ('schema_version', '1');
         INSERT OR IGNORE INTO meta VALUES ('uix_version',    '1.0');
         INSERT OR IGNORE INTO meta VALUES ('app_id',         '{}');",
        app_id.replace('\'', "''")
    ))
    .map_err(|e| e.to_string())?;

    // Ensure a stable per-device UUID exists (generated once on first open, never changed).
    let has_device: bool = conn
        .query_row("SELECT COUNT(*) FROM meta WHERE key = 'device_id'", [], |r| r.get::<_, i64>(0))
        .map(|n| n > 0)
        .unwrap_or(false);
    if !has_device {
        let id = uuid::Uuid::new_v4().to_string();
        conn.execute("INSERT INTO meta (key, value) VALUES ('device_id', ?1)", [&id])
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Compare semver strings: returns true if v1 >= v2.
fn version_gte(v1: &str, v2: &str) -> bool {
    let parse = |v: &str| -> (u32, u32, u32) {
        let mut p = v.splitn(3, '.').map(|s| s.parse::<u32>().unwrap_or(0));
        (p.next().unwrap_or(0), p.next().unwrap_or(0), p.next().unwrap_or(0))
    };
    parse(v1) >= parse(v2)
}

/// Compute today as an ISO YYYY-MM-DD string (no external crate needed).
fn today_iso() -> String {
    let mut remaining = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut year = 1970u32;
    loop {
        let days = if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) { 366u64 } else { 365 };
        let secs = days * 86400;
        if remaining < secs { break; }
        remaining -= secs;
        year += 1;
    }

    let is_leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let dim: [u32; 13] = [0, 31, if is_leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1u32;
    let mut day = (remaining / 86400) as u32;
    for m in 1..=12u32 {
        if day < dim[m as usize] { month = m; break; }
        day -= dim[m as usize];
    }
    format!("{:04}-{:02}-{:02}", year, month, day + 1)
}

/// Parse a human-readable duration ("30d", "12h", "1y") into seconds.
fn parse_duration(s: &str) -> Result<u64, String> {
    if s.len() < 2 {
        return Err(format!("Invalid duration: '{s}'. Use e.g. 30d, 12h, 1y."));
    }
    let (num_str, unit) = s.split_at(s.len() - 1);
    let n: u64 = num_str.parse().map_err(|_| format!("Invalid duration number: '{num_str}'"))?;
    match unit {
        "s" => Ok(n),
        "m" => Ok(n * 60),
        "h" => Ok(n * 3_600),
        "d" => Ok(n * 86_400),
        "y" => Ok(n * 86_400 * 365),
        _   => Err(format!("Unknown duration unit '{unit}'. Use s, m, h, d, or y.")),
    }
}

// ---------------------------------------------------------------------------
// Crypto helpers — signature verification and AES-256-GCM decryption
// ---------------------------------------------------------------------------

/// Recursively sort JSON object keys (needed for canonical signature payload).
fn sort_json_keys(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut sorted = serde_json::Map::new();
            let mut keys: Vec<String> = map.keys().cloned().collect();
            keys.sort();
            for k in keys {
                sorted.insert(k.clone(), sort_json_keys(map[&k].clone()));
            }
            serde_json::Value::Object(sorted)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(sort_json_keys).collect())
        }
        other => other,
    }
}

/// SHA-256 of `data` returned as lowercase hex.
fn sha256_hex(data: &[u8]) -> String {
    use sha2::Digest;
    let hash = sha2::Sha256::digest(data);
    hash.iter().map(|b| format!("{b:02x}")).collect()
}

/// Format a UNIX timestamp (seconds since epoch) as an ISO-8601 UTC string.
/// Uses the civil_from_days algorithm — Howard Hinnant (date_algorithms.html).
fn format_iso8601(secs: u64) -> String {
    let sec = (secs % 60) as i64;
    let min = ((secs / 60) % 60) as i64;
    let hour = ((secs / 3600) % 24) as i64;
    let z = (secs / 86400) as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = y + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{hour:02}:{min:02}:{sec:02}Z")
}

/// Decode a base64url (no-padding) string to bytes.
fn base64_url_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|e| format!("base64url decode error: {e}"))
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
struct SyncWireRecord {
    id: String,
    #[serde(rename = "type")]
    r#type: String,
    body: String,
    created_at: i64,
    updated_at: i64,
    deleted: bool,
}

fn normalize_epoch_ms(value: i64) -> i64 {
    if value <= 0 { return 0; }
    if value < 1_000_000_000_000 { value * 1000 } else { value }
}

fn normalize_sync_record(mut r: SyncWireRecord) -> SyncWireRecord {
    r.created_at = normalize_epoch_ms(r.created_at);
    r.updated_at = normalize_epoch_ms(r.updated_at);
    r
}

fn normalize_and_sort_sync_records(records: Vec<SyncWireRecord>) -> Vec<SyncWireRecord> {
    let mut out: Vec<SyncWireRecord> = records
        .into_iter()
        .map(normalize_sync_record)
        .collect();

    out.sort_by(|a, b| a.id.cmp(&b.id).then(a.updated_at.cmp(&b.updated_at)));
    out
}

fn decode_sync_secret(secret: &str) -> Result<Vec<u8>, String> {
    if let Ok(bytes) = base64_url_decode(secret) {
        if !bytes.is_empty() { return Ok(bytes); }
    }

    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(secret)
        .map_err(|e| format!("sync.secret decode error: {e}"))
}

fn sync_last_sync_meta_key(app_id: &str, endpoint: &str) -> String {
    let endpoint_hash = sha256_hex(endpoint.trim().as_bytes());
    format!("last_sync::{app_id}::{endpoint_hash}")
}

fn sync_records_hash(records: &[SyncWireRecord]) -> Result<String, String> {
    let json = serde_json::to_string(records).map_err(|e| e.to_string())?;
    Ok(sha256_hex(json.as_bytes()))
}

fn sync_request_string_to_sign(
    app_id: &str,
    device_id: &str,
    sent_at: i64,
    last_sync: i64,
    nonce: &str,
    push: &[SyncWireRecord],
) -> Result<String, String> {
    let push_hash = sync_records_hash(push)?;
    Ok(format!(
        "dotuix-sync-v2\n{app_id}\n{device_id}\n{}\n{}\n{nonce}\n{push_hash}",
        normalize_epoch_ms(sent_at),
        normalize_epoch_ms(last_sync),
    ))
}

fn sync_response_string_to_sign(
    app_id: &str,
    device_id: &str,
    server_time: i64,
    pushed: i64,
    nonce: &str,
    pull: &[SyncWireRecord],
) -> Result<String, String> {
    let pull_hash = sync_records_hash(pull)?;
    Ok(format!(
        "dotuix-sync-v2-response\n{app_id}\n{device_id}\n{}\n{pushed}\n{nonce}\n{pull_hash}",
        normalize_epoch_ms(server_time),
    ))
}

fn hmac_sha256_base64url(secret: &[u8], payload: &str) -> Result<String, String> {
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    type HmacSha256 = Hmac<Sha256>;

    let mut mac = HmacSha256::new_from_slice(secret)
        .map_err(|e| format!("Cannot initialise HMAC signer: {e}"))?;
    mac.update(payload.as_bytes());
    let out = mac.finalize().into_bytes();

    use base64::Engine;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(out))
}

const SYNC_DISCOVERY_DEFAULT_PORT: u16 = 3131;
const SYNC_DISCOVERY_TIMEOUT_MS: u64 = 220;
const SYNC_DISCOVERY_CONCURRENCY: usize = 48;

fn sync_discovery_meta_key(app_id: &str) -> String {
    format!("auto_sync_endpoint::{app_id}")
}

fn normalize_sync_base_url(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }

    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return None;
    }

    Some(trimmed.strip_suffix("/sync").unwrap_or(trimmed).to_string())
}

fn endpoint_from_sync_base(base: &str) -> String {
    format!("{}/sync", base.trim_end_matches('/'))
}

fn normalize_sync_endpoint(value: &str) -> Option<String> {
    normalize_sync_base_url(value).map(|base| endpoint_from_sync_base(&base))
}

fn read_auto_discovery_endpoint(state: &AppState, app_id: &str) -> Option<String> {
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref()?;
    let key = sync_discovery_meta_key(app_id);

    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
}

fn upsert_auto_discovery_endpoint(state: &AppState, app_id: &str, endpoint: &str) {
    let db = state.state_db.lock().unwrap();
    let Some(conn) = db.as_ref() else {
        return;
    };

    let key = sync_discovery_meta_key(app_id);
    let _ = conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, endpoint],
    );
}

fn push_sync_candidate(candidates: &mut Vec<String>, seen: &mut HashSet<String>, raw: &str) {
    if let Some(base) = normalize_sync_base_url(raw) {
        if seen.insert(base.clone()) {
            candidates.push(base);
        }
    }
}

fn build_sync_discovery_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::<String>::new();

    if let Ok(value) = std::env::var("DOTUIX_SYNC_ENDPOINT") {
        push_sync_candidate(&mut candidates, &mut seen, &value);
    }

    push_sync_candidate(
        &mut candidates,
        &mut seen,
        &format!("http://127.0.0.1:{SYNC_DISCOVERY_DEFAULT_PORT}"),
    );
    push_sync_candidate(
        &mut candidates,
        &mut seen,
        &format!("http://sync-hub.local:{SYNC_DISCOVERY_DEFAULT_PORT}"),
    );
    push_sync_candidate(
        &mut candidates,
        &mut seen,
        &format!("http://dotuix-sync.local:{SYNC_DISCOVERY_DEFAULT_PORT}"),
    );

    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        let mut seen_subnets = HashSet::<(u8, u8, u8)>::new();

        for interface in interfaces {
            if interface.is_loopback() {
                continue;
            }

            let IpAddr::V4(v4) = interface.ip() else {
                continue;
            };

            let octets = v4.octets();
            let subnet = (octets[0], octets[1], octets[2]);
            if !seen_subnets.insert(subnet) {
                continue;
            }

            for host in 1u16..=254 {
                let host_octet = host as u8;
                if host_octet == octets[3] {
                    continue;
                }

                push_sync_candidate(
                    &mut candidates,
                    &mut seen,
                    &format!(
                        "http://{}.{}.{}.{}:{}",
                        subnet.0,
                        subnet.1,
                        subnet.2,
                        host_octet,
                        SYNC_DISCOVERY_DEFAULT_PORT
                    ),
                );
            }
        }
    }

    candidates
}

async fn probe_sync_hub(base: &str, client: &reqwest::Client) -> bool {
    let well_known_url = format!("{base}/.well-known/dotuix-sync");
    if let Ok(response) = client.get(&well_known_url).send().await {
        if response.status().is_success() {
            if let Ok(payload) = response.json::<serde_json::Value>().await {
                if payload
                    .get("service")
                    .and_then(|v| v.as_str())
                    .map(|v| v == "dotuix-sync-hub")
                    .unwrap_or(false)
                {
                    return true;
                }
            }
        }
    }

    let health_url = format!("{base}/health");
    if let Ok(response) = client.get(&health_url).send().await {
        if response.status().is_success() {
            if let Ok(payload) = response.json::<serde_json::Value>().await {
                return payload
                    .get("ok")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
            }
        }
    }

    false
}

async fn discover_sync_base_url_with_client(client: &reqwest::Client) -> Option<String> {
    let candidates = build_sync_discovery_candidates();
    if candidates.is_empty() {
        return None;
    }

    let mut probes = stream::iter(candidates.into_iter().map(|base| {
        let client = client.clone();
        async move {
            if probe_sync_hub(&base, &client).await {
                Some(base)
            } else {
                None
            }
        }
    }))
    .buffer_unordered(SYNC_DISCOVERY_CONCURRENCY);

    while let Some(found) = probes.next().await {
        if let Some(base) = found {
            return Some(base);
        }
    }

    None
}

async fn resolve_sync_endpoint(
    state: &AppState,
    app_id: &str,
    configured_endpoint: Option<String>,
) -> Result<String, String> {
    if let Some(endpoint) = configured_endpoint
        .as_deref()
        .and_then(normalize_sync_endpoint)
    {
        return Ok(endpoint);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(SYNC_DISCOVERY_TIMEOUT_MS))
        .build()
        .map_err(|e| format!("Cannot build Sync Hub discovery client: {e}"))?;

    if let Some(cached) = read_auto_discovery_endpoint(state, app_id).and_then(|v| normalize_sync_endpoint(&v)) {
        if let Some(cached_base) = normalize_sync_base_url(&cached) {
            if probe_sync_hub(&cached_base, &client).await {
                return Ok(cached);
            }
        }
    }

    if let Some(base) = discover_sync_base_url_with_client(&client).await {
        let endpoint = endpoint_from_sync_base(&base);
        *state.sync_endpoint.lock().unwrap() = Some(endpoint.clone());
        upsert_auto_discovery_endpoint(state, app_id, &endpoint);

        emit_desktop_event(
            "desktop.sync.endpoint_auto_discovered",
            "info",
            Some(app_id),
            None,
            Some(serde_json::json!({
                "endpoint": endpoint,
            })),
        );

        return Ok(endpoint);
    }

    Err(
        "Sync not configured: 'sync.endpoint' is missing and no Sync Hub (sync-desktop) host was discovered on this LAN. Start Sync Hub and keep port 3131 reachable, or set manifest.sync.endpoint."
            .to_string(),
    )
}

fn ensure_sync_clock_ms(conn: &rusqlite::Connection) -> Result<(), String> {
    let clock_version: String = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'sync_clock_version'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or_default();

    if clock_version == "ms-v2" {
        return Ok(());
    }

    conn.execute(
        "UPDATE records SET created_at = created_at * 1000 \
         WHERE created_at > 0 AND created_at < 1000000000000",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE records SET updated_at = updated_at * 1000 \
         WHERE updated_at > 0 AND updated_at < 1000000000000",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE meta SET value = CAST(CAST(value AS INTEGER) * 1000 AS TEXT) \
         WHERE key LIKE 'last_sync%' \
           AND CAST(value AS INTEGER) > 0 \
           AND CAST(value AS INTEGER) < 1000000000000",
        [],
    )
    .map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO meta (key, value) VALUES ('sync_clock_version', 'ms-v2') \
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Verify the `signature` block of a manifest against the archive files.
/// Returns `Ok(())` when absent (unsigned) or when the signature is valid.
/// Returns `Err(msg)` when the signature is present but invalid.
fn verify_signature(files: &HashMap<String, Vec<u8>>, manifest: &serde_json::Value) -> Result<(), String> {
    let sig_obj = match manifest.get("signature") {
        Some(v) if !v.is_null() => v,
        _ => return Ok(()), // unsigned — allowed
    };

    let algorithm = sig_obj.get("algorithm").and_then(|v| v.as_str()).unwrap_or("");
    if algorithm != "Ed25519" {
        return Err(format!("Unsupported signature algorithm: '{algorithm}'"));
    }

    let pub_key_b64 = sig_obj.get("publicKey").and_then(|v| v.as_str())
        .ok_or("signature.publicKey missing")?;
    let sig_val_b64 = sig_obj.get("value").and_then(|v| v.as_str())
        .ok_or("signature.value missing")?;

    let pub_key_bytes = base64_url_decode(pub_key_b64)
        .map_err(|e| format!("signature.publicKey: {e}"))?;
    let sig_bytes = base64_url_decode(sig_val_b64)
        .map_err(|e| format!("signature.value: {e}"))?;

    // Rebuild the canonical payload — must match @dotuix/core sign.ts exactly.
    let mut manifest_clone = manifest.clone();
    if let Some(obj) = manifest_clone.as_object_mut() { obj.remove("signature"); }
    let sorted_manifest = sort_json_keys(manifest_clone);
    let manifest_canon = serde_json::to_string(&sorted_manifest).map_err(|e| e.to_string())?;

    let mut paths: Vec<&str> = files.keys()
        .filter(|p| *p != "manifest.json" && *p != "state.db")
        .map(String::as_str)
        .collect();
    paths.sort_unstable();

    // Must match @dotuix/core sign.ts byte-for-byte: lines joined with "\n",
    // with NO trailing newline (core uses `lines.join("\n")`). A trailing
    // newline here makes desktop reject every CLI/core-signed file.
    let mut lines: Vec<String> = vec![
        "DOTUIX-SIGN-V1".to_string(),
        format!("manifest:{manifest_canon}"),
    ];
    for p in &paths {
        lines.push(format!("file:{p}:{}", sha256_hex(&files[*p])));
    }
    let payload = lines.join("\n");

    use ed25519_dalek::{Signature, VerifyingKey, Verifier};
    let key_arr: [u8; 32] = pub_key_bytes.try_into()
        .map_err(|_| "signature.publicKey must be 32 bytes".to_string())?;
    let sig_arr: [u8; 64] = sig_bytes.try_into()
        .map_err(|_| "signature.value must be 64 bytes".to_string())?;
    let vk = VerifyingKey::from_bytes(&key_arr)
        .map_err(|e| format!("Invalid Ed25519 public key: {e}"))?;

    vk.verify(payload.as_bytes(), &Signature::from_bytes(&sig_arr))
        .map_err(|_| "Signature verification failed — file may have been tampered with.".to_string())
}

/// Derive a 32-byte AES-256 key from a PIN using PBKDF2-HMAC-SHA256.
fn derive_aes_key(pin: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    use pbkdf2::pbkdf2_hmac;
    let mut key = [0u8; 32];
    pbkdf2_hmac::<sha2::Sha256>(pin.as_bytes(), salt, iterations, &mut key);
    key
}

/// Decrypt a single file encrypted with AES-256-GCM.
/// Expected layout: `[12-byte nonce][ciphertext][16-byte GCM auth tag]`
fn decrypt_aes_gcm(data: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if data.len() < 29 {
        return Err("Encrypted file is too short".into());
    }
    let (nonce_bytes, ct_with_tag) = data.split_at(12);
    use aes_gcm::{Aes256Gcm, Key, Nonce, aead::{Aead, KeyInit}};
    let k = Key::<Aes256Gcm>::from_slice(key);
    let cipher = Aes256Gcm::new(k);
    cipher
        .decrypt(Nonce::from_slice(nonce_bytes), ct_with_tag)
        .map_err(|_| "Decryption failed — wrong PIN or corrupted file.".to_string())
}

/// Read the stored open count for an app-id data directory.
fn read_open_count(data_dir: &std::path::Path) -> u64 {
    std::fs::read_to_string(data_dir.join("opens"))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// Increment and persist the open count; returns the new value.
fn increment_open_count(data_dir: &std::path::Path) -> u64 {
    let n = read_open_count(data_dir) + 1;
    let _ = std::fs::write(data_dir.join("opens"), n.to_string());
    n
}

// ---------------------------------------------------------------------------
// License helpers
// ---------------------------------------------------------------------------

/// Get or create a stable per-device UUID stored at `$APP_DATA/device_id`.
fn ensure_global_device_id(app: &AppHandle) -> String {
    let Ok(base) = app.path().app_data_dir() else {
        return uuid::Uuid::new_v4().to_string();
    };
    let id_file = base.join("device_id");
    if let Ok(id) = std::fs::read_to_string(&id_file) {
        let trimmed = id.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    let new_id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(&base);
    let _ = std::fs::write(&id_file, &new_id);
    new_id
}

/// Attempt to load and verify the `.uixlicense` file stored in `app_data_dir`.
/// Returns `Some(payload)` only when the file exists, the signature is valid,
/// the appId matches, the license has not expired, and (if device-bound) the
/// device ID matches.  All failures return `None` without leaking details.
fn verify_and_load_license(
    app_data_dir: &std::path::Path,
    app_id: &str,
    publisher_key_str: &str,
    device_id: &str,
) -> Option<LicensePayload> {
    let data = std::fs::read_to_string(app_data_dir.join("license.uixlicense")).ok()?;
    let lf: LicenseFile = serde_json::from_str(&data).ok()?;

    // AppId must match the manifest
    if lf.payload.app_id != app_id { return None; }

    // Expiry — treat missing expiresAt as perpetual
    if let Some(ref exp) = lf.payload.expires_at {
        if exp.as_str() < today_iso().as_str() { return None; }
    }

    // Device binding — if deviceId is set (non-empty) it must match this device
    if let Some(ref lic_device) = lf.payload.device_id {
        if !lic_device.is_empty() && lic_device != device_id { return None; }
    }

    // Signature verification over sorted canonical JSON of the payload
    let key_b64 = publisher_key_str.strip_prefix("ed25519:").unwrap_or(publisher_key_str);
    let key_bytes = base64_url_decode(key_b64).ok()?;
    let sig_bytes = base64_url_decode(&lf.signature).ok()?;

    let payload_val = serde_json::to_value(&lf.payload).ok()?;
    let sorted = sort_json_keys(payload_val);
    let payload_canon = serde_json::to_string(&sorted).ok()?;
    let msg = format!("DOTUIX-LICENSE-V1\n{payload_canon}");

    use ed25519_dalek::{Signature, VerifyingKey, Verifier};
    let key_arr: [u8; 32] = key_bytes.try_into().ok()?;
    let sig_arr: [u8; 64] = sig_bytes.try_into().ok()?;
    let vk = VerifyingKey::from_bytes(&key_arr).ok()?;
    vk.verify(msg.as_bytes(), &Signature::from_bytes(&sig_arr)).ok()?;

    Some(lf.payload)
}

// ---------------------------------------------------------------------------
// .uix loading — two-phase: probe (validate + optional PIN gate) + complete
// ---------------------------------------------------------------------------

/// Phase 1: read the archive, run all validation checks, verify signature.
/// If the manifest requires a PIN, save the raw files to `AppState.pending_*`
/// and return `LoadResult::PinRequired`. Otherwise call `complete_load`.
fn probe_uix_inner(path: &str, app: &AppHandle, state: &AppState) -> Result<LoadResult, String> {
    let files = read_uix(path)?;

    let manifest_bytes = files
        .get("manifest.json")
        .ok_or_else(|| "manifest.json not found in archive".to_string())?;
    let manifest_json = String::from_utf8_lossy(manifest_bytes).into_owned();
    let manifest: serde_json::Value = serde_json::from_str(&manifest_json)
        .map_err(|e| format!("Invalid manifest.json: {e}"))?;
    let observed_app_id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    // --- Expiry check ---
    if let Some(exp) = manifest.get("expires").and_then(|v| v.as_str()) {
        if exp < today_iso().as_str() {
            emit_desktop_event(
                "desktop.trust_gate.blocked",
                "warn",
                Some(observed_app_id.as_str()),
                Some("expired"),
                Some(serde_json::json!({ "expires": exp })),
            );
            return Err(format!("This .uix file expired on {exp}. It can no longer be opened."));
        }
    }

    // --- minViewer check ---
    if let Some(min_ver) = manifest.get("minViewer").and_then(|v| v.as_str()) {
        if !version_gte(VIEWER_VERSION, min_ver) {
            emit_desktop_event(
                "desktop.trust_gate.blocked",
                "warn",
                Some(observed_app_id.as_str()),
                Some("min_viewer"),
                Some(serde_json::json!({
                    "minViewer": min_ver,
                    "viewerVersion": VIEWER_VERSION,
                })),
            );
            return Err(format!(
                "This file requires viewer v{min_ver} or later. Current viewer: v{VIEWER_VERSION}."
            ));
        }
    }

    // --- Signature verification ---
    if let Err(error) = verify_signature(&files, &manifest) {
        emit_desktop_event(
            "desktop.trust_gate.blocked",
            "warn",
            Some(observed_app_id.as_str()),
            Some("signature_invalid"),
            Some(serde_json::json!({ "error": error })),
        );
        return Err(error);
    }

    // --- maxOpens check ---
    let app_id = manifest["id"].as_str().unwrap_or("unknown").to_string();
    let app_name = manifest.get("name").and_then(|v| v.as_str()).unwrap_or(&app_id).to_string();

    if let Some(max_opens) = manifest
        .get("security").and_then(|s| s.get("maxOpens")).and_then(|v| v.as_u64())
    {
        let data_dir = app
            .path().app_data_dir()
            .map_err(|e| format!("Cannot get app data dir: {e}"))?.join(&app_id);
        let _ = std::fs::create_dir_all(&data_dir);
        if read_open_count(&data_dir) >= max_opens {
            emit_desktop_event(
                "desktop.trust_gate.blocked",
                "warn",
                Some(observed_app_id.as_str()),
                Some("max_opens_reached"),
                Some(serde_json::json!({ "maxOpens": max_opens })),
            );
            return Err(format!(
                "This .uix file has reached its maximum number of opens ({max_opens})."
            ));
        }
    }

    // --- PIN gate ---
    let security = manifest.get("security");
    let requires_pin = security
        .and_then(|s| s.get("auth")).and_then(|v| v.as_str()) == Some("pin");
    let has_encrypted_paths = security
        .and_then(|s| s.get("encryptedPaths")).and_then(|v| v.as_array())
        .map(|a| !a.is_empty()).unwrap_or(false);

    if requires_pin && has_encrypted_paths {
        *state.pending_files.lock().unwrap() = Some(files);
        *state.pending_manifest.lock().unwrap() = Some(manifest);
        *state.pending_path.lock().unwrap() = Some(path.to_string());
        emit_desktop_event(
            "desktop.trust_gate.blocked",
            "warn",
            Some(observed_app_id.as_str()),
            Some("pin_required"),
            None,
        );
        return Ok(LoadResult::PinRequired { app_name, app_id });
    }

    complete_load(path, files, &manifest, app, state)
}

/// Phase 2: create the lock, set up databases, store everything in AppState.
fn complete_load(
    path: &str,
    files: HashMap<String, Vec<u8>>,
    manifest: &serde_json::Value,
    app: &AppHandle,
    state: &AppState,
) -> Result<LoadResult, String> {
    let manifest_json = serde_json::to_string(manifest).map_err(|e| e.to_string())?;
    let app_id = manifest["id"].as_str().unwrap_or("unknown").to_string();
    let app_name = manifest.get("name").and_then(|v| v.as_str()).unwrap_or(&app_id).to_string();

    let permissions: Vec<String> = manifest
        .get("permissions").and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();

    // --- Close any previously open file first ---
    {
        let prev_path = state.uix_path.lock().unwrap().clone();
        if !prev_path.is_empty() && prev_path != path {
            let prev_state_db_path = state.state_db_path.lock().unwrap().clone();
            let prev_mode = state.state_mode.lock().unwrap().clone();
            { let _ = state.state_db.lock().unwrap().take(); }
            { let _ = state.data_db.lock().unwrap().take(); }
            clear_temp_data_db(state);
            if prev_mode != "device" {
                if let Some(db_path) = prev_state_db_path {
                    if db_path.exists() { let _ = repack_uix(&prev_path, &db_path); }
                }
            }
            let _ = std::fs::remove_file(format!("{prev_path}.lock"));
        }
    }

    clear_temp_web_root(state);
    clear_temp_data_db(state);

    // --- Per-app data directory (created early — needed for license file lookup) ---
    let data_dir = app
        .path().app_data_dir()
        .map_err(|e| format!("Cannot get app data dir: {e}"))?.join(&app_id);
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    // --- License check (before lock + DB setup) ---
    let license_required = manifest
        .get("license").and_then(|l| l.get("required")).and_then(|v| v.as_bool())
        .unwrap_or(false);
    let publisher_key = manifest
        .get("license").and_then(|l| l.get("publisherKey")).and_then(|v| v.as_str())
        .map(str::to_string);
    let device_id = ensure_global_device_id(app);
    let license_payload: Option<LicensePayload> = publisher_key
        .as_deref()
        .and_then(|key| verify_and_load_license(&data_dir, &app_id, key, &device_id));
    if license_required && license_payload.is_none() {
        emit_desktop_event(
            "desktop.trust_gate.blocked",
            "warn",
            Some(app_id.as_str()),
            Some("license_required"),
            Some(serde_json::json!({
                "deviceId": device_id,
            })),
        );
        // Clear the stale uix_path so a subsequent open works cleanly.
        *state.uix_path.lock().unwrap() = String::new();
        return Ok(LoadResult::LicenseRequired {
            app_name,
            app_id,
            device_id,
            uix_path: path.to_string(),
        });
    }

    // --- Lock file ---
    let lock_path = format!("{path}.lock");
    if std::path::Path::new(&lock_path).exists() {
        let owner_running = lock_file_pid(&lock_path)
            .map(pid_is_running)
            .unwrap_or(false);
        if owner_running {
            return Err("This file is already open in another window.".into());
        }
        // Stale lock (crashed or force-quit) — remove and continue.
        let _ = std::fs::remove_file(&lock_path);
    }
    std::fs::write(&lock_path, format!("{{\"pid\":{},\"opened_at\":{}}}", std::process::id(), now_ms()).as_bytes())
        .map_err(|e| format!("Cannot create lock file: {e}"))?;

    // --- state.db ---
    let state_db_path = data_dir.join("state.db");
    let should_seed = manifest
        .get("state").and_then(|s| s.get("seed")).and_then(|v| v.as_bool()).unwrap_or(false);
    if !state_db_path.exists() && should_seed {
        if let Some(seed) = files.get("state.db") {
            std::fs::write(&state_db_path, seed).map_err(|e| e.to_string())?;
            // Save the original seed as a permanent backup (never overwritten).
            // state_reset() uses this to restore the app to its shipped state.
            let seed_backup = data_dir.join("state_seed.db");
            if !seed_backup.exists() {
                let _ = std::fs::write(&seed_backup, seed);
            }
        }
    }
    let state_conn = rusqlite::Connection::open(&state_db_path)
        .map_err(|e| format!("Cannot open state.db: {e}"))?;
    ensure_state_schema(&state_conn, &app_id)?;
    let stored_schema_version: u32 = state_conn
        .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get::<_, String>(0))
        .map(|s| s.parse::<u32>().unwrap_or(1))
        .unwrap_or(1);

    // --- data.db (read-only copy) ---
    let data_conn = if let Some(bytes) = files.get("data.db") {
        let safe_app_id: String = app_id
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
            .collect();
        let tmp = std::env::temp_dir().join(format!(
            "dotuix_{safe_app_id}_{}_{}_data.db",
            std::process::id(),
            now_ms()
        ));
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        *state.data_db_path.lock().unwrap() = Some(tmp.clone());
        Some(rusqlite::Connection::open_with_flags(&tmp, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("Cannot open data.db: {e}"))?)
    } else {
        *state.data_db_path.lock().unwrap() = None;
        None
    };

    // --- Increment opens counter ---
    increment_open_count(&data_dir);

    // --- Commit to AppState ---
    *state.files.lock().unwrap() = files;
    *state.state_db.lock().unwrap() = Some(state_conn);
    *state.data_db.lock().unwrap() = data_conn;
    *state.app_id.lock().unwrap() = app_id.clone();
    *state.app_name.lock().unwrap() = app_name;
    *state.uix_path.lock().unwrap() = path.to_string();
    *state.state_db_path.lock().unwrap() = Some(state_db_path);
    *state.permissions.lock().unwrap() = permissions;
    *state.state_mode.lock().unwrap() = manifest
        .get("state").and_then(|s| s.get("mode")).and_then(|v| v.as_str())
        .unwrap_or("file").to_string();
    *state.stored_schema_version.lock().unwrap() = stored_schema_version;
    *state.content_security_policy.lock().unwrap() = csp_for_manifest(manifest).to_string();
    *state.sync_endpoint.lock().unwrap() = manifest
        .get("sync").and_then(|s| s.get("endpoint")).and_then(|v| v.as_str())
        .map(str::to_string);
    *state.sync_secret.lock().unwrap() = manifest
        .get("sync").and_then(|s| s.get("secret")).and_then(|v| v.as_str())
        .map(str::to_string);
    *state.license_info.lock().unwrap() = license_payload;

    emit_desktop_event(
        "desktop.trust_gate.passed",
        "info",
        Some(app_id.as_str()),
        Some("load_completed"),
        Some(serde_json::json!({
            "signed": manifest.get("signature").is_some(),
            "networkAllowed": network_allowed(manifest),
        })),
    );

    Ok(LoadResult::Loaded {
        manifest: manifest_json,
        path: path.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Repack: write state.db back into the .uix file (atomic write)
//
// 1. Read original .uix → raw-copy every entry except state.db → add fresh state.db
// 2. Write to <path>.tmp
// 3. Rename original → <path>.bak (keep 1 rolling backup)
// 4. Rename .tmp → original  (OS-atomic on same filesystem)
// ---------------------------------------------------------------------------

fn repack_uix(uix_path: &str, state_db_path: &std::path::Path) -> Result<(), String> {
    let state_db_bytes = std::fs::read(state_db_path)
        .map_err(|e| format!("Cannot read state.db for repack: {e}"))?;

    let original = std::fs::read(uix_path)
        .map_err(|e| format!("Cannot read .uix for repack: {e}"))?;

    let tmp_path = format!("{uix_path}.tmp");
    let tmp_file = std::fs::File::create(&tmp_path)
        .map_err(|e| format!("Cannot create .tmp: {e}"))?;
    let mut writer = zip::ZipWriter::new(tmp_file);

    let mut archive = zip::ZipArchive::new(Cursor::new(original))
        .map_err(|e| format!("Repack: invalid ZIP: {e}"))?;

    for i in 0..archive.len() {
        let entry = archive.by_index_raw(i)
            .map_err(|e| format!("Repack: cannot read entry {i}: {e}"))?;
        if entry.name() == "state.db" {
            continue; // will be replaced below
        }
        writer.raw_copy_file(entry)
            .map_err(|e| format!("Repack: raw copy failed: {e}"))?;
    }

    // Add current state.db with STORE compression (SQLite binary is not compressible).
    writer
        .start_file(
            "state.db",
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored),
        )
        .map_err(|e| format!("Repack: cannot start state.db entry: {e}"))?;
    writer
        .write_all(&state_db_bytes)
        .map_err(|e| format!("Repack: write state.db failed: {e}"))?;

    writer.finish().map_err(|e| format!("Repack: finish failed: {e}"))?;

    // Atomic rename sequence
    let bak_path = format!("{uix_path}.bak");
    let _ = std::fs::rename(uix_path, &bak_path); // temporary backup during swap
    std::fs::rename(&tmp_path, uix_path)
        .map_err(|e| format!("Repack: atomic rename failed: {e}"))?;
    // New file written successfully — remove the backup
    let _ = std::fs::remove_file(&bak_path);

    Ok(())
}

// ---------------------------------------------------------------------------
// Bridge script injected into every .uix HTML page
//
// The iframe at uix:// is cross-origin from the Tauri shell (tauri://localhost),
// so it cannot call window.__TAURI_INTERNALS__ directly.  Instead we use a
// postMessage relay: iframe -> parent shell -> invoke() -> Rust -> reply back.
// ---------------------------------------------------------------------------

fn diagnostics_script() -> &'static str {
        r#"<script>
(function () {
    function emitStatus(type, detail, metadata) {
        try {
            parent.postMessage({
                __dotuix_status: true,
                type: type,
                detail: detail || "",
                metadata: metadata || {},
                ts: Date.now()
            }, "*");
        } catch (_) {
            // Best-effort diagnostics only.
        }
    }

    emitStatus("bridge_bootstrap", "Diagnostics bridge initialized.", {
        href: String((window.location && window.location.href) || ""),
        readyState: String(document.readyState || "")
    });

    window.addEventListener("DOMContentLoaded", function () {
        emitStatus("dom_content_loaded", "DOMContentLoaded fired.", {
            readyState: String(document.readyState || "")
        });
    });

    window.addEventListener("load", function () {
        emitStatus("window_load", "window load fired.", {
            readyState: String(document.readyState || "")
        });
    });

    window.addEventListener("error", function (event) {
        var message = event && event.message
            ? String(event.message)
            : "Unknown runtime error";
        emitStatus("runtime_error", message, {
            filename: event && event.filename ? String(event.filename) : "",
            lineno: event && typeof event.lineno === "number" ? event.lineno : 0,
            colno: event && typeof event.colno === "number" ? event.colno : 0
        });
    });

    window.addEventListener("unhandledrejection", function (event) {
        var reason = event && event.reason;
        var message = "";
        if (reason && typeof reason === "object" && "message" in reason) {
            message = String(reason.message);
        } else {
            message = String(reason || "Unhandled promise rejection");
        }
        emitStatus("unhandled_rejection", message, {});
    });
})();
</script>"#
}

fn bridge_script(manifest_json: &str, stored_schema_version: u32) -> String {
    let viewer_version = VIEWER_VERSION;
    format!(
        r#"<script>
(function () {{
  var m = {manifest_json};
  var _viewer_version = "{viewer_version}";
  var _storedSchemaVersion = {stored_schema_version};
  var _currentSchemaVersion = (m.schemaVersion || 1);
  var _perms = (m.permissions || []);
  var _seq = 0;
  var _pending = {{}};

  function relay(cmd, payload) {{
    return new Promise(function (resolve, reject) {{
      var id = ++_seq;
      _pending[id] = {{ resolve: resolve, reject: reject }};
      parent.postMessage({{ __dotuix: true, id: id, cmd: cmd, payload: payload || {{}} }}, '*');
    }});
  }}

  window.addEventListener('message', function (e) {{
    var d = e.data;
    if (!d || !d.__dotuix_reply) return;
    var p = _pending[d.id];
    if (!p) return;
    delete _pending[d.id];
    if (d.error) p.reject(new Error(d.error));
    else p.resolve(d.result);
  }});

  window.__uix = {{
    manifest: function() {{ return m; }},
    data: {{

      find: function (opts) {{
        var q = (typeof opts === 'string') ? {{ type: opts }} : Object.assign({{}}, opts);
        return relay('data_find', {{ query: q }});
      }},
      get:  function (id)              {{ return relay('data_get',  {{ id: id }}); }},
      count: function (opts)            {{
        var q = (typeof opts === 'string') ? {{ type: opts }} : Object.assign({{}}, opts);
        return relay('data_count', {{ query: q }});
      }},
      raw:  function (sql, params)     {{ return relay('data_raw',  {{ sql: sql, params: params || [] }}); }},
    }},
    state: {{
      find:   function (opts) {{
        var q = (typeof opts === 'string') ? {{ type: opts }} : Object.assign({{}}, opts);
        return relay('state_find', {{ query: q }});
      }},
      get:    function (id)          {{ return relay('state_get',   {{ id: id }}); }},
      insert: function (opts)        {{
        var body = opts.body;
        if (typeof body !== 'string') body = JSON.stringify(body);
        return relay('state_insert', {{ type: opts.type, body: body }});
      }},
      update: function (id, body)    {{
        if (typeof body !== 'string') body = JSON.stringify(body);
        return relay('state_update', {{ id: id, body: body }});
      }},
      delete: function (id)          {{ return relay('state_delete', {{ id: id }}); }},
      purge:  function (opts)        {{
        return relay('state_purge', {{ type: (opts && opts.type) || opts, older_than: opts.olderThan || '30d' }});
      }},
      count: function (opts) {{
        var q = (typeof opts === 'string') ? {{ type: opts }} : Object.assign({{}}, opts);
        return relay('state_count', {{ query: q }});
      }},
      transaction: function (ops) {{
        var normalized = (ops || []).map(function(op) {{
          var o = Object.assign({{}}, op);
          if (o.body && typeof o.body === 'string') {{
            try {{ o.body = JSON.parse(o.body); }} catch(e) {{}}
          }}
          return o;
        }});
        return relay('state_transaction', {{ ops: normalized }});
      }},
      clear: function (opts) {{
        var payload = {{}};
        if (opts && opts.type) payload.record_type = opts.type;
        return relay('state_clear', payload);
      }},
      reset: function () {{ return relay('state_reset', {{}}); }},
      upsert: function (opts) {{
        var body = opts.body;
        if (typeof body !== 'string') body = JSON.stringify(body);
        return relay('state_upsert', {{ id: opts.id, type: opts.type, body: body }});
      }},
      insertMany: function (records) {{
        var normalized = (records || []).map(function(r) {{
          var o = Object.assign({{}}, r);
          if (o.body && typeof o.body !== 'string') o.body = JSON.stringify(o.body);
          return o;
        }});
        return relay('state_insert_many', {{ records: normalized }});
      }},
      size:   function ()            {{ return relay('state_size',   {{}}); }},
      vacuum: function ()            {{ return relay('state_vacuum', {{}}); }},
      export: function (opts) {{
        opts = opts || {{}};
        var p;
        if (opts.type) {{
          p = relay('state_find', {{ query: {{ type: opts.type }} }});
        }} else if (_perms.indexOf('raw-sql') !== -1) {{
          p = relay('state_raw', {{ sql: 'SELECT id, type, body, created_at, updated_at FROM records ORDER BY created_at', params: [] }});
        }} else {{
          return Promise.reject(new Error("state.export() without a type filter requires the 'raw-sql' permission."));
        }}
        return p.then(function(all) {{
          if (opts.before) {{
            var cutoff = opts.before;
            all = all.filter(function(r) {{ return r.created_at < cutoff; }});
          }}
          return JSON.stringify(all);
        }});
      }},
      raw:    function (sql, params) {{ return relay('state_raw',  {{ sql: sql, params: params || [] }}); }},
      exportBundle: function(opts) {{
        opts = opts || {{}};
        var types = (opts.types && opts.types.length > 0) ? opts.types : null;
        return relay('state_export_bundle', {{ types: types }});
      }},
      importBundle: function(json, opts) {{
        opts = opts || {{}};
        return relay('state_import_bundle', {{ bundle: json, merge: opts.merge ? true : false }});
      }},
      sync: function () {{
        if (_perms.indexOf('local-sync') === -1)
          return Promise.reject(new Error("Permission denied: 'local-sync' not declared in manifest.json permissions."));
        return relay('state_sync', {{}});
      }},
    }},
    clipboard: {{
      write: function (text) {{
        if (_perms.indexOf('clipboard-write') === -1)
          return Promise.reject(new Error("Permission denied: 'clipboard-write' not declared in manifest.json permissions."));
        return navigator.clipboard.writeText(text);
      }},
    }},
    fullscreen: {{
      enter:  function () {{ return relay('uix_enter_fullscreen',  {{}}); }},
      exit:   function () {{ return relay('uix_exit_fullscreen',   {{}}); }},
      toggle: function () {{ return relay('uix_toggle_fullscreen', {{}}); }},
    }},
    viewer: {{
      version: function () {{ return _viewer_version; }},
    }},
    file: {{
      save: function (filename, content, mimeType) {{
        var b64;
        if (content instanceof ArrayBuffer) {{
          var bytes = new Uint8Array(content);
          var str = '';
          for (var i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
          b64 = btoa(str);
        }} else {{
          b64 = btoa(unescape(encodeURIComponent(String(content))));
        }}
        return relay('uix_save_file', {{ filename: filename, content_b64: b64 }});
      }},
      open: function (opts) {{
        var o = opts || {{}};
        return relay('uix_open_file', {{ filter: o.filter || null }}).then(function(r) {{
          if (!r) return null;
          var bin = atob(r.content_b64);
          var buf = new ArrayBuffer(bin.length);
          var view = new Uint8Array(buf);
          for (var i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
          return {{ name: r.name, content: buf }};
        }});
      }},
    }},
    browser: {{
      open: function (url) {{ return relay('uix_open_url', {{ url: url }}); }},
    }},
    window: {{
      setTitle: function (title) {{ return relay('uix_set_window_title', {{ title: title }}); }},
    }},
    notify: function (title, body, opts) {{
      return relay('uix_notify', {{ title: title, body: body }});
    }},
    print: function () {{ window.print(); }},
    exit:  function () {{ return relay('uix_exit', {{}}); }},
    schema: {{
      onUpgrade: function(fn) {{
        var from = _storedSchemaVersion;
        var to   = _currentSchemaVersion;
        if (from >= to) return Promise.resolve();
        return relay('schema_upgrade_begin', {{}}).then(function() {{
          return Promise.resolve()
            .then(function() {{ return fn({{ from: from, to: to, state: window.__uix.state }}); }})
            .then(function() {{ return relay('schema_upgrade_commit', {{ version: to }}); }})
            .catch(function(err) {{
              return relay('schema_upgrade_rollback', {{}}).then(function() {{ throw err; }});
            }});
        }});
      }},
      version:       function() {{ return _currentSchemaVersion; }},
      storedVersion: function() {{ return _storedSchemaVersion; }},
      needsUpgrade:  function() {{ return _storedSchemaVersion < _currentSchemaVersion; }},
    }},
    license: {{
      get:        function()        {{ return relay('license_get',         {{}}); }},
      hasFeature: function(feature) {{ return relay('license_has_feature', {{ feature: feature }}); }},
    }},
  }};
  // Convenience alias — uix.data.find() works without window.__uix prefix
  window.uix = window.__uix;
}})();
</script>"#
    )
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/// find() query parameters — all fields except type are optional.
#[derive(serde::Deserialize, Default)]
struct FindQuery {
    #[serde(rename = "type")]
    record_type: String,
    /// Field equality filters applied via json_extract(body, '$.key') = value.
    #[serde(rename = "where")]
    filters: Option<HashMap<String, serde_json::Value>>,
    /// Column or body field to sort by. Accepts either a plain string ("created_at", "sort", …)
    /// or an object { field: "sort", direction: "asc"|"desc" } as documented in llms.txt.
    #[serde(rename = "orderBy")]
    order_by: Option<serde_json::Value>,
    /// Maximum number of rows to return.
    limit: Option<u32>,
    /// Number of rows to skip before returning results (pagination). SQLite requires
    /// LIMIT when OFFSET is used; LIMIT -1 is appended automatically if needed.
    offset: Option<u32>,
}

/// Reject identifier strings that could be used for SQL injection.
/// Only alphanumeric characters, underscores, and dots are allowed.
fn validate_identifier(s: &str, context: &str) -> Result<(), String> {
    if s.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.') && !s.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Invalid {context}: '{s}'. Only alphanumeric characters, underscores, and dots are allowed."
        ))
    }
}

/// Convert a serde_json value into a boxed rusqlite ToSql parameter.
fn json_to_sql_param(val: &serde_json::Value) -> Box<dyn rusqlite::ToSql> {
    match val {
        serde_json::Value::String(s) => Box::new(s.clone()),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() { Box::new(i) }
            else if let Some(f) = n.as_f64() { Box::new(f) }
            else { Box::new(n.to_string()) }
        }
        serde_json::Value::Bool(b) => Box::new(*b as i64),
        serde_json::Value::Null => Box::new(rusqlite::types::Null),
        other => Box::new(other.to_string()),
    }
}

/// Convert a rusqlite runtime Value to a serde_json Value.
fn sqlite_val_to_json(val: rusqlite::types::Value) -> serde_json::Value {
    match val {
        rusqlite::types::Value::Null       => serde_json::Value::Null,
        rusqlite::types::Value::Integer(i) => serde_json::json!(i),
        rusqlite::types::Value::Real(f)    => serde_json::json!(f),
        rusqlite::types::Value::Text(s)    => serde_json::Value::String(s),
        rusqlite::types::Value::Blob(b)    => {
            // Encode as lowercase hex so callers can detect/decode binary data.
            serde_json::Value::String(b.iter().map(|byte| format!("{byte:02x}")).collect())
        }
    }
}

/// Build WHERE conditions and bound parameters from a filters map.
/// Supports plain scalars (equality) and operator objects:
/// eq, neq, gt, gte, lt, lte, like, in, is_null.
/// Parameter indices start at 2 (?1 is always the type field).
fn build_where_clause(
    filters: &HashMap<String, serde_json::Value>,
) -> Result<(Vec<String>, Vec<Box<dyn rusqlite::ToSql>>), String> {
    let mut conditions: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    for (key, val) in filters {
        validate_identifier(key, "where field")?;
        let col = format!("json_extract(body, '$.{key}')");

        match val {
            serde_json::Value::Object(ops) => {
                for (op, op_val) in ops {
                    match op.as_str() {
                        "eq" => {
                            let idx = params.len() + 2;
                            conditions.push(format!("{col} = ?{idx}"));
                            params.push(json_to_sql_param(op_val));
                        }
                        "neq" => {
                            let idx = params.len() + 2;
                            conditions.push(format!("{col} != ?{idx}"));
                            params.push(json_to_sql_param(op_val));
                        }
                        "gt" => {
                            let idx = params.len() + 2;
                            conditions.push(format!("{col} > ?{idx}"));
                            params.push(json_to_sql_param(op_val));
                        }
                        "gte" => {
                            let idx = params.len() + 2;
                            conditions.push(format!("{col} >= ?{idx}"));
                            params.push(json_to_sql_param(op_val));
                        }
                        "lt" => {
                            let idx = params.len() + 2;
                            conditions.push(format!("{col} < ?{idx}"));
                            params.push(json_to_sql_param(op_val));
                        }
                        "lte" => {
                            let idx = params.len() + 2;
                            conditions.push(format!("{col} <= ?{idx}"));
                            params.push(json_to_sql_param(op_val));
                        }
                        "like" => {
                            let idx = params.len() + 2;
                            conditions.push(format!("{col} LIKE ?{idx}"));
                            params.push(json_to_sql_param(op_val));
                        }
                        "in" => {
                            if let serde_json::Value::Array(arr) = op_val {
                                if arr.is_empty() {
                                    conditions.push("1 = 0".to_string()); // IN () is invalid SQL
                                } else {
                                    let placeholders: Vec<String> = (0..arr.len())
                                        .map(|i| format!("?{}", params.len() + 2 + i))
                                        .collect();
                                    conditions.push(format!("{col} IN ({})", placeholders.join(", ")));
                                    for item in arr {
                                        params.push(json_to_sql_param(item));
                                    }
                                }
                            } else {
                                return Err(format!(
                                    "'in' operator for '{key}' requires an array value"
                                ));
                            }
                        }
                        "is_null" => {
                            if op_val.as_bool().unwrap_or(false) {
                                conditions.push(format!("{col} IS NULL"));
                            } else {
                                conditions.push(format!("{col} IS NOT NULL"));
                            }
                        }
                        unknown => return Err(format!(
                            "Unknown where operator '{unknown}' for field '{key}'. \
                             Valid: eq, neq, gt, gte, lt, lte, like, in, is_null"
                        )),
                    }
                }
            }
            _ => {
                let idx = params.len() + 2;
                conditions.push(format!("{col} = ?{idx}"));
                params.push(json_to_sql_param(val));
            }
        }
    }

    Ok((conditions, params))
}

/// Convert one orderBy entry (String or { field, direction } object) into a SQL ORDER BY term.
fn order_term(val: &serde_json::Value) -> Result<String, String> {
    let (col, dir) = match val {
        serde_json::Value::String(s) => (s.as_str(), "ASC"),
        serde_json::Value::Object(obj) => {
            let field = obj.get("field").and_then(|v| v.as_str()).unwrap_or("created_at");
            let dir = obj.get("direction").and_then(|v| v.as_str())
                .map(|d| if d.eq_ignore_ascii_case("desc") { "DESC" } else { "ASC" })
                .unwrap_or("ASC");
            (field, dir)
        }
        _ => ("created_at", "ASC"),
    };
    let col_sql = match col {
        "id" | "type" | "created_at" | "updated_at" => col.to_string(),
        _ => {
            validate_identifier(col, "orderBy")?;
            format!("json_extract(body, '$.{col}')")
        }
    };
    Ok(format!("{col_sql} {dir}"))
}

/// Build and execute a filtered SELECT against a `records` table.
fn query_records(conn: &rusqlite::Connection, query: &FindQuery) -> Result<Vec<Record>, String> {
    let mut conditions: Vec<String> = vec!["type = ?1".to_string()];
    let mut extra_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(filters) = &query.filters {
        let (conds, fparams) = build_where_clause(filters)?;
        conditions.extend(conds);
        extra_params.extend(fparams);
    }

    let mut sql = format!(
        "SELECT id, type, body, created_at, updated_at FROM records WHERE {}",
        conditions.join(" AND ")
    );

    if let Some(order_val) = &query.order_by {
        let clause = match order_val {
            serde_json::Value::Array(entries) => {
                let terms: Result<Vec<String>, String> = entries.iter().map(order_term).collect();
                let terms = terms?;
                if terms.is_empty() { "created_at ASC".to_string() } else { terms.join(", ") }
            }
            other => order_term(other)?,
        };
        sql.push_str(&format!(" ORDER BY {clause}"));
    }

    if let Some(limit) = query.limit {
        sql.push_str(&format!(" LIMIT {limit}"));
    }
    if let Some(offset) = query.offset {
        if query.limit.is_none() {
            sql.push_str(" LIMIT -1"); // SQLite requires LIMIT before OFFSET
        }
        sql.push_str(&format!(" OFFSET {offset}"));
    }

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let type_param: &dyn rusqlite::ToSql = &query.record_type;
    let mut all_params: Vec<&dyn rusqlite::ToSql> = vec![type_param];
    for p in &extra_params {
        all_params.push(p.as_ref());
    }

    let rows = stmt
        .query_map(all_params.as_slice(), |row| {
            Ok(Record {
                id: row.get(0)?,
                r#type: row.get(1)?,
                body: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn get_record(conn: &rusqlite::Connection, id: &str) -> Result<Option<Record>, String> {
    let result = conn.query_row(
        "SELECT id, type, body, created_at, updated_at FROM records WHERE id = ?1",
        [id],
        |row| {
            Ok(Record {
                id: row.get(0)?,
                r#type: row.get(1)?,
                body: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        },
    );
    match result {
        Ok(r) => Ok(Some(r)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Execute an arbitrary SQL query and return rows as JSON objects keyed by column name.
fn exec_raw_sql(
    conn: &rusqlite::Connection,
    sql: &str,
    params: &[serde_json::Value],
) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let col_count = stmt.column_count();
    let col_names: Vec<String> = (0..col_count)
        .map(|i| stmt.column_name(i).unwrap_or("").to_string())
        .collect();

    let raw_params: Vec<Box<dyn rusqlite::ToSql>> = params.iter().map(json_to_sql_param).collect();
    let param_refs: Vec<&dyn rusqlite::ToSql> = raw_params.iter().map(|b| b.as_ref()).collect();

    let rows = stmt
        .query_map(param_refs.as_slice(), |row| {
            let mut obj = serde_json::Map::new();
            for i in 0..col_count {
                let val: rusqlite::types::Value = row.get(i)?;
                obj.insert(col_names[i].clone(), sqlite_val_to_json(val));
            }
            Ok(serde_json::Value::Object(obj))
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Query parameters for count() — type is required, where filters are optional.
#[derive(serde::Deserialize, Default)]
struct CountQuery {
    #[serde(rename = "type")]
    record_type: String,
    #[serde(rename = "where")]
    filters: Option<HashMap<String, serde_json::Value>>,
}

/// Run SELECT COUNT(*) with optional where-equality filters, same semantics as find().
fn count_records(
    conn: &rusqlite::Connection,
    record_type: &str,
    filters: &Option<HashMap<String, serde_json::Value>>,
) -> Result<i64, String> {
    let mut conditions: Vec<String> = vec!["type = ?1".to_string()];
    let mut extra_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(f) = filters {
        let (conds, fparams) = build_where_clause(f)?;
        conditions.extend(conds);
        extra_params.extend(fparams);
    }

    let sql = format!(
        "SELECT COUNT(*) FROM records WHERE {}",
        conditions.join(" AND ")
    );

    let type_owned = record_type.to_owned();
    let type_param: &dyn rusqlite::ToSql = &type_owned;
    let mut all_params: Vec<&dyn rusqlite::ToSql> = vec![type_param];
    for p in &extra_params {
        all_params.push(p.as_ref());
    }

    conn.query_row(&sql, all_params.as_slice(), |row| row.get::<_, i64>(0))
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tauri commands -- file loading
// ---------------------------------------------------------------------------

#[tauri::command]
async fn pick_and_load_uix(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LoadResult, String> {
    let path = pick_uix_path_inner(&app).await?;
    probe_uix_inner(&path, &app, &state)
}

async fn pick_uix_path_inner(app: &AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .add_filter("UIX App", &["uix"])
        .pick_file(move |maybe_path| { let _ = tx.send(maybe_path); });

    let file = rx
        .await
        .map_err(|_| "Dialog closed unexpectedly".to_string())?
        .ok_or_else(|| "No file selected".to_string())?;

    Ok(file.to_string())
}

#[tauri::command]
async fn pick_uix_path(app: AppHandle) -> Result<String, String> {
    pick_uix_path_inner(&app).await
}

#[tauri::command]
fn load_uix(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LoadResult, String> {
    probe_uix_inner(&path, &app, &state)
}

#[tauri::command]
fn open_uix_in_new_process(path: String) -> Result<(), String> {
    let normalized_path = canonical_uix_path(&path);
    if let Some(owner_pid) = running_lock_owner(&normalized_path).or_else(|| running_lock_owner(&path)) {
        if owner_pid != std::process::id() {
            if focus_process_by_pid(owner_pid) {
                return Ok(());
            }
            return Err("This .uix file is already open, but the existing window could not be focused.".to_string());
        }
        return Ok(());
    }

    let exe = std::env::current_exe().map_err(|e| format!("Cannot locate viewer executable: {e}"))?;
    std::process::Command::new(exe)
        .arg(normalized_path)
        .spawn()
        .map_err(|e| format!("Cannot open a new viewer window: {e}"))?;
    Ok(())
}

#[tauri::command]
fn focus_main_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
fn close_uix(state: State<'_, AppState>) {
    let uix_path = state.uix_path.lock().unwrap().clone();
    if uix_path.is_empty() {
        clear_temp_web_root(&state);
        clear_temp_data_db(&state);
        return;
    }
    let state_db_path = state.state_db_path.lock().unwrap().clone();
    let state_mode = state.state_mode.lock().unwrap().clone();
    { let _ = state.state_db.lock().unwrap().take(); }
    { let _ = state.data_db.lock().unwrap().take(); }
    if state_mode != "device" {
        if let Some(db_path) = state_db_path {
            if db_path.exists() { let _ = repack_uix(&uix_path, &db_path); }
        }
    }
    let _ = std::fs::remove_file(format!("{uix_path}.lock"));
    *state.uix_path.lock().unwrap() = String::new();
    *state.state_db_path.lock().unwrap() = None;
    *state.license_info.lock().unwrap() = None;
    *state.content_security_policy.lock().unwrap() = csp_for_network(false).to_string();
    state.files.lock().unwrap().clear();
    clear_temp_web_root(&state);
    clear_temp_data_db(&state);
}

/// Returns (and clears) the .uix path that was passed as a CLI argument on launch.
/// Called once by the frontend on startup to auto-open a file from file association.
#[tauri::command]
fn get_initial_file(state: State<'_, AppState>) -> Option<String> {
    state.initial_path.lock().unwrap().take()
}

/// Complete loading a PIN-protected .uix file.
/// The pending files must already have been stored by a previous `load_uix` / `pick_and_load_uix`
/// call that returned `{ status: "pin_required" }`.
#[tauri::command]
fn unlock_with_pin(
    pin: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LoadResult, String> {
    let path = state.pending_path.lock().unwrap().take()
        .ok_or("No pending app to unlock — call load_uix first")?;
    let mut files = state.pending_files.lock().unwrap().take()
        .ok_or("No pending files to decrypt")?;
    let manifest = state.pending_manifest.lock().unwrap().take()
        .ok_or("No pending manifest")?;

    // Read security parameters from manifest.
    let security = manifest.get("security")
        .ok_or("Manifest has no 'security' block")?;
    let key_salt_b64 = security.get("keySalt").and_then(|v| v.as_str())
        .ok_or("security.keySalt missing")?;
    let iterations = security.get("kdfIterations").and_then(|v| v.as_u64())
        .unwrap_or(200_000) as u32;
    let encrypted_paths: Vec<String> = security
        .get("encryptedPaths").and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let observed_app_id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let salt = base64_url_decode(key_salt_b64)?;
    let key = derive_aes_key(&pin, &salt, iterations);

    for ep in &encrypted_paths {
        let encrypted = files.get(ep)
            .ok_or_else(|| format!("Encrypted path not found in archive: {ep}"))?
            .clone();
        let decrypted = decrypt_aes_gcm(&encrypted, &key).map_err(|error| {
            emit_desktop_event(
                "desktop.trust_gate.blocked",
                "warn",
                Some(observed_app_id.as_str()),
                Some("pin_invalid"),
                Some(serde_json::json!({
                    "path": ep,
                    "error": error,
                })),
            );
            error
        })?;
        files.insert(ep.clone(), decrypted);
    }

    complete_load(&path, files, &manifest, &app, &state)
}


/// Return the manifest of the currently open .uix app.
#[tauri::command]
fn get_manifest(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let files = state.files.lock().unwrap();
    let bytes = files.get("manifest.json").ok_or("No app loaded")?;
    serde_json::from_slice(bytes).map_err(|e| e.to_string())
}

/// Prepare a temporary on-disk web root for iframe fallback mode and
/// return the absolute file path to the requested entry document.
#[tauri::command]
fn prepare_iframe_fallback_entry(
    entry_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let app_id = state.app_id.lock().unwrap().clone();
    if app_id.is_empty() {
        return Err("No app loaded".into());
    }

    let normalized_entry = normalize_protocol_request_path(&entry_path);
    let entry_rel = archive_relative_path(&normalized_entry)
        .ok_or_else(|| format!("Invalid entry path: {normalized_entry}"))?;
    let stored_schema_version = *state.stored_schema_version.lock().unwrap();

    let (files, manifest_json) = {
        let map = state.files.lock().unwrap();
        if map.is_empty() {
            return Err("No app files loaded".into());
        }

        let manifest_json = protocol_get_file(&map, "manifest.json")
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
            .unwrap_or_else(|| "{}".to_string());

        let files = map
            .iter()
            .map(|(path, bytes)| (path.clone(), bytes.clone()))
            .collect::<Vec<_>>();

        (files, manifest_json)
    };

    clear_temp_web_root(&state);

    let safe_app_id: String = app_id
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect();
    let root = std::env::temp_dir().join(format!(
        "dotuix_{safe_app_id}_web_{}_{}_{}",
        std::process::id(),
        now_ms(),
        gen_id()
    ));
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Cannot create fallback web root {}: {e}", root.display()))?;

    let bridge_file_name = "__dotuix_viewer_bridge.js";
    let bridge_script = fallback_bridge_script_source(&manifest_json, stored_schema_version);
    let mut bridge_written_dirs = HashSet::<std::path::PathBuf>::new();

    for (raw_path, bytes) in files {
        let Some(rel_path) = archive_relative_path(&raw_path) else {
            continue;
        };

        let dest = root.join(&rel_path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "Cannot create fallback directory {}: {e}",
                    parent.display()
                )
            })?;
        }

        let rel_for_mime = rel_path.to_string_lossy().replace('\\', "/");
        let payload = if mime_for(&rel_for_mime).starts_with("text/html") {
            let bridge_dir = dest
                .parent()
                .map(|parent| parent.to_path_buf())
                .unwrap_or_else(|| root.clone());

            if bridge_written_dirs.insert(bridge_dir.clone()) {
                let bridge_path = bridge_dir.join(bridge_file_name);
                std::fs::write(&bridge_path, bridge_script.as_bytes()).map_err(|e| {
                    format!(
                        "Cannot write fallback bridge script {}: {e}",
                        bridge_path.display()
                    )
                })?;
            }

            html_with_external_bridge_loader(&bytes, bridge_file_name)
        } else {
            bytes
        };

        std::fs::write(&dest, payload)
            .map_err(|e| format!("Cannot write fallback file {}: {e}", dest.display()))?;
    }

    let entry_abs = root.join(entry_rel);
    if !entry_abs.exists() {
        return Err(format!("Entry document not found in archive: {normalized_entry}"));
    }

    *state.temp_web_root_path.lock().unwrap() = Some(root);
    Ok(entry_abs.to_string_lossy().replace('\\', "/"))
}

/// Close the viewer window (kiosk exit). PIN protection is a future enhancement.
#[tauri::command]
async fn uix_exit(app: AppHandle) {
    app.exit(0);
}

// ---------------------------------------------------------------------------
// Tauri commands -- data bridge (read-only product data from data.db)
// ---------------------------------------------------------------------------

#[tauri::command]
fn data_find(query: FindQuery, state: State<'_, AppState>) -> Result<Vec<Record>, String> {
    let db = state.data_db.lock().unwrap();
    match db.as_ref() {
        None => Ok(vec![]),
        Some(conn) => query_records(conn, &query),
    }
}

#[tauri::command]
fn data_get(id: String, state: State<'_, AppState>) -> Result<Option<Record>, String> {
    let db = state.data_db.lock().unwrap();
    match db.as_ref() {
        None => Ok(None),
        Some(conn) => get_record(conn, &id),
    }
}

/// Execute raw SQL against data.db (SELECT only).
/// Requires "raw-sql" in manifest.json permissions.
#[tauri::command]
fn data_raw(
    sql: String,
    params: Option<Vec<serde_json::Value>>,
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    {
        let perms = state.permissions.lock().unwrap();
        if !perms.contains(&"raw-sql".to_string()) {
            return Err("Permission denied: 'raw-sql' is not declared in manifest.json permissions.".into());
        }
    }
    // data.db is read-only by contract — restrict to SELECT statements.
    if !sql.trim().to_lowercase().starts_with("select") {
        return Err("data.raw() is read-only. Only SELECT statements are permitted.".into());
    }
    let db = state.data_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;
    exec_raw_sql(conn, &sql, &params.unwrap_or_default())
}

// ---------------------------------------------------------------------------
// Tauri commands -- state bridge (mutable records in state.db)
// ---------------------------------------------------------------------------

#[tauri::command]
fn state_find(query: FindQuery, state: State<'_, AppState>) -> Result<Vec<Record>, String> {
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;
    query_records(conn, &query)
}

#[tauri::command]
fn state_get(id: String, state: State<'_, AppState>) -> Result<Option<Record>, String> {
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;
    get_record(conn, &id)
}

#[tauri::command]
fn state_insert(
    r#type: String,
    body: String,
    state: State<'_, AppState>,
) -> Result<Record, String> {
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;
    let id = gen_id();
    let now = now_ms();
    conn.execute(
        "INSERT INTO records (id, type, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![id, r#type, body, now, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(Record { id, r#type, body, created_at: now, updated_at: now })
}

#[tauri::command]
fn state_update(
    id: String,
    body: String,
    state: State<'_, AppState>,
) -> Result<Record, String> {
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;
    let now = now_ms();
    let changed = conn
        .execute(
            "UPDATE records SET body = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![body, now, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("Record not found: {id}"));
    }
    get_record(conn, &id)?.ok_or_else(|| format!("Record disappeared after update: {id}"))
}

#[tauri::command]
fn state_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;
    conn.execute("DELETE FROM records WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete records of a given type older than a duration ("30d", "12h", "1y").
/// Returns the number of records deleted.
#[tauri::command]
fn state_purge(
    r#type: String,
    older_than: String,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let seconds = parse_duration(&older_than)?;
    let cutoff_ms = now_ms() - (seconds * 1000) as i64;
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;
    let n = conn
        .execute(
            "DELETE FROM records WHERE type = ?1 AND created_at < ?2",
            rusqlite::params![r#type, cutoff_ms],
        )
        .map_err(|e| e.to_string())?;
    Ok(n as u64)
}

/// Execute raw SQL against state.db (read + write allowed).
/// Requires "raw-sql" in manifest.json permissions.
#[tauri::command]
fn state_raw(
    sql: String,
    params: Option<Vec<serde_json::Value>>,
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    {
        let perms = state.permissions.lock().unwrap();
        if !perms.contains(&"raw-sql".to_string()) {
            return Err("Permission denied: 'raw-sql' is not declared in manifest.json permissions.".into());
        }
    }
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;
    exec_raw_sql(conn, &sql, &params.unwrap_or_default())
}

// ---------------------------------------------------------------------------
// Phase 1 additions: count, transaction, clear, reset
// ---------------------------------------------------------------------------

#[tauri::command]
fn data_count(query: CountQuery, state: State<'_, AppState>) -> Result<i64, String> {
    let db = state.data_db.lock().unwrap();
    match db.as_ref() {
        None => Ok(0),
        Some(conn) => count_records(conn, &query.record_type, &query.filters),
    }
}

#[tauri::command]
fn state_count(query: CountQuery, state: State<'_, AppState>) -> Result<i64, String> {
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;
    count_records(conn, &query.record_type, &query.filters)
}

/// Operation item for state_transaction — op is one of: insert, update, upsert, delete.
#[derive(serde::Deserialize)]
struct TransactionOp {
    op: String,
    #[serde(rename = "type")]
    record_type: Option<String>,
    id: Option<String>,
    body: Option<serde_json::Value>,
}

/// Execute a list of write operations atomically: all succeed or all roll back.
/// Returns a parallel array — Some(Record) for write ops, None for deletes.
#[tauri::command]
fn state_transaction(
    ops: Vec<TransactionOp>,
    state: State<'_, AppState>,
) -> Result<Vec<Option<Record>>, String> {
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;

    conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;

    let result: Result<Vec<Option<Record>>, String> = (|| {
        let mut results: Vec<Option<Record>> = Vec::with_capacity(ops.len());
        for item in &ops {
            match item.op.as_str() {
                "insert" => {
                    let rtype = item.record_type.as_deref()
                        .ok_or("transaction insert: 'type' is required")?;
                    let bval = item.body.as_ref()
                        .ok_or("transaction insert: 'body' is required")?;
                    let body_str = match bval {
                        serde_json::Value::String(s) => s.clone(),
                        v => serde_json::to_string(v).map_err(|e| e.to_string())?,
                    };
                    let id = item.id.clone()
                        .unwrap_or_else(|| format!("{}:{}", rtype, gen_id()));
                    let now = now_ms();
                    conn.execute(
                        "INSERT INTO records (id, type, body, created_at, updated_at) \
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        rusqlite::params![id, rtype, body_str, now, now],
                    ).map_err(|e| e.to_string())?;
                    results.push(Some(Record {
                        id,
                        r#type: rtype.to_string(),
                        body: body_str,
                        created_at: now,
                        updated_at: now,
                    }));
                }
                "update" => {
                    let id = item.id.as_deref()
                        .ok_or("transaction update: 'id' is required")?;
                    let bval = item.body.as_ref()
                        .ok_or("transaction update: 'body' is required")?;
                    let body_str = match bval {
                        serde_json::Value::String(s) => s.clone(),
                        v => serde_json::to_string(v).map_err(|e| e.to_string())?,
                    };
                    let now = now_ms();
                    let changed = conn.execute(
                        "UPDATE records SET body = ?1, updated_at = ?2 WHERE id = ?3",
                        rusqlite::params![body_str, now, id],
                    ).map_err(|e| e.to_string())?;
                    if changed == 0 {
                        return Err(format!("transaction update: record not found: {id}"));
                    }
                    results.push(get_record(conn, id)?);
                }
                "upsert" => {
                    let id = item.id.as_deref()
                        .ok_or("transaction upsert: 'id' is required")?;
                    let rtype = item.record_type.as_deref()
                        .ok_or("transaction upsert: 'type' is required")?;
                    let bval = item.body.as_ref()
                        .ok_or("transaction upsert: 'body' is required")?;
                    let body_str = match bval {
                        serde_json::Value::String(s) => s.clone(),
                        v => serde_json::to_string(v).map_err(|e| e.to_string())?,
                    };
                    let now = now_ms();
                    conn.execute(
                        "INSERT INTO records (id, type, body, created_at, updated_at) \
                         VALUES (?1, ?2, ?3, ?4, ?5) \
                         ON CONFLICT(id) DO UPDATE SET body = excluded.body, \
                         updated_at = excluded.updated_at",
                        rusqlite::params![id, rtype, body_str, now, now],
                    ).map_err(|e| e.to_string())?;
                    results.push(get_record(conn, id)?);
                }
                "delete" => {
                    let id = item.id.as_deref()
                        .ok_or("transaction delete: 'id' is required")?;
                    conn.execute("DELETE FROM records WHERE id = ?1", [id])
                        .map_err(|e| e.to_string())?;
                    results.push(None);
                }
                other => return Err(format!(
                    "Unknown transaction op: '{other}'. Valid: insert, update, upsert, delete"
                )),
            }
        }
        Ok(results)
    })();

    match result {
        Ok(rows) => {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(rows)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Delete records of one type, or all records when no type is given.
/// Runs incremental_vacuum to partially reclaim freed pages.
#[tauri::command]
fn state_clear(
    record_type: Option<String>,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;
    let n = match &record_type {
        Some(t) => conn
            .execute("DELETE FROM records WHERE type = ?1", [t])
            .map_err(|e| e.to_string())?,
        None => conn
            .execute("DELETE FROM records", [])
            .map_err(|e| e.to_string())?,
    };
    conn.execute_batch("PRAGMA incremental_vacuum").map_err(|e| e.to_string())?;
    Ok(n as u64)
}

/// Restore state.db to its original shipped state:
/// - If state.seed=true, copies state_seed.db (saved on first open) back over state.db.
/// - If no seed, deletes all records (same as state_clear with no type).
#[tauri::command]
fn state_reset(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let app_id = state.app_id.lock().unwrap().clone();
    if app_id.is_empty() {
        return Err("No app loaded".into());
    }
    let state_db_path = state.state_db_path.lock().unwrap().clone()
        .ok_or("No state.db path — app may not be fully loaded")?;
    let data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Cannot get app data dir: {e}"))?.join(&app_id);
    let seed_backup = data_dir.join("state_seed.db");
    let tmp = data_dir.join("state_reset.tmp");

    // Hold the lock for the entire operation to block concurrent DB access.
    let mut db_guard = state.state_db.lock().unwrap();
    *db_guard = None; // drop existing connection before touching the file

    if seed_backup.exists() {
        // Atomic restore: copy seed to tmp, then rename over state.db.
        std::fs::copy(&seed_backup, &tmp)
            .map_err(|e| format!("Cannot copy seed backup: {e}"))?;
        std::fs::rename(&tmp, &state_db_path)
            .map_err(|e| format!("Cannot restore state.db from seed: {e}"))?;
    } else {
        // No seed — open temporarily to clear all records.
        let conn = rusqlite::Connection::open(&state_db_path)
            .map_err(|e| format!("Cannot open state.db for reset: {e}"))?;
        conn.execute("DELETE FROM records", []).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA incremental_vacuum").map_err(|e| e.to_string())?;
    }

    // Reopen and restore to AppState.
    let conn = rusqlite::Connection::open(&state_db_path)
        .map_err(|e| format!("Cannot reopen state.db after reset: {e}"))?;
    ensure_state_schema(&conn, &app_id)?;
    *db_guard = Some(conn);
    Ok(())
}

// ---------------------------------------------------------------------------
// Phase 2 additions: upsert, insertMany, size, vacuum, fullscreen
// ---------------------------------------------------------------------------

#[tauri::command]
fn state_upsert(
    id: String,
    r#type: String,
    body: String,
    state: State<'_, AppState>,
) -> Result<Record, String> {
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;
    let now = now_ms();
    conn.execute(
        "INSERT INTO records (id, type, body, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5) \
         ON CONFLICT(id) DO UPDATE SET body = excluded.body, \
         updated_at = excluded.updated_at",
        rusqlite::params![id, r#type, body, now, now],
    ).map_err(|e| e.to_string())?;
    get_record(conn, &id)?.ok_or_else(|| "upsert: record not found after write".into())
}

/// Item shape accepted by state_insert_many.
#[derive(serde::Deserialize)]
struct InsertItem {
    #[serde(rename = "type")]
    record_type: String,
    id: Option<String>,
    body: String,
}

/// Insert a batch of records atomically: all succeed or all roll back.
#[tauri::command]
fn state_insert_many(
    records: Vec<InsertItem>,
    state: State<'_, AppState>,
) -> Result<Vec<Record>, String> {
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;

    conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;

    let result: Result<Vec<Record>, String> = (|| {
        let mut out: Vec<Record> = Vec::with_capacity(records.len());
        for item in &records {
            let id = item.id.clone()
                .unwrap_or_else(|| format!("{}:{}", item.record_type, gen_id()));
            let now = now_ms();
            conn.execute(
                "INSERT INTO records (id, type, body, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![id, item.record_type, item.body, now, now],
            ).map_err(|e| e.to_string())?;
            out.push(Record {
                id,
                r#type: item.record_type.clone(),
                body: item.body.clone(),
                created_at: now,
                updated_at: now,
            });
        }
        Ok(out)
    })();

    match result {
        Ok(rows) => {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(rows)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Return the file size, total record count, and per-type record counts for state.db.
#[derive(serde::Serialize)]
struct StateSize {
    bytes: u64,
    records: i64,
    types: HashMap<String, i64>,
}

#[tauri::command]
fn state_size(state: State<'_, AppState>) -> Result<StateSize, String> {
    let state_db_path = state.state_db_path.lock().unwrap().clone()
        .ok_or("No state.db path")?;
    let bytes = std::fs::metadata(&state_db_path).map(|m| m.len()).unwrap_or(0);

    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;

    let records: i64 = conn
        .query_row("SELECT COUNT(*) FROM records", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT type, COUNT(*) FROM records GROUP BY type")
        .map_err(|e| e.to_string())?;
    let types: HashMap<String, i64> = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(StateSize { bytes, records, types })
}

/// Reclaim all free pages in state.db via VACUUM. Returns bytes before and after.
#[tauri::command]
fn state_vacuum(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let state_db_path = state.state_db_path.lock().unwrap().clone()
        .ok_or("No state.db path")?;
    let before = std::fs::metadata(&state_db_path).map(|m| m.len()).unwrap_or(0);
    {
        let db = state.state_db.lock().unwrap();
        let conn = db.as_ref().ok_or("No app loaded")?;
        conn.execute_batch("VACUUM").map_err(|e| e.to_string())?;
    }
    let after = std::fs::metadata(&state_db_path).map(|m| m.len()).unwrap_or(0);
    Ok(serde_json::json!({ "before": before, "after": after }))
}

/// Updates the schema_version stored in meta.  Called by the bridge after a successful
/// `uix.schema.onUpgrade()` run.  Persists the new version so upgrades don't re-run.
#[tauri::command]
fn schema_version_set(version: u32, state: State<'_, AppState>) -> Result<(), String> {
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)",
        rusqlite::params![version.to_string()],
    )
    .map_err(|e| e.to_string())?;
    *state.stored_schema_version.lock().unwrap() = version;
    Ok(())
}

/// Opens an EXCLUSIVE SQLite transaction on state.db for a schema upgrade.
/// All subsequent uix.state.* bridge calls run inside this transaction until
/// `schema_upgrade_commit` or `schema_upgrade_rollback` is called.
#[tauri::command]
fn schema_upgrade_begin(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;
    conn.execute_batch("BEGIN EXCLUSIVE").map_err(|e| e.to_string())
}

/// Commits the open schema-upgrade transaction and persists the new schema version.
#[tauri::command]
fn schema_upgrade_commit(version: u32, state: State<'_, AppState>) -> Result<(), String> {
    {
        let db = state.state_db.lock().unwrap();
        let conn = db.as_ref().ok_or("No app loaded")?;
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)",
            rusqlite::params![version.to_string()],
        )
        .map_err(|e| e.to_string())?;
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    }
    *state.stored_schema_version.lock().unwrap() = version;
    Ok(())
}

/// Rolls back the open schema-upgrade transaction, leaving state.db and schemaVersion untouched.
#[tauri::command]
fn schema_upgrade_rollback(state: State<'_, AppState>) -> Result<(), String> {
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;
    conn.execute_batch("ROLLBACK").map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Phase 6 additions: license
// ---------------------------------------------------------------------------

/// Returns the license info for the currently open app, or null if no license is loaded.
#[tauri::command]
fn license_get(state: State<'_, AppState>) -> Result<Option<LicenseInfo>, String> {
    let lic = state.license_info.lock().unwrap().clone();
    Ok(lic.map(|p| LicenseInfo {
        issued_to: p.issued_to,
        issued_at: p.issued_at,
        expires_at: p.expires_at,
        features: p.features,
        valid: true,
    }))
}

/// Returns true if the current license includes the named feature.
#[tauri::command]
fn license_has_feature(feature: String, state: State<'_, AppState>) -> Result<bool, String> {
    let lic = state.license_info.lock().unwrap().clone();
    Ok(lic.map_or(false, |p| p.features.contains(&feature)))
}

/// Open a file dialog for a `.uixlicense` file and save it to the per-app data directory.
/// Validates that the JSON is parseable and `payload.appId` is non-empty.
/// If `app_id` is provided, rejects licenses for a different app.
/// Full signature + expiry verification happens in the subsequent `load_uix` call.
#[tauri::command]
async fn pick_and_install_license(
    app_id: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;

    let (tx, rx) = oneshot::channel();
    app.dialog()
        .file()
        .add_filter("UIX License", &["uixlicense"])
        .pick_file(move |p| { let _ = tx.send(p); });

    let path = rx
        .await
        .map_err(|_| "Dialog closed unexpectedly".to_string())?
        .ok_or_else(|| "No file selected".to_string())?;

    let data = std::fs::read_to_string(path.to_string())
        .map_err(|e| format!("Cannot read license file: {e}"))?;

    let parsed: serde_json::Value = serde_json::from_str(&data)
        .map_err(|e| format!("Invalid license file (not valid JSON): {e}"))?;

    let file_app_id = parsed
        .get("payload").and_then(|p| p.get("appId")).and_then(|v| v.as_str())
        .ok_or("License file is missing payload.appId")?
        .to_string();

    if file_app_id.is_empty() {
        return Err("License file has an empty appId".into());
    }

    if let Some(ref expected) = app_id {
        if &file_app_id != expected {
            return Err(format!(
                "This license is for app '{}', not '{}'.",
                file_app_id, expected
            ));
        }
    }

    let data_dir = app
        .path().app_data_dir()
        .map_err(|e| format!("Cannot get app data dir: {e}"))?.join(&file_app_id);
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    std::fs::write(data_dir.join("license.uixlicense"), data.as_bytes())
        .map_err(|e| format!("Cannot save license file: {e}"))?;

    Ok(())
}

/// Return the stable per-device UUID (creates it on first call).
/// App creators use this to issue device-bound licenses.
#[tauri::command]
fn get_device_id(app: AppHandle) -> String {
    ensure_global_device_id(&app)
}
// ---------------------------------------------------------------------------

/// Return value from state_import_bundle.
#[derive(serde::Serialize)]
struct ImportBundleResult {
    imported: u64,
    skipped: u64,
}

/// Export state records as a .uixdata JSON bundle string.
/// When `types` is non-empty only records of those types are included.
/// The bundle includes a SHA-256 checksum of the compact JSON records array,
/// matching the checksum produced by `dotuix export --output *.uixdata`.
#[tauri::command]
fn state_export_bundle(
    types: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;

    // 1. Collect records
    let records: Vec<Record> = match types.as_deref() {
        Some(ts) if !ts.is_empty() => {
            let mut all: Vec<Record> = Vec::new();
            for t in ts {
                let q = FindQuery { record_type: t.clone(), ..Default::default() };
                all.extend(query_records(conn, &q)?);
            }
            all
        }
        _ => {
            let mut stmt = conn
                .prepare(
                    "SELECT id, type, body, created_at, updated_at \
                     FROM records ORDER BY created_at",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(Record {
                        id: row.get(0)?,
                        r#type: row.get(1)?,
                        body: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        }
    };

    // 2. Checksum — must match CLI's sha256(JSON.stringify(records))
    let records_json = serde_json::to_string(&records).map_err(|e| e.to_string())?;
    let checksum = format!("sha256:{}", sha256_hex(records_json.as_bytes()));

    // 3. Unique types (in encounter order)
    let mut seen = std::collections::HashSet::new();
    let unique_types: Vec<&str> = records
        .iter()
        .filter(|r| seen.insert(r.r#type.as_str()))
        .map(|r| r.r#type.as_str())
        .collect();

    // 4. Metadata
    let app_id = state.app_id.lock().unwrap().clone();
    let schema_version = *state.stored_schema_version.lock().unwrap();
    let exported_at = {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        format_iso8601(secs)
    };

    // 5. Build bundle
    let bundle = serde_json::json!({
        "format": "uixdata/1.0",
        "appId": app_id,
        "schemaVersion": schema_version,
        "exportedAt": exported_at,
        "exportedBy": format!("dotuix-viewer/{VIEWER_VERSION}"),
        "checksum": checksum,
        "types": unique_types,
        "records": records,
    });
    serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())
}

/// Import a .uixdata bundle (JSON string) into state.db.
/// `merge = false` (default): existing records of matching types are deleted first.
/// `merge = true`: records whose ID already exists are skipped.
#[tauri::command]
fn state_import_bundle(
    bundle: String,
    merge: Option<bool>,
    state: State<'_, AppState>,
) -> Result<ImportBundleResult, String> {
    let merge = merge.unwrap_or(false);

    // 1. Parse + validate
    let parsed: serde_json::Value = serde_json::from_str(&bundle)
        .map_err(|e| format!("Invalid bundle JSON: {e}"))?;

    if parsed["format"].as_str() != Some("uixdata/1.0") {
        return Err(format!(
            "Unsupported bundle format: \"{}\"",
            parsed["format"].as_str().unwrap_or("(none)")
        ));
    }

    let records_arr = parsed["records"]
        .as_array()
        .ok_or("Bundle has no records array")?;

    // 2. Verify checksum via canonical re-serialisation through Record struct.
    //    This ensures the same field order as the CLI's JSON.stringify.
    if let Some(stored_checksum) = parsed["checksum"].as_str() {
        let recs: Vec<Record> =
            serde_json::from_value(serde_json::Value::Array(records_arr.clone()))
                .map_err(|e| format!("Invalid record shape in bundle: {e}"))?;
        let recs_json = serde_json::to_string(&recs).map_err(|e| e.to_string())?;
        let expected = format!("sha256:{}", sha256_hex(recs_json.as_bytes()));
        if stored_checksum != expected {
            return Err(
                "Checksum mismatch — bundle may be corrupted or tampered with".into(),
            );
        }
    }

    // 3. Deserialise records
    let records: Vec<Record> =
        serde_json::from_value(serde_json::Value::Array(records_arr.clone()))
            .map_err(|e| format!("Cannot deserialise bundle records: {e}"))?;

    // 4. Transactional import
    let db = state.state_db.lock().unwrap();
    let conn = db.as_ref().ok_or("No app loaded")?;

    conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;

    let result: Result<ImportBundleResult, String> = (|| {
        if !merge {
            let types: std::collections::HashSet<&str> =
                records.iter().map(|r| r.r#type.as_str()).collect();
            for t in &types {
                conn.execute("DELETE FROM records WHERE type = ?1", [*t])
                    .map_err(|e| e.to_string())?;
            }
        }

        let mut imported: u64 = 0;
        let mut skipped: u64 = 0;

        for rec in &records {
            if merge {
                let exists: bool = conn
                    .query_row(
                        "SELECT 1 FROM records WHERE id = ?1",
                        [&rec.id],
                        |_| Ok(true),
                    )
                    .unwrap_or(false);
                if exists {
                    skipped += 1;
                    continue;
                }
            }
            conn.execute(
                "INSERT OR IGNORE INTO records \
                 (id, type, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![rec.id, rec.r#type, rec.body, rec.created_at, rec.updated_at],
            )
            .map_err(|e| e.to_string())?;
            imported += 1;
        }

        Ok(ImportBundleResult { imported, skipped })
    })();

    match result {
        Ok(res) => {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(res)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Sync state.db records with a remote sync server (push local changes, pull remote changes).
/// Requires the "local-sync" permission and `sync.secret` in the manifest.
/// If `sync.endpoint` is absent, the viewer attempts LAN auto-discovery of Sync Hub.
/// Conflict resolution: last-write-wins on `updated_at`.
#[tauri::command]
async fn state_sync(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let started_at = now_ms();
    let observed_app_id = state.app_id.lock().unwrap().clone();

    let result: Result<serde_json::Value, String> = async {
    // ── 1. Permission check ────────────────────────────────────────────────
    {
        let perms = state.permissions.lock().unwrap();
        if !perms.contains(&"local-sync".to_string()) {
            return Err(
                "Permission denied: 'local-sync' not declared in manifest.json permissions.".into(),
            );
        }
    }

    // ── 2. Read sync config / auto-discover endpoint ───────────────────
    let app_id = state.app_id.lock().unwrap().clone();
    let configured_endpoint = state.sync_endpoint.lock().unwrap().clone();

    let endpoint = resolve_sync_endpoint(state.inner(), &app_id, configured_endpoint).await?;

    let sync_secret = state
        .sync_secret
        .lock()
        .unwrap()
        .clone()
        .ok_or("Sync not configured: 'sync.secret' missing from manifest.")?;

    let secret_bytes = decode_sync_secret(&sync_secret)?;
    if secret_bytes.len() < 32 {
        return Err("Sync not configured securely: 'sync.secret' must decode to at least 32 bytes.".into());
    }

    let last_sync_key = sync_last_sync_meta_key(&app_id, &endpoint);

    // ── 3. Collect push payload (lock held, no await) ────────────────────
    let (device_id, last_sync, push_records) = {
        let db = state.state_db.lock().unwrap();
        let conn = db.as_ref().ok_or("No app loaded")?;

        ensure_sync_clock_ms(conn)?;

        let device_id: String = conn
            .query_row("SELECT value FROM meta WHERE key = 'device_id'", [], |r| r.get(0))
            .map_err(|e| format!("Cannot read device_id: {e}"))?;

        let scoped_last_sync: Option<i64> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                [&last_sync_key],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .and_then(|s| s.parse::<i64>().ok());

        let legacy_last_sync: Option<i64> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'last_sync'",
                [],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .and_then(|s| s.parse::<i64>().ok());

        let last_sync = normalize_epoch_ms(scoped_last_sync.or(legacy_last_sync).unwrap_or(0));

        let mut stmt = conn
            .prepare(
                "SELECT id, type, body, created_at, updated_at \
                 FROM records WHERE updated_at > ?1",
            )
            .map_err(|e| e.to_string())?;

        let push_records: Vec<SyncWireRecord> = stmt
            .query_map([last_sync], |r| {
                Ok(SyncWireRecord {
                    id: r.get::<_, String>(0)?,
                    r#type: r.get::<_, String>(1)?,
                    body: r.get::<_, String>(2)?,
                    created_at: r.get::<_, i64>(3)?,
                    updated_at: r.get::<_, i64>(4)?,
                    deleted: false,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        (device_id, last_sync, normalize_and_sort_sync_records(push_records))
    }; // mutex released before await

    // ── 4. HTTP push + pull ───────────────────────────────────────────────
    let url = endpoint.clone();
    let sent_at = now_ms();
    let nonce = uuid::Uuid::new_v4().to_string();

    let string_to_sign = sync_request_string_to_sign(
        &app_id,
        &device_id,
        sent_at,
        last_sync,
        &nonce,
        &push_records,
    )?;

    let signature = hmac_sha256_base64url(&secret_bytes, &string_to_sign)?;

    let body = serde_json::json!({
        "syncVersion": 2,
        "appId": app_id,
        "deviceId": device_id,
        "sentAt": sent_at,
        "lastSync": last_sync,
        "nonce": nonce,
        "push": push_records,
        "auth": {
            "alg": "HS256",
            "sig": signature,
        },
    });

    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Sync request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let server_err: Option<serde_json::Value> = resp.json().await.ok();
        if let Some(payload) = server_err {
            let err_obj = payload.get("error").unwrap_or(&payload);
            let code = err_obj
                .get("code")
                .and_then(|v| v.as_str())
                .unwrap_or("sync.http_error");
            let message = err_obj
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Sync request failed");
            return Err(format!("Sync server returned HTTP {status} ({code}): {message}"));
        }
        return Err(format!("Sync server returned HTTP {status}"));
    }

    let result: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid sync response: {e}"))?;

    if result
        .get("syncVersion")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        != 2
    {
        return Err("Sync server returned an unsupported response format (expected protocol v2).".into());
    }

    // ── 5. Merge pulled records + persist last_sync ─────────────────────
    let response_nonce = result
        .get("nonce")
        .and_then(|v| v.as_str())
        .ok_or("Sync response missing nonce")?;

    let request_nonce = body
        .get("nonce")
        .and_then(|v| v.as_str())
        .ok_or("Sync request missing nonce")?;

    if response_nonce != request_nonce {
        return Err("Sync response nonce mismatch (possible replay or stale response).".into());
    }

    let pull = result
        .get("pull")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let pushed = result.get("pushed").and_then(|v| v.as_i64()).unwrap_or(0);
    let server_time = normalize_epoch_ms(
        result
            .get("serverTime")
            .and_then(|v| v.as_i64())
            .unwrap_or_else(now_ms),
    );

    let mut pulled_records: Vec<SyncWireRecord> = Vec::with_capacity(pull.len());
    for record in &pull {
        let id = record
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        if id.is_empty() {
            continue;
        }

        let rtype = record
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        let body = match record.get("body") {
            Some(v) if v.is_string() => v.as_str().unwrap_or("{}").to_string(),
            Some(v) => serde_json::to_string(v).unwrap_or_else(|_| "{}".to_string()),
            None => "{}".to_string(),
        };

        pulled_records.push(SyncWireRecord {
            id,
            r#type: rtype,
            body,
            created_at: record
                .get("created_at")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            updated_at: record
                .get("updated_at")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            deleted: record
                .get("deleted")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        });
    }

    let pulled_records = normalize_and_sort_sync_records(pulled_records);

    let response_sig = result
        .get("auth")
        .and_then(|v| v.get("sig"))
        .and_then(|v| v.as_str())
        .ok_or("Sync response missing auth.sig")?;

    let response_string_to_sign = sync_response_string_to_sign(
        body.get("appId")
            .and_then(|v| v.as_str())
            .ok_or("Sync request missing appId")?,
        body.get("deviceId")
            .and_then(|v| v.as_str())
            .ok_or("Sync request missing deviceId")?,
        server_time,
        pushed,
        response_nonce,
        &pulled_records,
    )?;

    let expected_response_sig = hmac_sha256_base64url(&secret_bytes, &response_string_to_sign)?;
    if response_sig != expected_response_sig {
        return Err("Sync response signature verification failed (payload integrity check failed).".into());
    }

    let pulled_count = pulled_records.len() as i64;

    {
        let db = state.state_db.lock().unwrap();
        let conn = db.as_ref().ok_or("No app loaded")?;

        for record in &pulled_records {
            let id = record.id.as_str();
            let rtype = record.r#type.as_str();
            let body = record.body.as_str();
            let created_at = record.created_at;
            let updated_at = record.updated_at;
            let deleted = record.deleted;

            if deleted {
                conn.execute("DELETE FROM records WHERE id = ?1", [id])
                    .map_err(|e| e.to_string())?;
            } else {
                conn.execute(
                    "INSERT INTO records (id, type, body, created_at, updated_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5) \
                     ON CONFLICT (id) DO UPDATE SET \
                       type       = CASE WHEN excluded.updated_at > updated_at THEN excluded.type       ELSE type       END, \
                       body       = CASE WHEN excluded.updated_at > updated_at THEN excluded.body       ELSE body       END, \
                       updated_at = CASE WHEN excluded.updated_at > updated_at THEN excluded.updated_at ELSE updated_at END",
                    rusqlite::params![id, rtype, body, created_at, updated_at],
                )
                .map_err(|e| e.to_string())?;
            }
        }

        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) \
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            rusqlite::params![last_sync_key, server_time.to_string()],
        )
        .map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('last_sync', ?1) \
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            [&server_time.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }

    Ok(serde_json::json!({
        "pushed": pushed,
        "pulled": pulled_count,
        "serverTime": server_time,
    }))
    }
    .await;

    match result {
        Ok(payload) => {
            let pushed = payload
                .get("pushed")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let pulled = payload
                .get("pulled")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let server_time = payload
                .get("serverTime")
                .and_then(|v| v.as_i64())
                .unwrap_or_else(now_ms);

            emit_desktop_event(
                "desktop.sync.request_succeeded",
                "info",
                Some(observed_app_id.as_str()),
                None,
                Some(serde_json::json!({
                    "durationMs": now_ms() - started_at,
                    "pushed": pushed,
                    "pulled": pulled,
                    "serverTime": server_time,
                })),
            );

            Ok(payload)
        }
        Err(error) => {
            emit_desktop_event(
                "desktop.sync.request_failed",
                "warn",
                Some(observed_app_id.as_str()),
                Some(error.as_str()),
                Some(serde_json::json!({
                    "durationMs": now_ms() - started_at,
                })),
            );

            Err(error)
        }
    }
}

/// Bridge-accessible fullscreen controls — all require the "fullscreen" permission.
#[tauri::command]
async fn uix_enter_fullscreen(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let perms = state.permissions.lock().unwrap();
        if !perms.contains(&"fullscreen".to_string()) {
            return Err("Permission denied: 'fullscreen' not declared in manifest.json permissions.".into());
        }
    }
    window.set_fullscreen(true).map_err(|e| e.to_string())
}

#[tauri::command]
async fn uix_exit_fullscreen(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let perms = state.permissions.lock().unwrap();
        if !perms.contains(&"fullscreen".to_string()) {
            return Err("Permission denied: 'fullscreen' not declared in manifest.json permissions.".into());
        }
    }
    window.set_fullscreen(false).map_err(|e| e.to_string())
}

#[tauri::command]
async fn uix_toggle_fullscreen(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let perms = state.permissions.lock().unwrap();
        if !perms.contains(&"fullscreen".to_string()) {
            return Err("Permission denied: 'fullscreen' not declared in manifest.json permissions.".into());
        }
    }
    let is_full = window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(!is_full).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Phase 3 additions: file.save, file.open, browser.open, window.setTitle
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct FileResult {
    name: String,
    content_b64: String,
}

/// Save bytes (base64-encoded) to a user-chosen path via the OS save dialog.
/// Requires the `"file-save"` permission.
#[tauri::command]
fn uix_save_file(
    filename: String,
    content_b64: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    {
        let perms = state.permissions.lock().unwrap();
        if !perms.contains(&"file-save".to_string()) {
            return Err("Permission denied: 'file-save' not declared in manifest.json permissions.".into());
        }
    }
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&content_b64)
        .map_err(|e| format!("Invalid base64 content: {e}"))?;
    use tauri_plugin_dialog::DialogExt;
    let result = app.dialog().file().set_file_name(&filename).blocking_save_file();
    match result {
        None => Ok(false),
        Some(p) => {
            std::fs::write(std::path::PathBuf::from(p.to_string()), &bytes)
                .map_err(|e| e.to_string())?;
            Ok(true)
        }
    }
}

/// Open a user-chosen file and return its contents as base64.
/// Requires the `"file-open"` permission.
#[tauri::command]
fn uix_open_file(
    filter: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<FileResult>, String> {
    {
        let perms = state.permissions.lock().unwrap();
        if !perms.contains(&"file-open".to_string()) {
            return Err("Permission denied: 'file-open' not declared in manifest.json permissions.".into());
        }
    }
    use base64::Engine as _;
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file();
    if let Some(ref ext) = filter {
        dialog = dialog.add_filter("File", &[ext.as_str()]);
    }
    let result = dialog.blocking_pick_file();
    match result {
        None => Ok(None),
        Some(p) => {
            let path_buf = std::path::PathBuf::from(p.to_string());
            let name = path_buf.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("file")
                .to_string();
            let bytes = std::fs::read(&path_buf).map_err(|e| e.to_string())?;
            let content_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            Ok(Some(FileResult { name, content_b64 }))
        }
    }
}

/// Open a URL in the OS default browser.
/// Only `https://` and `http://` schemes are allowed.
/// Requires the `"open-url"` permission.
#[tauri::command]
fn uix_open_url(url: String, state: State<'_, AppState>) -> Result<(), String> {
    {
        let perms = state.permissions.lock().unwrap();
        if !perms.contains(&"open-url".to_string()) {
            return Err("Permission denied: 'open-url' not declared in manifest.json permissions.".into());
        }
    }
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("uix.browser.open: only https:// and http:// URLs are permitted.".into());
    }
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(&url).status().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open").arg(&url).status().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd").args(["/C", "start", "", &url]).status().map_err(|e| e.to_string())?;
    Ok(())
}

/// Set the OS window title. The app name is always prepended to prevent misleading titles.
#[tauri::command]
fn uix_set_window_title(
    title: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let app_name = state.app_name.lock().unwrap().clone();
    let full_title = if app_name.is_empty() {
        title
    } else {
        format!("{app_name} \u{2014} {title}")
    };
    window.set_title(&full_title).map_err(|e| e.to_string())
}

/// Fire a native OS desktop notification.
/// Requires the `"notifications"` permission.
#[tauri::command]
fn uix_notify(
    title: String,
    body: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    {
        let perms = state.permissions.lock().unwrap();
        if !perms.contains(&"notifications".to_string()) {
            return Err("Permission denied: 'notifications' not declared in manifest.json permissions.".into());
        }
    }
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct DbLoadResult {
    exists: bool,
    records: Vec<Record>,
}

// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct DbPaths {
    state_path: Option<String>,
    data_path: Option<String>,
}

#[tauri::command]
fn get_db_paths(state: State<AppState>) -> DbPaths {
    DbPaths {
        state_path: state.state_db_path.lock().unwrap()
            .as_ref().map(|p| p.to_string_lossy().into_owned()),
        data_path: state.data_db_path.lock().unwrap()
            .as_ref().map(|p| p.to_string_lossy().into_owned()),
    }
}

// ---------------------------------------------------------------------------
// DB viewer commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn db_load_all(db_path: String) -> Result<DbLoadResult, String> {
    if !std::path::Path::new(&db_path).exists() {
        return Ok(DbLoadResult { exists: false, records: vec![] });
    }
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, type, body, created_at, updated_at \
             FROM records ORDER BY type, created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let records = stmt
        .query_map([], |row| {
            Ok(Record {
                id: row.get(0)?,
                r#type: row.get(1)?,
                body: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(DbLoadResult { exists: true, records })
}

#[tauri::command]
fn db_update_record(db_path: String, id: String, body: String) -> Result<(), String> {
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
    let now = now_ms();
    conn.execute(
        "UPDATE records SET body = ?1, updated_at = ?2 WHERE id = ?3",
        rusqlite::params![body, now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_delete_record(db_path: String, id: String) -> Result<(), String> {
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM records WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn db_insert_record(db_path: String, r#type: String, body: String) -> Result<Record, String> {
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS records (\
            id TEXT PRIMARY KEY, \
            type TEXT NOT NULL, \
            body TEXT NOT NULL, \
            created_at INTEGER NOT NULL, \
            updated_at INTEGER NOT NULL\
        );\
        CREATE INDEX IF NOT EXISTS records_type_idx ON records(type);",
    )
    .map_err(|e| e.to_string())?;
    let id = format!("{}:{}", r#type, gen_id());
    let now = now_ms();
    conn.execute(
        "INSERT INTO records (id, type, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
        rusqlite::params![id, r#type, body, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(Record { id, r#type, body, created_at: now, updated_at: now })
}

// ---------------------------------------------------------------------------

#[tauri::command]
async fn toggle_fullscreen(window: tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // On some Windows + WebView2 setups, true fullscreen can overshoot monitor
        // bounds. Use maximize toggle as a safer kiosk-like full-view behavior.
        if window.is_fullscreen().map_err(|e| e.to_string())? {
            window.set_fullscreen(false).map_err(|e| e.to_string())?;
        }
        let is_maximized = window.is_maximized().map_err(|e| e.to_string())?;
        if is_maximized {
            window.unmaximize().map_err(|e| e.to_string())?;
        } else {
            window.maximize().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let is_full = window.is_fullscreen().map_err(|e| e.to_string())?;
        return window.set_fullscreen(!is_full).map_err(|e| e.to_string());
    }
}

// ---------------------------------------------------------------------------

pub fn run() {
    let app_state = AppState::default();
    // Clone the Arcs so protocol closures can access state without going
    // through Tauri State (UriSchemeContext has no .state() method).
    let protocol_files = Arc::clone(&app_state.files);
    let protocol_schema_version = Arc::clone(&app_state.stored_schema_version);
    let protocol_csp = Arc::clone(&app_state.content_security_policy);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .setup(|app| {
            // --- File association: handle .uix path passed as a CLI argument ---
            // On Windows/Linux, double-clicking a .uix sends it as argv[1].
            // On macOS, the deep-link plugin is needed; argv works in dev mode.
            let mut seen = HashSet::<String>::new();
            let launch_paths: Vec<String> = std::env::args()
                .skip(1)
                .filter(|p| p.to_ascii_lowercase().ends_with(".uix"))
                .map(|p| canonical_uix_path(&p))
                .filter(|p| seen.insert(p.clone()))
                .collect();

            if let Some(normalized_path) = launch_paths.first().cloned() {
                if let Some(owner_pid) = running_lock_owner(&normalized_path) {
                    if owner_pid != std::process::id() && focus_process_by_pid(owner_pid) {
                        app.handle().exit(0);
                        return Ok(());
                    }
                }
                *app.state::<AppState>().initial_path.lock().unwrap() = Some(normalized_path);

                for path in launch_paths.into_iter().skip(1) {
                    let _ = open_uix_in_new_process(path);
                }
            }

            // --- Window refs ---
            let main_window = app.get_webview_window("main").expect("main window must exist");
            let win_for_menu = main_window.clone();
            let handle = app.handle().clone();

            // --- Cleanup on window destroy: repack state.db into .uix + delete lock ---
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::Destroyed = event {
                    let state = handle.state::<AppState>();
                    let uix_path = state.uix_path.lock().unwrap().clone();
                    if uix_path.is_empty() {
                        clear_temp_web_root(&state);
                        clear_temp_data_db(&state);
                        return;
                    }

                    let state_db_path = state.state_db_path.lock().unwrap().clone();
                    let state_mode = state.state_mode.lock().unwrap().clone();

                    // Drop DB connections before touching the files (important for WAL mode).
                    { let _ = state.state_db.lock().unwrap().take(); }
                    { let _ = state.data_db.lock().unwrap().take(); }
                    clear_temp_data_db(&state);

                    // Repack state.db back into the .uix file so state travels with it.
                    // Skipped when state.mode is "device" — archive must stay clean.
                    if state_mode != "device" {
                        if let Some(db_path) = state_db_path {
                            if db_path.exists() {
                                if let Err(e) = repack_uix(&uix_path, &db_path) {
                                    eprintln!("dotuix-viewer: repack failed: {e}");
                                    // The .tmp file (if created) is the recovery path.
                                }
                                // SM-6: warn if state.db exceeds 50 MB after repacking.
                                if let Ok(meta) = std::fs::metadata(&db_path) {
                                    if meta.len() > 50 * 1024 * 1024 {
                                        let _ = handle.emit("state-db-large", serde_json::json!({
                                            "bytes": meta.len(),
                                            "mb": meta.len() / (1024 * 1024)
                                        }));
                                    }
                                }
                            }
                        }
                    }

                    // Always delete the lock file, even if repack failed.
                    let _ = std::fs::remove_file(format!("{uix_path}.lock"));
                    clear_temp_web_root(&state);
                    clear_temp_data_db(&state);
                }
            });

            // --- App menu ---
            use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
            let open_m  = MenuItemBuilder::with_id("open_file", "Open\u{2026}").accelerator("CmdOrCtrl+O").build(app)?;
            let close_m = MenuItemBuilder::with_id("close_app", "Close File").accelerator("CmdOrCtrl+W").build(app)?;
            let about_m = MenuItemBuilder::with_id("about_viewer", "About dotuix Viewer").build(app)?;
            let undo_m  = MenuItemBuilder::with_id("undo", "Undo").accelerator("CmdOrCtrl+Z").build(app)?;
            let redo_m  = MenuItemBuilder::with_id("redo", "Redo").accelerator("CmdOrCtrl+Shift+Z").build(app)?;
            let cut_m   = MenuItemBuilder::with_id("cut", "Cut").accelerator("CmdOrCtrl+X").build(app)?;
            let copy_m  = MenuItemBuilder::with_id("copy", "Copy").accelerator("CmdOrCtrl+C").build(app)?;
            let paste_m = MenuItemBuilder::with_id("paste", "Paste").accelerator("CmdOrCtrl+V").build(app)?;
            let selall_m = MenuItemBuilder::with_id("select_all", "Select All").accelerator("CmdOrCtrl+A").build(app)?;
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&open_m).separator().item(&close_m).separator().quit().build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&undo_m).item(&redo_m).separator()
                .item(&cut_m).item(&copy_m).item(&paste_m).separator()
                .item(&selall_m).build()?;
            let help_menu = SubmenuBuilder::new(app, "Help").item(&about_m).build()?;
            let menu = MenuBuilder::new(app)
                .item(&file_menu)
                .item(&edit_menu)
                .item(&help_menu)
                .build()?;
            app.set_menu(menu)?;

            let viewer_version = app.package_info().version.to_string();

            app.on_menu_event(move |_app, event| {
                match event.id().as_ref() {
                    "open_file"         => { win_for_menu.emit("menu-open-file", ()).ok(); }
                    "close_app"         => { win_for_menu.emit("menu-close-app", ()).ok(); }
                    "about_viewer"      => {
                        let payload = serde_json::json!({
                            "name": "dotuix Viewer",
                            "version": viewer_version.clone(),
                        });
                        win_for_menu.emit("menu-about-viewer", payload).ok();
                    }
                    _ => {}
                }
            });

            Ok(())
        })
        .register_uri_scheme_protocol("uix", move |_ctx, req: Request<Vec<u8>>| {
            if req.method() == Method::OPTIONS {
                return Response::builder()
                    .status(204)
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                    .header("Access-Control-Allow-Headers", "*")
                    .header("Access-Control-Max-Age", "86400")
                    .body(Vec::new())
                    .unwrap();
            }

            let path = normalize_protocol_request_path(req.uri().path());

            let map = protocol_files.lock().unwrap();

            match protocol_get_file(&map, &path) {
                Some(data) => {
                    let mime = mime_for(&path);
                    let is_html = mime.starts_with("text/html");
                    let body = if is_html {
                        let manifest_json = protocol_get_file(&map, "manifest.json")
                            .map(|b| String::from_utf8_lossy(b).into_owned())
                            .unwrap_or_else(|| "{}".to_string());
                        let stored_v = *protocol_schema_version.lock().unwrap();
                        html_with_injected_bridge(data, &manifest_json, stored_v)
                    } else {
                        data.to_vec()
                    };

                    let mut response = Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                        .header("Access-Control-Allow-Headers", "*")
                        .header("Cross-Origin-Resource-Policy", "cross-origin");

                    if is_html {
                        let csp = protocol_csp.lock().unwrap().clone();
                        response = response.header("Content-Security-Policy", csp);
                    }

                    response.body(body).unwrap()
                }
                None => Response::builder()
                    .status(404)
                    .header("Content-Type", "text/plain")
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
                    .header("Access-Control-Allow-Headers", "*")
                    .header("Cross-Origin-Resource-Policy", "cross-origin")
                    .body(format!("Not found: {}", path).into_bytes())
                    .unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            pick_and_load_uix,
            pick_uix_path,
            load_uix,
            open_uix_in_new_process,
            focus_main_window,
            close_uix,
            unlock_with_pin,
            get_initial_file,
            get_manifest,
            prepare_iframe_fallback_entry,
            uix_exit,
            data_find,
            data_get,
            data_raw,
            state_find,
            state_get,
            state_insert,
            state_update,
            state_delete,
            state_purge,
            state_raw,
            data_count,
            state_count,
            state_transaction,
            state_clear,
            state_reset,
            state_upsert,
            state_insert_many,
            state_size,
            state_vacuum,
            schema_version_set,
            schema_upgrade_begin,
            schema_upgrade_commit,
            schema_upgrade_rollback,
            state_export_bundle,
            state_import_bundle,
            state_sync,
            uix_enter_fullscreen,
            uix_exit_fullscreen,
            uix_toggle_fullscreen,
            uix_save_file,
            uix_open_file,
            uix_open_url,
            uix_set_window_title,
            uix_notify,
            get_db_paths,
            db_load_all,
            db_update_record,
            db_delete_record,
            db_insert_record,
            toggle_fullscreen,
            license_get,
            license_has_feature,
            pick_and_install_license,
            get_device_id,
        ])
.build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS: handle file-association opens (Apple Events / NSApplicationDelegate).
            // Double-clicking a .uix file does NOT pass it as argv[1] on macOS —
            // the OS delivers it via RunEvent::Opened (NSApplicationDelegate openURLs:).
            #[cfg(target_os = "macos")]
            {
                if let tauri::RunEvent::Opened { urls } = event {
                    let paths: Vec<String> = urls
                        .iter()
                        .filter_map(|u| u.to_file_path().ok())
                        .filter(|p| p.extension().map(|e| e == "uix").unwrap_or(false))
                        .filter_map(|p| p.to_str().map(canonical_uix_path))
                        .collect();
                    if let Some(path) = paths.first().cloned() {
                        let state = app.state::<AppState>();
                        let current_path = state.uix_path.lock().unwrap().clone();
                        let current_path = if current_path.is_empty() {
                            current_path
                        } else {
                            canonical_uix_path(&current_path)
                        };
                        let already_open_here = !current_path.is_empty() && current_path == path;

                        if already_open_here {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                            return;
                        }

                        if let Some(owner_pid) = running_lock_owner(&path) {
                            if owner_pid != std::process::id() && focus_process_by_pid(owner_pid) {
                                return;
                            }
                        }

                        // If this window already has another file open, keep it untouched
                        // and open the newly requested app in a separate viewer process.
                        if !current_path.is_empty() {
                            let _ = open_uix_in_new_process(path);
                            return;
                        }

                        // Store so get_initial_file() picks it up on frontend mount
                        *state.initial_path.lock().unwrap() = Some(path.clone());
                        // Also emit for the case where the window is already loaded
                        if let Some(win) = app.get_webview_window("main") {
                            win.emit("uix-file-opened", &path).ok();
                        }
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

// =============================================================================
// Unit tests
// =============================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    // ── Helpers ──────────────────────────────────────────────────────────────

    fn filters(pairs: &[(&str, serde_json::Value)]) -> HashMap<String, serde_json::Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn manifest_network_defaults_to_blocked() {
        let manifest = json!({});
        let csp = csp_for_manifest(&manifest);

        assert!(!network_allowed(&manifest));
        assert!(csp.contains("connect-src 'self' uix:"));
        assert!(!csp.contains("connect-src 'self' uix: https:"));
        assert!(csp.contains("form-action 'none'"));
        assert!(!csp.contains("frame-ancestors"));
    }

    #[test]
    fn signature_payload_matches_core_no_trailing_newline() {
        use base64::Engine;
        use ed25519_dalek::{Signer, SigningKey};

        let seed: [u8; 32] = [7u8; 32];
        let sk = SigningKey::from_bytes(&seed);
        let vk_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(sk.verifying_key().to_bytes());

        let mut files: HashMap<String, Vec<u8>> = HashMap::new();
        files.insert("index.html".into(), b"<html></html>".to_vec());
        files.insert("app.js".into(), b"console.log(1)".to_vec());
        files.insert("state.db".into(), b"IGNORED".to_vec()); // excluded from digest
        files.insert("manifest.json".into(), b"{}".to_vec()); // excluded from digest

        let mut manifest = json!({
            "uix": "1.0", "id": "com.example.app", "name": "App",
            "version": "1.0.0", "entry": "index.html", "mode": "window"
        });

        // Rebuild the canonical manifest exactly as verify_signature does.
        let mut m2 = manifest.clone();
        m2.as_object_mut().unwrap().remove("signature");
        let manifest_canon = serde_json::to_string(&sort_json_keys(m2)).unwrap();

        let mut paths: Vec<&str> = files
            .keys()
            .filter(|p| *p != "manifest.json" && *p != "state.db")
            .map(String::as_str)
            .collect();
        paths.sort_unstable();

        // @dotuix/core format: lines joined with "\n", NO trailing newline.
        let mut lines = vec![
            "DOTUIX-SIGN-V1".to_string(),
            format!("manifest:{manifest_canon}"),
        ];
        for p in &paths {
            lines.push(format!("file:{p}:{}", sha256_hex(&files[*p])));
        }
        let core_payload = lines.join("\n");

        let sig = sk.sign(core_payload.as_bytes());
        let sig_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes());
        manifest.as_object_mut().unwrap().insert(
            "signature".into(),
            json!({
                "algorithm": "Ed25519", "publicKey": vk_b64, "value": sig_b64,
                "signedAt": "2026-01-01T00:00:00Z"
            }),
        );

        // A core/CLI-signed package MUST verify on desktop.
        assert!(verify_signature(&files, &manifest).is_ok());

        // Regression guard: the old trailing-newline payload must NOT verify.
        let legacy_payload = format!("{core_payload}\n");
        let bad_sig = sk.sign(legacy_payload.as_bytes());
        let bad_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bad_sig.to_bytes());
        manifest.as_object_mut().unwrap()["signature"]
            .as_object_mut()
            .unwrap()
            .insert("value".into(), json!(bad_b64));
        assert!(verify_signature(&files, &manifest).is_err());
    }

    #[test]
    fn manifest_network_allowed_enables_https_connects() {
        let manifest = json!({ "network": "allowed" });
        let csp = csp_for_manifest(&manifest);

        assert!(network_allowed(&manifest));
        assert!(csp.contains("connect-src 'self' uix: https: wss:"));
        assert!(csp.contains("worker-src 'self' uix: blob: https:"));
        assert!(csp.contains("form-action 'none'"));
        assert!(!csp.contains("frame-ancestors"));
    }

    #[test]
    fn sync_records_are_normalized_and_sorted_for_signing() {
        let records = vec![
            SyncWireRecord {
                id: "b:1".to_string(),
                r#type: "order".to_string(),
                body: "{}".to_string(),
                created_at: 1_760_000_000,
                updated_at: 1_760_000_010,
                deleted: false,
            },
            SyncWireRecord {
                id: "a:1".to_string(),
                r#type: "order".to_string(),
                body: "{}".to_string(),
                created_at: 1_760_000_020,
                updated_at: 1_760_000_030,
                deleted: false,
            },
        ];

        let normalized = normalize_and_sort_sync_records(records);
        assert_eq!(normalized[0].id, "a:1");
        assert_eq!(normalized[1].id, "b:1");
        assert_eq!(normalized[0].created_at, 1_760_000_020_000);
        assert_eq!(normalized[1].updated_at, 1_760_000_010_000);
    }

    #[test]
    fn sync_signature_changes_when_request_payload_changes() {
        let secret = vec![42u8; 32];
        let push = normalize_and_sort_sync_records(vec![SyncWireRecord {
            id: "order:1".to_string(),
            r#type: "order".to_string(),
            body: r#"{"status":"open"}"#.to_string(),
            created_at: 1_760_000_000_000,
            updated_at: 1_760_000_000_100,
            deleted: false,
        }]);

        let sig_a = hmac_sha256_base64url(
            &secret,
            &sync_request_string_to_sign(
                "com.example.pos",
                "device-1",
                1_760_000_000_123,
                1_760_000_000_000,
                "nonce-a",
                &push,
            )
            .unwrap(),
        )
        .unwrap();

        let sig_b = hmac_sha256_base64url(
            &secret,
            &sync_request_string_to_sign(
                "com.example.pos",
                "device-1",
                1_760_000_000_123,
                1_760_000_000_000,
                "nonce-b",
                &push,
            )
            .unwrap(),
        )
        .unwrap();

        assert_ne!(sig_a, sig_b);
    }

    #[test]
    fn sync_response_signature_detects_tampered_pull() {
        let secret = vec![7u8; 32];

        let expected_pull = normalize_and_sort_sync_records(vec![SyncWireRecord {
            id: "order:1".to_string(),
            r#type: "order".to_string(),
            body: r#"{"status":"ready"}"#.to_string(),
            created_at: 1_760_000_000_000,
            updated_at: 1_760_000_000_200,
            deleted: false,
        }]);

        let tampered_pull = normalize_and_sort_sync_records(vec![SyncWireRecord {
            id: "order:1".to_string(),
            r#type: "order".to_string(),
            body: r#"{"status":"cancelled"}"#.to_string(),
            created_at: 1_760_000_000_000,
            updated_at: 1_760_000_000_200,
            deleted: false,
        }]);

        let expected_sig = hmac_sha256_base64url(
            &secret,
            &sync_response_string_to_sign(
                "com.example.pos",
                "device-1",
                1_760_000_000_250,
                1,
                "nonce-a",
                &expected_pull,
            )
            .unwrap(),
        )
        .unwrap();

        let tampered_sig = hmac_sha256_base64url(
            &secret,
            &sync_response_string_to_sign(
                "com.example.pos",
                "device-1",
                1_760_000_000_250,
                1,
                "nonce-a",
                &tampered_pull,
            )
            .unwrap(),
        )
        .unwrap();

        assert_ne!(expected_sig, tampered_sig);
    }

    #[test]
    fn sync_last_sync_key_is_endpoint_scoped() {
        let k1 = sync_last_sync_meta_key("com.example.pos", "http://192.168.1.10:8787");
        let k2 = sync_last_sync_meta_key("com.example.pos", "http://192.168.1.11:8787");
        assert_ne!(k1, k2);
    }

    #[test]
    fn sync_endpoint_normalization_accepts_base_or_full_sync_path() {
        assert_eq!(
            normalize_sync_endpoint("http://192.168.1.20:3131"),
            Some("http://192.168.1.20:3131/sync".to_string())
        );
        assert_eq!(
            normalize_sync_endpoint("http://192.168.1.20:3131/sync"),
            Some("http://192.168.1.20:3131/sync".to_string())
        );
        assert_eq!(
            normalize_sync_endpoint("http://192.168.1.20:3131/sync/"),
            Some("http://192.168.1.20:3131/sync".to_string())
        );
        assert_eq!(normalize_sync_endpoint("192.168.1.20:3131"), None);
    }

    // ── order_term ────────────────────────────────────────────────────────────

    #[test]
    fn order_term_string_shorthand_is_body_asc() {
        assert_eq!(
            order_term(&json!("price")).unwrap(),
            "json_extract(body, '$.price') ASC"
        );
    }

    #[test]
    fn order_term_builtin_columns_bypass_json_extract() {
        for col in &["id", "type", "created_at", "updated_at"] {
            assert_eq!(
                order_term(&json!(col)).unwrap(),
                format!("{col} ASC"),
                "failed for column '{col}'"
            );
        }
    }

    #[test]
    fn order_term_object_asc() {
        assert_eq!(
            order_term(&json!({ "field": "sort", "direction": "asc" })).unwrap(),
            "json_extract(body, '$.sort') ASC"
        );
    }

    #[test]
    fn order_term_object_desc() {
        assert_eq!(
            order_term(&json!({ "field": "price", "direction": "desc" })).unwrap(),
            "json_extract(body, '$.price') DESC"
        );
    }

    #[test]
    fn order_term_direction_is_case_insensitive() {
        assert_eq!(
            order_term(&json!({ "field": "price", "direction": "DESC" })).unwrap(),
            "json_extract(body, '$.price') DESC"
        );
    }

    #[test]
    fn order_term_missing_direction_defaults_to_asc() {
        assert_eq!(
            order_term(&json!({ "field": "name" })).unwrap(),
            "json_extract(body, '$.name') ASC"
        );
    }

    #[test]
    fn order_term_builtin_column_with_desc() {
        assert_eq!(
            order_term(&json!({ "field": "created_at", "direction": "desc" })).unwrap(),
            "created_at DESC"
        );
    }

    #[test]
    fn order_term_non_string_non_object_falls_back_to_created_at_asc() {
        assert_eq!(order_term(&json!(42)).unwrap(), "created_at ASC");
        assert_eq!(order_term(&json!(null)).unwrap(), "created_at ASC");
    }

    // ── build_where_clause ────────────────────────────────────────────────────

    #[test]
    fn where_empty_filters_returns_nothing() {
        let (conds, params) = build_where_clause(&HashMap::new()).unwrap();
        assert!(conds.is_empty());
        assert_eq!(params.len(), 0);
    }

    #[test]
    fn where_scalar_shorthand_is_equality() {
        let (conds, params) =
            build_where_clause(&filters(&[("category", json!("burgers"))])).unwrap();
        assert_eq!(conds, ["json_extract(body, '$.category') = ?2"]);
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn where_eq_operator() {
        let (conds, params) =
            build_where_clause(&filters(&[("status", json!({ "eq": "active" }))])).unwrap();
        assert_eq!(conds, ["json_extract(body, '$.status') = ?2"]);
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn where_neq_operator() {
        let (conds, params) =
            build_where_clause(&filters(&[("status", json!({ "neq": "archived" }))])).unwrap();
        assert_eq!(conds, ["json_extract(body, '$.status') != ?2"]);
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn where_gt_operator() {
        let (conds, params) =
            build_where_clause(&filters(&[("price", json!({ "gt": 10 }))])).unwrap();
        assert_eq!(conds, ["json_extract(body, '$.price') > ?2"]);
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn where_gte_operator() {
        let (conds, params) =
            build_where_clause(&filters(&[("price", json!({ "gte": 10 }))])).unwrap();
        assert_eq!(conds, ["json_extract(body, '$.price') >= ?2"]);
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn where_lt_operator() {
        let (conds, params) =
            build_where_clause(&filters(&[("qty", json!({ "lt": 5 }))])).unwrap();
        assert_eq!(conds, ["json_extract(body, '$.qty') < ?2"]);
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn where_lte_operator() {
        let (conds, params) =
            build_where_clause(&filters(&[("qty", json!({ "lte": 5 }))])).unwrap();
        assert_eq!(conds, ["json_extract(body, '$.qty') <= ?2"]);
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn where_like_operator() {
        let (conds, params) =
            build_where_clause(&filters(&[("name", json!({ "like": "%burger%" }))])).unwrap();
        assert_eq!(conds, ["json_extract(body, '$.name') LIKE ?2"]);
        assert_eq!(params.len(), 1);
    }

    #[test]
    fn where_in_operator_binds_all_items() {
        let (conds, params) =
            build_where_clause(&filters(&[("cat", json!({ "in": ["a", "b", "c"] }))])).unwrap();
        assert_eq!(conds, ["json_extract(body, '$.cat') IN (?2, ?3, ?4)"]);
        assert_eq!(params.len(), 3);
    }

    #[test]
    fn where_in_empty_array_produces_always_false() {
        let (conds, params) =
            build_where_clause(&filters(&[("cat", json!({ "in": [] }))])).unwrap();
        assert_eq!(conds, ["1 = 0"]);
        assert_eq!(params.len(), 0);
    }

    #[test]
    fn where_is_null_true_is_null() {
        let (conds, params) =
            build_where_clause(&filters(&[("archived", json!({ "is_null": true }))])).unwrap();
        assert_eq!(conds, ["json_extract(body, '$.archived') IS NULL"]);
        assert_eq!(params.len(), 0);
    }

    #[test]
    fn where_is_null_false_is_not_null() {
        let (conds, params) =
            build_where_clause(&filters(&[("archived", json!({ "is_null": false }))])).unwrap();
        assert_eq!(conds, ["json_extract(body, '$.archived') IS NOT NULL"]);
        assert_eq!(params.len(), 0);
    }

    #[test]
    fn where_unknown_operator_returns_error_mentioning_it() {
        let result = build_where_clause(&filters(&[("f", json!({ "regex": ".*" }))]));
        assert!(result.is_err());
        let err = result.err().unwrap();
        assert!(err.contains("regex"), "expected 'regex' in error: {err}");
    }

    #[test]
    fn where_in_non_array_operand_returns_error() {
        let result = build_where_clause(&filters(&[("f", json!({ "in": "not-array" }))]));
        assert!(result.is_err());
    }

    #[test]
    fn where_invalid_identifier_is_rejected() {
        let result = build_where_clause(&filters(&[("field;drop", json!("value"))]));
        assert!(result.is_err());
        let err = result.err().unwrap();
        assert!(err.contains("field;drop"), "expected field name in error: {err}");
    }
}
