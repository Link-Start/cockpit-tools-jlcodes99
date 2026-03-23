use crate::modules::{account, codex_account};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

const TASKS_FILE: &str = "codex_wakeup_tasks.json";
const HISTORY_FILE: &str = "codex_wakeup_history.json";
const MAX_HISTORY_ITEMS: usize = 300;
pub const DEFAULT_PROMPT: &str = "hi";
pub const PROGRESS_EVENT: &str = "codex://wakeup-progress";

static TASKS_LOCK: std::sync::LazyLock<Mutex<()>> = std::sync::LazyLock::new(|| Mutex::new(()));
static HISTORY_LOCK: std::sync::LazyLock<Mutex<()>> = std::sync::LazyLock::new(|| Mutex::new(()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCliInstallHint {
    pub label: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCliStatus {
    pub available: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub source: Option<String>,
    pub message: Option<String>,
    pub checked_at: i64,
    pub install_hints: Vec<CodexCliInstallHint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexWakeupSchedule {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub daily_time: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub weekly_days: Vec<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekly_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval_hours: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexWakeupTask {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub account_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    pub schedule: CodexWakeupSchedule,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_success_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_failure_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexWakeupState {
    pub enabled: bool,
    #[serde(default)]
    pub tasks: Vec<CodexWakeupTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexQuotaSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hourly_percentage: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hourly_reset_time: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekly_percentage: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekly_reset_time: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexWakeupHistoryItem {
    pub id: String,
    pub run_id: String,
    pub timestamp: i64,
    pub trigger_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_name: Option<String>,
    pub account_id: String,
    pub account_email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_context_text: Option<String>,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_refresh_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_before: Option<CodexQuotaSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quota_after: Option<CodexQuotaSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexWakeupBatchResult {
    pub run_id: String,
    pub runtime: CodexCliStatus,
    pub records: Vec<CodexWakeupHistoryItem>,
    pub success_count: usize,
    pub failure_count: usize,
}

#[derive(Debug, Clone)]
pub struct TaskRunContext {
    pub trigger_type: String,
    pub task_id: Option<String>,
    pub task_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexWakeupProgressPayload {
    pub run_id: String,
    pub trigger_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_name: Option<String>,
    pub total: usize,
    pub completed: usize,
    pub success_count: usize,
    pub failure_count: usize,
    pub running: bool,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<CodexWakeupHistoryItem>,
}

#[derive(Debug, Clone)]
struct ResolvedBinary {
    path: PathBuf,
    source: String,
}

#[derive(Debug)]
struct CommandOutput {
    reply: String,
    duration_ms: u64,
}

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn data_dir() -> Result<PathBuf, String> {
    account::get_data_dir()
}

fn tasks_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join(TASKS_FILE))
}

fn history_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join(HISTORY_FILE))
}

fn install_hints() -> Vec<CodexCliInstallHint> {
    let mut hints = vec![CodexCliInstallHint {
        label: "npm".to_string(),
        command: "npm install -g @openai/codex".to_string(),
    }];
    #[cfg(target_os = "macos")]
    {
        hints.push(CodexCliInstallHint {
            label: "Homebrew".to_string(),
            command: "brew install --cask codex".to_string(),
        });
    }
    hints
}

fn normalize_text(value: Option<&str>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn is_team_like_plan(plan_type: Option<&str>) -> bool {
    let Some(raw) = plan_type else {
        return false;
    };
    let upper = raw.trim().to_ascii_uppercase();
    upper.contains("TEAM")
        || upper.contains("BUSINESS")
        || upper.contains("ENTERPRISE")
        || upper.contains("EDU")
}

fn decode_token_payload_value(token: &str) -> Option<serde_json::Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload = URL_SAFE_NO_PAD.decode(parts[1]).ok()?;
    serde_json::from_slice(&payload).ok()
}

fn read_json_string_map(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(|value| value.as_str())
            .and_then(|value| normalize_text(Some(value)))
    })
}

fn read_json_bool_map(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<bool> {
    keys.iter().find_map(|key| object.get(*key).and_then(|value| value.as_bool()))
}

fn extract_workspace_title(account: &crate::models::codex::CodexAccount) -> Option<String> {
    let payload = decode_token_payload_value(&account.tokens.id_token)?;
    let auth = payload
        .get("https://api.openai.com/auth")
        .and_then(|value| value.as_object())?;
    let organizations = auth.get("organizations").and_then(|value| value.as_array())?;
    let expected_org = normalize_text(account.organization_id.as_deref());
    let mut matched_title: Option<String> = None;
    let mut default_title: Option<String> = None;
    let mut first_title: Option<String> = None;

    for item in organizations {
        let Some(object) = item.as_object() else {
            continue;
        };
        let org_id = read_json_string_map(object, &["id", "organization_id", "workspace_id"]);
        let title = read_json_string_map(
            object,
            &["title", "name", "display_name", "workspace_name", "organization_name"],
        )
        .or_else(|| org_id.clone());
        let Some(title) = title else {
            continue;
        };

        if first_title.is_none() {
            first_title = Some(title.clone());
        }
        if read_json_bool_map(object, &["is_default"]) == Some(true) && default_title.is_none() {
            default_title = Some(title.clone());
        }
        if matched_title.is_none() && expected_org.is_some() && org_id == expected_org {
            matched_title = Some(title);
        }
    }

    matched_title.or(default_title).or(first_title)
}

fn resolve_account_context_text(account: &crate::models::codex::CodexAccount) -> Option<String> {
    let structure = normalize_text(account.account_structure.as_deref())
        .map(|value| value.to_ascii_lowercase());
    let is_personal = structure
        .as_deref()
        .map(|value| value.contains("personal"))
        .unwrap_or(false);

    if is_personal || (structure.is_none() && !is_team_like_plan(account.plan_type.as_deref())) {
        return Some("个人账户".to_string());
    }

    normalize_text(account.account_name.as_deref()).or_else(|| extract_workspace_title(account))
}

#[cfg(target_os = "windows")]
fn binary_candidates() -> &'static [&'static str] {
    &["codex.exe", "codex.cmd", "codex.bat", "codex"]
}

#[cfg(not(target_os = "windows"))]
fn binary_candidates() -> &'static [&'static str] {
    &["codex"]
}

fn resolve_binary_from_path() -> Option<PathBuf> {
    let dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect())
        .unwrap_or_default();

    #[cfg(target_os = "windows")]
    let dirs = {
        let mut dirs = dirs;
        if let Some(app_data) = std::env::var_os("APPDATA") {
            dirs.push(PathBuf::from(app_data).join("npm"));
        }
        dirs
    };

    for dir in dirs {
        for candidate in binary_candidates() {
            let path = dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }

    None
}

fn resolve_binary() -> Result<ResolvedBinary, String> {
    if let Ok(raw) = std::env::var("CODEX_CLI_PATH") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.is_file() {
                return Ok(ResolvedBinary {
                    path,
                    source: "CODEX_CLI_PATH".to_string(),
                });
            }
            return Err(format!("CODEX_CLI_PATH 指向的文件不存在: {}", trimmed));
        }
    }

    if let Some(path) = resolve_binary_from_path() {
        return Ok(ResolvedBinary {
            path,
            source: "PATH".to_string(),
        });
    }

    Err("未检测到 Codex CLI，请先安装 `codex` 命令。".to_string())
}

fn fetch_binary_version(path: &Path) -> Option<String> {
    let output = Command::new(path).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return Some(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return Some(stderr);
    }
    None
}

pub fn get_cli_status() -> CodexCliStatus {
    match resolve_binary() {
        Ok(binary) => CodexCliStatus {
            available: true,
            binary_path: Some(binary.path.display().to_string()),
            version: fetch_binary_version(&binary.path),
            source: Some(binary.source),
            message: None,
            checked_at: now_ms(),
            install_hints: install_hints(),
        },
        Err(err) => CodexCliStatus {
            available: false,
            binary_path: None,
            version: None,
            source: None,
            message: Some(err),
            checked_at: now_ms(),
            install_hints: install_hints(),
        },
    }
}

fn parse_time_to_minutes(value: &str) -> Option<i32> {
    let parts: Vec<&str> = value.trim().split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    let hour: i32 = parts[0].parse().ok()?;
    let minute: i32 = parts[1].parse().ok()?;
    if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) {
        return None;
    }
    Some(hour * 60 + minute)
}

fn normalize_schedule(raw: &CodexWakeupSchedule) -> CodexWakeupSchedule {
    let mut weekly_days: Vec<i32> = raw
        .weekly_days
        .iter()
        .copied()
        .filter(|day| (0..=6).contains(day))
        .collect();
    weekly_days.sort_unstable();
    weekly_days.dedup();

    CodexWakeupSchedule {
        kind: raw.kind.trim().to_ascii_lowercase(),
        daily_time: raw
            .daily_time
            .as_ref()
            .map(|item| item.trim().to_string())
            .filter(|item| parse_time_to_minutes(item).is_some()),
        weekly_days,
        weekly_time: raw
            .weekly_time
            .as_ref()
            .map(|item| item.trim().to_string())
            .filter(|item| parse_time_to_minutes(item).is_some()),
        interval_hours: raw.interval_hours.map(|value| value.max(1)),
    }
}

fn normalize_task(raw: &CodexWakeupTask) -> CodexWakeupTask {
    let now = now_ts();
    let mut account_ids: Vec<String> = raw
        .account_ids
        .iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect();
    account_ids.sort();
    account_ids.dedup();

    let name = raw.name.trim();
    let prompt = raw
        .prompt
        .as_ref()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty());
    let schedule = normalize_schedule(&raw.schedule);

    CodexWakeupTask {
        id: raw.id.trim().to_string(),
        name: if name.is_empty() {
            "Codex Wakeup Task".to_string()
        } else {
            name.to_string()
        },
        enabled: raw.enabled,
        account_ids,
        prompt,
        schedule,
        created_at: if raw.created_at > 0 {
            raw.created_at
        } else {
            now
        },
        updated_at: if raw.updated_at > 0 {
            raw.updated_at
        } else {
            now
        },
        last_run_at: raw.last_run_at,
        last_status: raw.last_status.clone(),
        last_message: raw.last_message.clone(),
        last_success_count: raw.last_success_count,
        last_failure_count: raw.last_failure_count,
        last_duration_ms: raw.last_duration_ms,
        next_run_at: raw.next_run_at,
    }
}

fn disable_tasks_when_cli_missing(state: &mut CodexWakeupState) -> bool {
    if get_cli_status().available {
        return false;
    }

    let mut changed = false;
    if state.enabled {
        state.enabled = false;
        changed = true;
    }

    for task in &mut state.tasks {
        if task.enabled {
            task.enabled = false;
            task.updated_at = now_ts();
            changed = true;
        }
    }

    changed
}

fn refresh_next_run_at(state: &mut CodexWakeupState) {
    for task in &mut state.tasks {
        task.next_run_at = if state.enabled && task.enabled {
            crate::modules::codex_wakeup_scheduler::calculate_next_run_at(task)
        } else {
            None
        };
    }
}

fn save_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or("无法定位目标目录")?;
    fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    let temp_path = parent.join(format!(
        "{}.tmp",
        path.file_name()
            .and_then(|item| item.to_str())
            .unwrap_or("codex_wakeup")
    ));
    let content =
        serde_json::to_string_pretty(value).map_err(|e| format!("序列化 JSON 失败: {}", e))?;
    fs::write(&temp_path, content).map_err(|e| format!("写入临时文件失败: {}", e))?;
    fs::rename(&temp_path, path).map_err(|e| format!("替换文件失败: {}", e))
}

pub fn load_state() -> Result<CodexWakeupState, String> {
    let path = tasks_path()?;
    if !path.exists() {
        return Ok(CodexWakeupState::default());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("读取 Codex 唤醒任务失败: {}", e))?;
    if content.trim().is_empty() {
        return Ok(CodexWakeupState::default());
    }
    let mut state: CodexWakeupState =
        serde_json::from_str(&content).map_err(|e| format!("解析 Codex 唤醒任务失败: {}", e))?;
    state.tasks = state
        .tasks
        .iter()
        .map(normalize_task)
        .collect();
    let changed = disable_tasks_when_cli_missing(&mut state);
    refresh_next_run_at(&mut state);
    if changed {
        let _lock = TASKS_LOCK.lock().map_err(|_| "获取 Codex 唤醒任务锁失败")?;
        save_json_atomic(&path, &state)?;
    }
    Ok(state)
}

pub fn save_state(next_state: &CodexWakeupState) -> Result<CodexWakeupState, String> {
    let _lock = TASKS_LOCK.lock().map_err(|_| "获取 Codex 唤醒任务锁失败")?;
    let mut seen = HashSet::new();
    let mut state = CodexWakeupState {
        enabled: next_state.enabled,
        tasks: next_state
            .tasks
            .iter()
            .map(normalize_task)
            .filter(|task| {
                !task.id.is_empty()
                    && !task.account_ids.is_empty()
                    && seen.insert(task.id.clone())
            })
            .collect(),
    };

    disable_tasks_when_cli_missing(&mut state);
    refresh_next_run_at(&mut state);

    save_json_atomic(&tasks_path()?, &state)?;
    Ok(state)
}

pub fn load_history() -> Result<Vec<CodexWakeupHistoryItem>, String> {
    let path = history_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("读取 Codex 唤醒历史失败: {}", e))?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&content).map_err(|e| format!("解析 Codex 唤醒历史失败: {}", e))
}

pub fn add_history_items(new_items: Vec<CodexWakeupHistoryItem>) -> Result<(), String> {
    if new_items.is_empty() {
        return Ok(());
    }
    let _lock = HISTORY_LOCK.lock().map_err(|_| "获取 Codex 唤醒历史锁失败")?;
    let mut existing = load_history().unwrap_or_default();
    let existing_ids: HashSet<String> = existing.iter().map(|item| item.id.clone()).collect();
    let mut merged: Vec<CodexWakeupHistoryItem> = new_items
        .into_iter()
        .filter(|item| !existing_ids.contains(&item.id))
        .collect();
    merged.append(&mut existing);
    merged.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    merged.truncate(MAX_HISTORY_ITEMS);
    save_json_atomic(&history_path()?, &merged)
}

pub fn clear_history() -> Result<(), String> {
    let _lock = HISTORY_LOCK.lock().map_err(|_| "获取 Codex 唤醒历史锁失败")?;
    save_json_atomic(&history_path()?, &Vec::<CodexWakeupHistoryItem>::new())
}

fn truncate_text(text: &str, max_len: usize) -> String {
    let count = text.chars().count();
    if count <= max_len {
        return text.to_string();
    }
    let mut result = text.chars().take(max_len).collect::<String>();
    result.push_str("...");
    result
}

#[cfg(target_os = "windows")]
fn apply_hidden_window_flags(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
}

#[cfg(not(target_os = "windows"))]
fn apply_hidden_window_flags(_command: &mut Command) {}

fn run_codex_exec_sync(binary_path: &Path, codex_home: &Path, prompt: &str) -> Result<CommandOutput, String> {
    let workspace_dir = codex_home.join("workspace");
    fs::create_dir_all(&workspace_dir).map_err(|e| format!("创建唤醒工作目录失败: {}", e))?;
    let last_message_path = codex_home.join("last_message.txt");

    let started = std::time::Instant::now();
    let mut command = Command::new(binary_path);
    command
        .env("CODEX_HOME", codex_home)
        .arg("exec")
        .arg("--skip-git-repo-check")
        .arg("--color")
        .arg("never")
        .arg("--output-last-message")
        .arg(&last_message_path)
        .arg("-C")
        .arg(&workspace_dir)
        .arg(prompt);
    apply_hidden_window_flags(&mut command);

    let output = command
        .output()
        .map_err(|e| format!("启动 Codex CLI 失败: {}", e))?;
    let duration_ms = started.elapsed().as_millis().max(0) as u64;

    let reply = fs::read_to_string(&last_message_path)
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .or_else(|| {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if stdout.is_empty() {
                None
            } else {
                Some(stdout)
            }
        });

    if output.status.success() {
        let reply = reply.unwrap_or_else(|| "Codex CLI 已完成，但未返回可读消息。".to_string());
        return Ok(CommandOutput { reply, duration_ms });
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut message = format!("Codex CLI 退出失败: {}", output.status);
    if !stderr.is_empty() {
        message.push_str(&format!(" | {}", truncate_text(&stderr, 400)));
    } else if !stdout.is_empty() {
        message.push_str(&format!(" | {}", truncate_text(&stdout, 400)));
    }
    Err(message)
}

fn create_failure_record(
    run_id: &str,
    trigger_type: &str,
    task_id: Option<&str>,
    task_name: Option<&str>,
    account_id: &str,
    account_email: String,
    account_context_text: Option<String>,
    prompt: Option<String>,
    error: String,
    cli_path: Option<String>,
) -> CodexWakeupHistoryItem {
    CodexWakeupHistoryItem {
        id: uuid::Uuid::new_v4().to_string(),
        run_id: run_id.to_string(),
        timestamp: now_ms(),
        trigger_type: trigger_type.to_string(),
        task_id: task_id.map(|item| item.to_string()),
        task_name: task_name.map(|item| item.to_string()),
        account_id: account_id.to_string(),
        account_email,
        account_context_text,
        success: false,
        prompt,
        reply: None,
        error: Some(error),
        quota_refresh_error: None,
        duration_ms: None,
        cli_path,
        quota_before: None,
        quota_after: None,
    }
}

fn emit_progress(
    app: Option<&AppHandle>,
    run_id: &str,
    context: &TaskRunContext,
    total: usize,
    completed: usize,
    success_count: usize,
    failure_count: usize,
    running: bool,
    phase: &str,
    current_account_id: Option<&str>,
    item: Option<CodexWakeupHistoryItem>,
) {
    let Some(app) = app else {
        return;
    };

    let payload = CodexWakeupProgressPayload {
        run_id: run_id.to_string(),
        trigger_type: context.trigger_type.clone(),
        task_id: context.task_id.clone(),
        task_name: context.task_name.clone(),
        total,
        completed,
        success_count,
        failure_count,
        running,
        phase: phase.to_string(),
        current_account_id: current_account_id.map(|value| value.to_string()),
        item,
    };
    let _ = app.emit(PROGRESS_EVENT, payload);
}

fn create_cli_missing_record(
    run_id: &str,
    context: &TaskRunContext,
    account_id: &str,
    prompt: Option<String>,
) -> CodexWakeupHistoryItem {
    let existing = codex_account::load_account(account_id);
    let account_email = existing
        .as_ref()
        .map(|account| account.email.clone())
        .unwrap_or_else(|| account_id.to_string());
    let account_context_text = existing
        .as_ref()
        .and_then(resolve_account_context_text);

    create_failure_record(
        run_id,
        &context.trigger_type,
        context.task_id.as_deref(),
        context.task_name.as_deref(),
        account_id,
        account_email,
        account_context_text,
        prompt,
        "未检测到 Codex CLI，请先安装后再执行唤醒。".to_string(),
        None,
    )
}

async fn run_single_account(
    binary: Option<&ResolvedBinary>,
    run_id: &str,
    context: &TaskRunContext,
    account_id: &str,
    prompt: &str,
) -> CodexWakeupHistoryItem {
    let prompt_value = Some(prompt.to_string());
    let binary_path = binary.map(|item| item.path.display().to_string());

    let existing = match codex_account::load_account(account_id) {
        Some(account) => account,
        None => {
            return create_failure_record(
                run_id,
                &context.trigger_type,
                context.task_id.as_deref(),
                context.task_name.as_deref(),
                account_id,
                account_id.to_string(),
                None,
                prompt_value,
                "账号不存在".to_string(),
                binary_path,
            )
        }
    };
    let existing_context_text = resolve_account_context_text(&existing);

    if existing.is_api_key_auth() {
        return create_failure_record(
            run_id,
            &context.trigger_type,
            context.task_id.as_deref(),
            context.task_name.as_deref(),
            account_id,
            existing.email,
            existing_context_text,
            prompt_value,
            "Codex 唤醒任务暂不支持 API Key 账号。".to_string(),
            binary_path,
        );
    }

    let Some(binary) = binary else {
        return create_cli_missing_record(run_id, context, account_id, prompt_value);
    };

    let account = match codex_account::prepare_account_for_injection(account_id).await {
        Ok(account) => account,
        Err(err) => {
            return create_failure_record(
                run_id,
                &context.trigger_type,
                context.task_id.as_deref(),
                context.task_name.as_deref(),
                account_id,
                existing.email,
                existing_context_text,
                prompt_value,
                err,
                binary_path,
            )
        }
    };

    let temp_home = std::env::temp_dir().join("ag-codex-wakeup").join(uuid::Uuid::new_v4().to_string());
    if let Err(err) = fs::create_dir_all(&temp_home) {
        let account_context_text = resolve_account_context_text(&account);
        let account_email = account.email;
        return create_failure_record(
            run_id,
            &context.trigger_type,
            context.task_id.as_deref(),
            context.task_name.as_deref(),
            account_id,
            account_email,
            account_context_text,
            prompt_value,
            format!("创建临时 CODEX_HOME 失败: {}", err),
            Some(binary.path.display().to_string()),
        );
    }

    if let Err(err) = codex_account::write_auth_file_to_dir(&temp_home, &account) {
        let _ = fs::remove_dir_all(&temp_home);
        let account_context_text = resolve_account_context_text(&account);
        let account_email = account.email;
        return create_failure_record(
            run_id,
            &context.trigger_type,
            context.task_id.as_deref(),
            context.task_name.as_deref(),
            account_id,
            account_email,
            account_context_text,
            prompt_value,
            err,
            Some(binary.path.display().to_string()),
        );
    }

    let command_result = run_codex_exec_sync(&binary.path, &temp_home, prompt);

    let _ = fs::remove_dir_all(&temp_home);

    match command_result {
        Ok(output) => {
            let account_context_text = resolve_account_context_text(&account);
            let account_email = account.email;
            CodexWakeupHistoryItem {
            id: uuid::Uuid::new_v4().to_string(),
            run_id: run_id.to_string(),
            timestamp: now_ms(),
            trigger_type: context.trigger_type.clone(),
            task_id: context.task_id.clone(),
            task_name: context.task_name.clone(),
            account_id: account_id.to_string(),
            account_email,
            account_context_text,
            success: true,
            prompt: prompt_value,
            reply: Some(output.reply),
            error: None,
            quota_refresh_error: None,
            duration_ms: Some(output.duration_ms),
            cli_path: Some(binary.path.display().to_string()),
            quota_before: None,
            quota_after: None,
            }
        }
        Err(err) => {
            let account_context_text = resolve_account_context_text(&account);
            let account_email = account.email;
            create_failure_record(
                run_id,
                &context.trigger_type,
                context.task_id.as_deref(),
                context.task_name.as_deref(),
                account_id,
                account_email,
                account_context_text,
                prompt_value,
                err,
                Some(binary.path.display().to_string()),
            )
        }
    }
}

pub async fn run_batch(
    app: Option<&AppHandle>,
    account_ids: Vec<String>,
    prompt: Option<String>,
    context: TaskRunContext,
    run_id: Option<String>,
) -> Result<CodexWakeupBatchResult, String> {
    let cleaned_ids: Vec<String> = account_ids
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect();
    if cleaned_ids.is_empty() {
        return Err("至少选择一个账号".to_string());
    }

    let prompt = prompt
        .as_ref()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .unwrap_or_else(|| DEFAULT_PROMPT.to_string());
    let total = cleaned_ids.len();
    let runtime = get_cli_status();
    let run_id = run_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    emit_progress(
        app,
        &run_id,
        &context,
        total,
        0,
        0,
        0,
        true,
        "batch_started",
        None,
        None,
    );
    if !runtime.available {
        let mut records = Vec::with_capacity(cleaned_ids.len());
        let mut success_count = 0usize;
        let mut failure_count = 0usize;

        for (index, account_id) in cleaned_ids.iter().enumerate() {
            emit_progress(
                app,
                &run_id,
                &context,
                total,
                index,
                success_count,
                failure_count,
                true,
                "account_started",
                Some(account_id),
                None,
            );

            let record = create_cli_missing_record(&run_id, &context, account_id, Some(prompt.clone()));
            if record.success {
                success_count += 1;
            } else {
                failure_count += 1;
            }
            emit_progress(
                app,
                &run_id,
                &context,
                total,
                index + 1,
                success_count,
                failure_count,
                index + 1 < total,
                "account_completed",
                Some(account_id),
                Some(record.clone()),
            );
            records.push(record);
        }

        add_history_items(records.clone())?;
        emit_progress(
            app,
            &run_id,
            &context,
            records.len(),
            records.len(),
            success_count,
            failure_count,
            false,
            "batch_completed",
            None,
            None,
        );

        return Ok(CodexWakeupBatchResult {
            run_id,
            runtime,
            records,
            success_count,
            failure_count,
        });
    }

    let binary = resolve_binary().ok();
    let mut records = Vec::with_capacity(cleaned_ids.len());
    let mut success_count = 0usize;
    let mut failure_count = 0usize;

    for (index, account_id) in cleaned_ids.into_iter().enumerate() {
        emit_progress(
            app,
            &run_id,
            &context,
            total,
            index,
            success_count,
            failure_count,
            true,
            "account_started",
            Some(&account_id),
            None,
        );
        let record = run_single_account(binary.as_ref(), &run_id, &context, &account_id, &prompt).await;
        if record.success {
            success_count += 1;
        } else {
            failure_count += 1;
        }
        emit_progress(
            app,
            &run_id,
            &context,
            total,
            index + 1,
            success_count,
            failure_count,
            index + 1 < total,
            "account_completed",
            Some(&account_id),
            Some(record.clone()),
        );
        records.push(record);
    }

    add_history_items(records.clone())?;
    emit_progress(
        app,
        &run_id,
        &context,
        records.len(),
        records.len(),
        success_count,
        failure_count,
        false,
        "batch_completed",
        None,
        None,
    );

    Ok(CodexWakeupBatchResult {
        run_id,
        runtime,
        records,
        success_count,
        failure_count,
    })
}

fn summarize_task_result(records: &[CodexWakeupHistoryItem]) -> (Option<String>, Option<u64>, Option<i64>) {
    let latest_ts = records.iter().map(|item| item.timestamp).max();
    let total_duration = records.iter().filter_map(|item| item.duration_ms).sum::<u64>();

    (
        None,
        if records.is_empty() {
            None
        } else {
            Some(total_duration)
        },
        latest_ts,
    )
}

pub fn update_task_after_run(task_id: &str, records: &[CodexWakeupHistoryItem]) -> Result<(), String> {
    let mut state = load_state()?;
    let Some(task) = state.tasks.iter_mut().find(|item| item.id == task_id) else {
        return Ok(());
    };

    let all_success = !records.is_empty() && records.iter().all(|item| item.success);
    let success_count = records.iter().filter(|item| item.success).count() as u32;
    let failure_count = records.len().saturating_sub(success_count as usize) as u32;
    let (summary_message, total_duration, _) = summarize_task_result(records);
    task.last_run_at = Some(now_ts());
    task.last_status = Some(if all_success { "success" } else { "error" }.to_string());
    task.last_message = summary_message;
    task.last_success_count = if records.is_empty() { None } else { Some(success_count) };
    task.last_failure_count = if records.is_empty() { None } else { Some(failure_count) };
    task.last_duration_ms = total_duration;
    task.updated_at = now_ts();
    task.next_run_at = crate::modules::codex_wakeup_scheduler::calculate_next_run_at(task);
    save_state(&state)?;
    Ok(())
}

pub fn get_task(task_id: &str) -> Result<Option<CodexWakeupTask>, String> {
    Ok(load_state()?.tasks.into_iter().find(|item| item.id == task_id))
}
