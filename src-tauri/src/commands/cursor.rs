use std::time::Instant;
use tauri::{AppHandle, Emitter};

use crate::models::cursor::{CursorAccount, CursorOAuthStartResponse};
use crate::modules::{cursor_account, cursor_oauth, logger};

#[tauri::command]
pub fn list_cursor_accounts() -> Result<Vec<CursorAccount>, String> {
    Ok(cursor_account::list_accounts())
}

#[tauri::command]
pub fn delete_cursor_account(account_id: String) -> Result<(), String> {
    cursor_account::remove_account(&account_id)
}

#[tauri::command]
pub fn delete_cursor_accounts(account_ids: Vec<String>) -> Result<(), String> {
    cursor_account::remove_accounts(&account_ids)
}

#[tauri::command]
pub fn import_cursor_from_json(json_content: String) -> Result<Vec<CursorAccount>, String> {
    cursor_account::import_from_json(&json_content)
}

#[tauri::command]
pub async fn import_cursor_from_local() -> Result<Vec<CursorAccount>, String> {
    let payload = cursor_oauth::build_payload_from_local_files()?;
    let payload = cursor_oauth::enrich_payload_with_runtime_usage(payload).await;
    let account = cursor_account::upsert_account(payload)?;
    Ok(vec![account])
}

#[tauri::command]
pub fn export_cursor_accounts(account_ids: Vec<String>) -> Result<String, String> {
    cursor_account::export_accounts(&account_ids)
}

#[tauri::command]
pub async fn refresh_cursor_token(app: AppHandle, account_id: String) -> Result<CursorAccount, String> {
    let started_at = Instant::now();
    logger::log_info(&format!(
        "[Cursor Command] 手动刷新账号开始: account_id={}",
        account_id
    ));

    match cursor_account::refresh_account_token(&account_id).await {
        Ok(account) => {
            if let Err(e) = cursor_account::run_quota_alert_if_needed() {
                logger::log_warn(&format!("[QuotaAlert][Cursor] 预警检查失败: {}", e));
            }
            let _ = crate::modules::tray::update_tray_menu(&app);
            logger::log_info(&format!(
                "[Cursor Command] 手动刷新账号完成: account_id={}, email={}, elapsed={}ms",
                account.id,
                account.email,
                started_at.elapsed().as_millis()
            ));
            Ok(account)
        }
        Err(err) => {
            logger::log_warn(&format!(
                "[Cursor Command] 手动刷新账号失败: account_id={}, elapsed={}ms, error={}",
                account_id,
                started_at.elapsed().as_millis(),
                err
            ));
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn refresh_all_cursor_tokens(app: AppHandle) -> Result<i32, String> {
    let started_at = Instant::now();
    logger::log_info("[Cursor Command] 手动批量刷新开始");

    let results = cursor_account::refresh_all_tokens().await?;
    let success_count = results.iter().filter(|(_, item)| item.is_ok()).count();
    let failed_count = results.len().saturating_sub(success_count);

    logger::log_info(&format!(
        "[Cursor Command] 手动批量刷新完成: success={}, failed={}, elapsed={}ms",
        success_count,
        failed_count,
        started_at.elapsed().as_millis()
    ));

    if success_count > 0 {
        if let Err(e) = cursor_account::run_quota_alert_if_needed() {
            logger::log_warn(&format!("[QuotaAlert][Cursor] 全量刷新后预警检查失败: {}", e));
        }
    }

    let _ = crate::modules::tray::update_tray_menu(&app);
    Ok(success_count as i32)
}

#[tauri::command]
pub async fn cursor_oauth_login_start() -> Result<CursorOAuthStartResponse, String> {
    logger::log_info("Cursor OAuth start 命令触发");
    cursor_oauth::start_login().await
}

#[tauri::command]
pub async fn cursor_oauth_login_complete(
    app: AppHandle,
    login_id: String,
) -> Result<CursorAccount, String> {
    logger::log_info(&format!(
        "Cursor OAuth complete 命令触发: login_id={}",
        login_id
    ));
    let payload = cursor_oauth::complete_login(&login_id).await?;
    let account = cursor_account::upsert_account(payload)?;
    logger::log_info(&format!(
        "Cursor OAuth complete 成功: account_id={}, email={}",
        account.id, account.email
    ));
    let _ = crate::modules::tray::update_tray_menu(&app);
    Ok(account)
}

#[tauri::command]
pub fn cursor_oauth_login_cancel(login_id: Option<String>) -> Result<(), String> {
    logger::log_info(&format!(
        "Cursor OAuth cancel 命令触发: login_id={}",
        login_id.as_deref().unwrap_or("<none>")
    ));
    cursor_oauth::cancel_login(login_id.as_deref())
}

#[tauri::command]
pub async fn add_cursor_account_with_token(
    app: AppHandle,
    access_token: String,
) -> Result<CursorAccount, String> {
    let payload = cursor_oauth::build_payload_from_token(&access_token).await?;
    let account = cursor_account::upsert_account(payload)?;
    let _ = crate::modules::tray::update_tray_menu(&app);
    Ok(account)
}

#[tauri::command]
pub async fn update_cursor_account_tags(
    account_id: String,
    tags: Vec<String>,
) -> Result<CursorAccount, String> {
    cursor_account::update_account_tags(&account_id, tags)
}

#[tauri::command]
pub fn get_cursor_accounts_index_path() -> Result<String, String> {
    cursor_account::accounts_index_path_string()
}

#[tauri::command]
pub async fn inject_cursor_to_vscode(app: AppHandle, account_id: String) -> Result<String, String> {
    let started_at = Instant::now();
    logger::log_info(&format!(
        "[Cursor Switch] 开始切换账号: account_id={}",
        account_id
    ));

    let account = cursor_account::load_account(&account_id)
        .ok_or_else(|| format!("Cursor account not found: {}", account_id))?;

    if let Err(err) = crate::modules::cursor_instance::update_default_settings(
        Some(Some(account_id.clone())),
        None,
        Some(false),
    ) {
        logger::log_warn(&format!("更新 Cursor 默认实例绑定账号失败: {}", err));
    }

    let launch_warning = match crate::commands::cursor_instance::cursor_start_instance(
        "__default__".to_string(),
    )
    .await
    {
        Ok(_) => None,
        Err(err) => {
            if err.starts_with("APP_PATH_NOT_FOUND:") || err.contains("启动 Cursor 失败") {
                logger::log_warn(&format!("Cursor 默认实例启动失败: {}", err));
                if err.starts_with("APP_PATH_NOT_FOUND:") {
                    let _ = app.emit(
                        "app:path_missing",
                        serde_json::json!({ "app": "cursor", "retry": { "kind": "default" } }),
                    );
                }
                Some(err)
            } else {
                return Err(err);
            }
        }
    };

    let _ = crate::modules::tray::update_tray_menu(&app);

    if let Some(err) = launch_warning {
        logger::log_warn(&format!(
            "[Cursor Switch] 切号完成但启动失败: account_id={}, email={}, elapsed={}ms, error={}",
            account.id,
            account.email,
            started_at.elapsed().as_millis(),
            err
        ));
        Ok(format!("切换完成，但 Cursor 启动失败: {}", err))
    } else {
        logger::log_info(&format!(
            "[Cursor Switch] 切号成功: account_id={}, email={}, elapsed={}ms",
            account.id,
            account.email,
            started_at.elapsed().as_millis()
        ));
        Ok(format!("切换完成: {}", account.email))
    }
}
