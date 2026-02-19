use base64::Engine;
use rand::Rng;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::models::cursor::{CursorAccount, CursorOAuthCompletePayload, CursorOAuthStartResponse};
use crate::modules::cursor_account;

const CURSOR_LOGIN_URL: &str = "https://www.cursor.com/login";
const OAUTH_TIMEOUT_SECONDS: u64 = 600;
const OAUTH_INTERVAL_SECONDS: u64 = 3;

#[derive(Clone, Debug)]
struct PendingOAuthState {
    login_id: String,
    expires_at: i64,
}

lazy_static::lazy_static! {
    static ref PENDING_OAUTH_STATE: Arc<Mutex<HashMap<String, PendingOAuthState>>> =
        Arc::new(Mutex::new(HashMap::new()));
}

fn now_timestamp() -> i64 {
    chrono::Utc::now().timestamp()
}

fn generate_token() -> String {
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..24).map(|_| rng.gen::<u8>()).collect();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn normalize_non_empty(value: Option<&str>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_email(value: Option<&str>) -> Option<String> {
    normalize_non_empty(value).and_then(|text| {
        if text.contains('@') {
            Some(text)
        } else {
            None
        }
    })
}

fn get_path_value<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = root;
    for key in path {
        current = current.as_object()?.get(*key)?;
    }
    Some(current)
}

fn pick_string(root: Option<&Value>, paths: &[&[&str]]) -> Option<String> {
    let root = root?;
    for path in paths {
        if let Some(value) = get_path_value(root, path) {
            if let Some(text) = value.as_str() {
                if let Some(normalized) = normalize_non_empty(Some(text)) {
                    return Some(normalized);
                }
            }
            if let Some(num) = value.as_i64() {
                return Some(num.to_string());
            }
            if let Some(num) = value.as_u64() {
                return Some(num.to_string());
            }
        }
    }
    None
}

fn parse_timestamp(value: Option<&Value>) -> Option<i64> {
    let value = value?;

    if let Some(seconds) = value.as_i64() {
        return normalize_timestamp(seconds);
    }

    if let Some(seconds) = value.as_u64() {
        return normalize_timestamp(seconds as i64);
    }

    if let Some(text) = value.as_str() {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }

        if let Ok(seconds) = trimmed.parse::<i64>() {
            return normalize_timestamp(seconds);
        }

        if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(trimmed) {
            return Some(dt.timestamp());
        }
    }

    None
}

fn normalize_timestamp(raw: i64) -> Option<i64> {
    if raw <= 0 {
        return None;
    }
    if raw > 10_000_000_000 {
        return Some(raw / 1000);
    }
    Some(raw)
}

fn decode_jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let mut padded = payload.replace('-', "+").replace('_', "/");
    while padded.len() % 4 != 0 {
        padded.push('=');
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(padded).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()
}

fn build_fallback_profile(email: &str, user_id: Option<&str>) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("email".to_string(), Value::String(email.to_string()));
    if let Some(uid) = normalize_non_empty(user_id) {
        obj.insert("userId".to_string(), Value::String(uid));
    }
    Value::Object(obj)
}

fn build_payload_from_snapshot(
    auth_token: Value,
    profile: Option<Value>,
    usage: Option<Value>,
) -> Result<CursorOAuthCompletePayload, String> {
    let access_token = pick_string(
        Some(&auth_token),
        &[
            &["accessToken"],
            &["access_token"],
            &["token"],
            &["id_token"],
            &["cursorAuth", "accessToken"],
        ],
    )
    .ok_or_else(|| "Cursor 本地授权信息缺少 access token".to_string())?;

    let refresh_token = pick_string(
        Some(&auth_token),
        &[
            &["refreshToken"],
            &["refresh_token"],
            &["cursorAuth", "refreshToken"],
        ],
    );

    let token_type = pick_string(Some(&auth_token), &[&["tokenType"], &["token_type"]])
        .or_else(|| Some("Bearer".to_string()));

    let jwt_claims = decode_jwt_claims(&access_token);

    let email = normalize_email(
        pick_string(
            Some(&auth_token),
            &[
                &["email"],
                &["cachedEmail"],
                &["cursorAuth", "cachedEmail"],
                &["login_hint"],
                &["loginHint"],
            ],
        )
        .as_deref(),
    )
    .or_else(|| {
        normalize_email(
            pick_string(
                profile.as_ref(),
                &[&["email"], &["user", "email"], &["account", "email"]],
            )
            .as_deref(),
        )
    })
    .or_else(|| {
        normalize_email(
            pick_string(jwt_claims.as_ref(), &[&["email"], &["upn"], &["preferred_username"]])
                .as_deref(),
        )
    })
    .ok_or_else(|| "Cursor 登录信息缺少邮箱字段，请先在 Cursor 客户端完成登录".to_string())?;

    let user_id = normalize_non_empty(
        pick_string(
            Some(&auth_token),
            &[
                &["userId"],
                &["user_id"],
                &["sub"],
                &["cursorAuth", "userId"],
            ],
        )
        .as_deref(),
    )
    .or_else(|| normalize_non_empty(pick_string(jwt_claims.as_ref(), &[&["sub"]]).as_deref()));

    let login_provider = normalize_non_empty(
        pick_string(
            Some(&auth_token),
            &[
                &["provider"],
                &["loginProvider"],
                &["authProvider"],
                &["cursorAuth", "provider"],
            ],
        )
        .as_deref(),
    );

    let plan_name = normalize_non_empty(
        pick_string(
            Some(&auth_token),
            &[
                &["stripeMembershipType"],
                &["membershipType"],
                &["plan"],
                &["planName"],
                &["cursorAuth", "stripeMembershipType"],
            ],
        )
        .as_deref(),
    );

    let expires_at = parse_timestamp(
        get_path_value(&auth_token, &["expiresAt"])
            .or_else(|| get_path_value(&auth_token, &["expires_at"]))
            .or_else(|| get_path_value(&auth_token, &["expiration"]))
            .or_else(|| get_path_value(&auth_token, &["exp"]))
            .or_else(|| jwt_claims.as_ref().and_then(|claims| get_path_value(claims, &["exp"]))),
    );

    Ok(CursorOAuthCompletePayload {
        email: email.clone(),
        user_id: user_id.clone(),
        login_provider,
        access_token,
        refresh_token,
        token_type,
        expires_at,
        idc_region: None,
        issuer_url: None,
        client_id: None,
        scopes: None,
        login_hint: Some(email.clone()),
        plan_name: plan_name.clone(),
        plan_tier: plan_name,
        credits_total: None,
        credits_used: None,
        bonus_total: None,
        bonus_used: None,
        usage_reset_at: None,
        bonus_expire_days: None,
        cursor_auth_token_raw: Some(auth_token),
        cursor_profile_raw: Some(profile.unwrap_or_else(|| build_fallback_profile(&email, user_id.as_deref()))),
        cursor_usage_raw: usage,
    })
}

fn payload_from_account(account: &CursorAccount) -> CursorOAuthCompletePayload {
    CursorOAuthCompletePayload {
        email: account.email.clone(),
        user_id: account.user_id.clone(),
        login_provider: account.login_provider.clone(),
        access_token: account.access_token.clone(),
        refresh_token: account.refresh_token.clone(),
        token_type: account.token_type.clone(),
        expires_at: account.expires_at,
        idc_region: account.idc_region.clone(),
        issuer_url: account.issuer_url.clone(),
        client_id: account.client_id.clone(),
        scopes: account.scopes.clone(),
        login_hint: account.login_hint.clone(),
        plan_name: account.plan_name.clone(),
        plan_tier: account.plan_tier.clone(),
        credits_total: account.credits_total,
        credits_used: account.credits_used,
        bonus_total: account.bonus_total,
        bonus_used: account.bonus_used,
        usage_reset_at: account.usage_reset_at,
        bonus_expire_days: account.bonus_expire_days,
        cursor_auth_token_raw: account.cursor_auth_token_raw.clone(),
        cursor_profile_raw: account.cursor_profile_raw.clone(),
        cursor_usage_raw: account.cursor_usage_raw.clone(),
    }
}

fn payload_matches_account(payload: &CursorOAuthCompletePayload, account: &CursorAccount) -> bool {
    let payload_user = normalize_non_empty(payload.user_id.as_deref());
    let account_user = normalize_non_empty(account.user_id.as_deref());
    if let (Some(left), Some(right)) = (payload_user.as_ref(), account_user.as_ref()) {
        if left == right {
            return true;
        }
    }

    let payload_email = normalize_email(Some(payload.email.as_str())).map(|v| v.to_lowercase());
    let account_email = normalize_email(Some(account.email.as_str())).map(|v| v.to_lowercase());
    if let (Some(left), Some(right)) = (payload_email.as_ref(), account_email.as_ref()) {
        if left == right {
            return true;
        }
    }

    let payload_refresh = normalize_non_empty(payload.refresh_token.as_deref());
    let account_refresh = normalize_non_empty(account.refresh_token.as_deref());
    matches!((payload_refresh.as_ref(), account_refresh.as_ref()), (Some(left), Some(right)) if left == right)
}

pub fn build_payload_from_local_files() -> Result<CursorOAuthCompletePayload, String> {
    let auth_token = cursor_account::read_local_auth_token_json()?.ok_or_else(|| {
        "未在本机找到 Cursor 登录信息（state.vscdb 中缺少 cursorAuth/accessToken）".to_string()
    })?;

    let profile = cursor_account::read_local_profile_json()?;
    let usage = cursor_account::read_local_usage_snapshot()?;
    build_payload_from_snapshot(auth_token, profile, usage)
}

pub async fn enrich_payload_with_runtime_usage(
    payload: CursorOAuthCompletePayload,
) -> CursorOAuthCompletePayload {
    payload
}

pub async fn refresh_payload_for_account(account: &CursorAccount) -> Result<CursorOAuthCompletePayload, String> {
    if let Ok(Some(auth_token)) = cursor_account::read_local_auth_token_json() {
        let profile = cursor_account::read_local_profile_json().ok().flatten();
        let usage = cursor_account::read_local_usage_snapshot().ok().flatten();
        if let Ok(payload) = build_payload_from_snapshot(auth_token, profile, usage) {
            if payload_matches_account(&payload, account) {
                return Ok(payload);
            }
        }
    }

    Ok(payload_from_account(account))
}

pub async fn start_login() -> Result<CursorOAuthStartResponse, String> {
    let login_id = generate_token();
    let expires_at = now_timestamp() + OAUTH_TIMEOUT_SECONDS as i64;

    let state = PendingOAuthState {
        login_id: login_id.clone(),
        expires_at,
    };

    let mut guard = PENDING_OAUTH_STATE
        .lock()
        .map_err(|_| "无法获取 Cursor OAuth 状态锁".to_string())?;
    guard.insert(login_id.clone(), state);

    let user_code = login_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(6)
        .collect::<String>()
        .to_uppercase();

    Ok(CursorOAuthStartResponse {
        login_id,
        user_code,
        verification_uri: CURSOR_LOGIN_URL.to_string(),
        verification_uri_complete: Some(CURSOR_LOGIN_URL.to_string()),
        expires_in: OAUTH_TIMEOUT_SECONDS,
        interval_seconds: OAUTH_INTERVAL_SECONDS,
        callback_url: None,
    })
}

pub async fn complete_login(login_id: &str) -> Result<CursorOAuthCompletePayload, String> {
    let now = now_timestamp();
    {
        let mut guard = PENDING_OAUTH_STATE
            .lock()
            .map_err(|_| "无法获取 Cursor OAuth 状态锁".to_string())?;

        let state = guard
            .get(login_id)
            .cloned()
            .ok_or_else(|| "Cursor OAuth 登录会话不存在，请重新开始授权".to_string())?;

        if state.login_id != login_id {
            return Err("Cursor OAuth 登录会话不匹配，请重新开始授权".to_string());
        }

        if state.expires_at < now {
            guard.remove(login_id);
            return Err("Cursor OAuth 登录会话已过期，请重新开始授权".to_string());
        }

        guard.remove(login_id);
    }

    build_payload_from_local_files().map_err(|err| {
        format!(
            "{}。请先在 Cursor 客户端完成登录，再回到这里点击重试。",
            err
        )
    })
}

pub fn cancel_login(login_id: Option<&str>) -> Result<(), String> {
    let mut guard = PENDING_OAUTH_STATE
        .lock()
        .map_err(|_| "无法获取 Cursor OAuth 状态锁".to_string())?;

    match login_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => {
            guard.remove(id);
        }
        None => {
            guard.clear();
        }
    }

    Ok(())
}

pub async fn build_payload_from_token(token: &str) -> Result<CursorOAuthCompletePayload, String> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err("Token 不能为空".to_string());
    }

    let raw = json!({
        "accessToken": trimmed,
        "tokenType": "Bearer",
    });

    build_payload_from_snapshot(raw, None, None)
}
