import { invoke } from '@tauri-apps/api/core';
import { CursorAccount } from '../types/cursor';

export interface CursorOAuthLoginStartResponse {
  loginId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string | null;
  expiresIn: number;
  intervalSeconds: number;
  callbackUrl?: string | null;
}

/** 列出所有 Cursor 账号 */
export async function listCursorAccounts(): Promise<CursorAccount[]> {
  return await invoke('list_cursor_accounts');
}

/** 删除 Cursor 账号 */
export async function deleteCursorAccount(accountId: string): Promise<void> {
  return await invoke('delete_cursor_account', { accountId });
}

/** 批量删除 Cursor 账号 */
export async function deleteCursorAccounts(accountIds: string[]): Promise<void> {
  return await invoke('delete_cursor_accounts', { accountIds });
}

/** 从 JSON 字符串导入账号 */
export async function importCursorFromJson(jsonContent: string): Promise<CursorAccount[]> {
  return await invoke('import_cursor_from_json', { jsonContent });
}

/** 从本机 Cursor 客户端导入当前登录账号 */
export async function importCursorFromLocal(): Promise<CursorAccount[]> {
  return await invoke('import_cursor_from_local');
}

/** 导出 Cursor 账号 */
export async function exportCursorAccounts(accountIds: string[]): Promise<string> {
  return await invoke('export_cursor_accounts', { accountIds });
}

/** 刷新单个账号 token/usage */
export async function refreshCursorToken(accountId: string): Promise<CursorAccount> {
  return await invoke('refresh_cursor_token', { accountId });
}

/** 刷新全部账号 token/usage */
export async function refreshAllCursorTokens(): Promise<number> {
  return await invoke('refresh_all_cursor_tokens');
}

/** Cursor OAuth：开始登录（浏览器授权 + 本地回调） */
export async function startCursorOAuthLogin(): Promise<CursorOAuthLoginStartResponse> {
  return await invoke('cursor_oauth_login_start');
}

/** Cursor OAuth：完成登录（等待本地回调，直到成功/失败/超时） */
export async function completeCursorOAuthLogin(loginId: string): Promise<CursorAccount> {
  return await invoke('cursor_oauth_login_complete', { loginId });
}

/** Cursor OAuth：取消登录 */
export async function cancelCursorOAuthLogin(loginId?: string): Promise<void> {
  return await invoke('cursor_oauth_login_cancel', { loginId: loginId ?? null });
}

/** 通过 Cursor access token 添加账号 */
export async function addCursorAccountWithToken(accessToken: string): Promise<CursorAccount> {
  return await invoke('add_cursor_account_with_token', {
    accessToken,
    access_token: accessToken,
  });
}

export async function updateCursorAccountTags(accountId: string, tags: string[]): Promise<CursorAccount> {
  return await invoke('update_cursor_account_tags', { accountId, tags });
}

export async function getCursorAccountsIndexPath(): Promise<string> {
  return await invoke('get_cursor_accounts_index_path');
}

/** 将 Cursor 账号注入到 Cursor 默认实例 */
export async function injectCursorToVSCode(accountId: string): Promise<string> {
  return await invoke('inject_cursor_to_vscode', { accountId });
}
