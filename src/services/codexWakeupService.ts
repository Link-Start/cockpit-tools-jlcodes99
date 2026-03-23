import { invoke } from '@tauri-apps/api/core';
import {
  CodexCliStatus,
  CodexWakeupBatchResult,
  CodexWakeupHistoryItem,
  CodexWakeupProgressPayload,
  CodexWakeupState,
  CodexWakeupTask,
} from '../types/codexWakeup';

interface RawCodexCliInstallHint {
  label: string;
  command: string;
}

interface RawCodexCliStatus {
  available: boolean;
  binaryPath?: string;
  version?: string;
  source?: string;
  message?: string;
  checkedAt: number;
  installHints?: RawCodexCliInstallHint[];
}

interface RawCodexWakeupSchedule {
  kind: CodexWakeupTask['schedule']['kind'];
  dailyTime?: string;
  weeklyDays?: number[];
  weeklyTime?: string;
  intervalHours?: number;
}

interface RawCodexWakeupTask {
  id: string;
  name: string;
  enabled: boolean;
  accountIds: string[];
  prompt?: string;
  schedule: RawCodexWakeupSchedule;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastStatus?: string;
  lastMessage?: string;
  lastSuccessCount?: number;
  lastFailureCount?: number;
  lastDurationMs?: number;
  nextRunAt?: number;
}

interface RawCodexQuotaSnapshot {
  hourlyPercentage?: number;
  hourlyResetTime?: number;
  weeklyPercentage?: number;
  weeklyResetTime?: number;
}

interface RawCodexWakeupHistoryItem {
  id: string;
  runId: string;
  timestamp: number;
  triggerType: string;
  taskId?: string;
  taskName?: string;
  accountId: string;
  accountEmail: string;
  accountContextText?: string;
  success: boolean;
  prompt?: string;
  reply?: string;
  error?: string;
  quotaRefreshError?: string;
  durationMs?: number;
  cliPath?: string;
  quotaBefore?: RawCodexQuotaSnapshot;
  quotaAfter?: RawCodexQuotaSnapshot;
}

interface RawCodexWakeupState {
  enabled: boolean;
  tasks: RawCodexWakeupTask[];
}

interface RawCodexWakeupBatchResult {
  runId: string;
  runtime: RawCodexCliStatus;
  records: RawCodexWakeupHistoryItem[];
  successCount: number;
  failureCount: number;
}

interface RawCodexWakeupProgressPayload {
  runId: string;
  triggerType: string;
  taskId?: string;
  taskName?: string;
  total: number;
  completed: number;
  successCount: number;
  failureCount: number;
  running: boolean;
  phase: string;
  currentAccountId?: string;
  item?: RawCodexWakeupHistoryItem;
}

function fromRawCliStatus(raw: RawCodexCliStatus): CodexCliStatus {
  return {
    available: raw.available,
    binary_path: raw.binaryPath,
    version: raw.version,
    source: raw.source,
    message: raw.message,
    checked_at: raw.checkedAt,
    install_hints: raw.installHints ?? [],
  };
}

function toRawTask(task: CodexWakeupTask): RawCodexWakeupTask {
  return {
    id: task.id,
    name: task.name,
    enabled: task.enabled,
    accountIds: task.account_ids,
    prompt: task.prompt,
    schedule: {
      kind: task.schedule.kind,
      dailyTime: task.schedule.daily_time,
      weeklyDays: task.schedule.weekly_days,
      weeklyTime: task.schedule.weekly_time,
      intervalHours: task.schedule.interval_hours,
    },
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    lastRunAt: task.last_run_at,
    lastStatus: task.last_status,
    lastMessage: task.last_message,
    lastSuccessCount: task.last_success_count,
    lastFailureCount: task.last_failure_count,
    lastDurationMs: task.last_duration_ms,
    nextRunAt: task.next_run_at,
  };
}

function fromRawTask(raw: RawCodexWakeupTask): CodexWakeupTask {
  return {
    id: raw.id,
    name: raw.name,
    enabled: raw.enabled,
    account_ids: raw.accountIds ?? [],
    prompt: raw.prompt,
    schedule: {
      kind: raw.schedule.kind,
      daily_time: raw.schedule.dailyTime,
      weekly_days: raw.schedule.weeklyDays ?? [],
      weekly_time: raw.schedule.weeklyTime,
      interval_hours: raw.schedule.intervalHours,
    },
    created_at: raw.createdAt,
    updated_at: raw.updatedAt,
    last_run_at: raw.lastRunAt,
    last_status: raw.lastStatus,
    last_message: raw.lastMessage,
    last_success_count: raw.lastSuccessCount,
    last_failure_count: raw.lastFailureCount,
    last_duration_ms: raw.lastDurationMs,
    next_run_at: raw.nextRunAt,
  };
}

function fromRawQuotaSnapshot(raw?: RawCodexQuotaSnapshot) {
  if (!raw) return undefined;
  return {
    hourly_percentage: raw.hourlyPercentage,
    hourly_reset_time: raw.hourlyResetTime,
    weekly_percentage: raw.weeklyPercentage,
    weekly_reset_time: raw.weeklyResetTime,
  };
}

function fromRawHistoryItem(raw: RawCodexWakeupHistoryItem): CodexWakeupHistoryItem {
  return {
    id: raw.id,
    run_id: raw.runId,
    timestamp: raw.timestamp,
    trigger_type: raw.triggerType,
    task_id: raw.taskId,
    task_name: raw.taskName,
    account_id: raw.accountId,
    account_email: raw.accountEmail,
    account_context_text: raw.accountContextText,
    success: raw.success,
    prompt: raw.prompt,
    reply: raw.reply,
    error: raw.error,
    quota_refresh_error: raw.quotaRefreshError,
    duration_ms: raw.durationMs,
    cli_path: raw.cliPath,
    quota_before: fromRawQuotaSnapshot(raw.quotaBefore),
    quota_after: fromRawQuotaSnapshot(raw.quotaAfter),
  };
}

function fromRawState(raw: RawCodexWakeupState): CodexWakeupState {
  return {
    enabled: raw.enabled,
    tasks: (raw.tasks ?? []).map(fromRawTask),
  };
}

function fromRawBatchResult(raw: RawCodexWakeupBatchResult): CodexWakeupBatchResult {
  return {
    run_id: raw.runId,
    runtime: fromRawCliStatus(raw.runtime),
    records: (raw.records ?? []).map(fromRawHistoryItem),
    success_count: raw.successCount,
    failure_count: raw.failureCount,
  };
}

export function fromRawWakeupProgressPayload(
  raw: RawCodexWakeupProgressPayload,
): CodexWakeupProgressPayload {
  return {
    run_id: raw.runId,
    trigger_type: raw.triggerType,
    task_id: raw.taskId,
    task_name: raw.taskName,
    total: raw.total,
    completed: raw.completed,
    success_count: raw.successCount,
    failure_count: raw.failureCount,
    running: raw.running,
    phase: raw.phase,
    current_account_id: raw.currentAccountId,
    item: raw.item ? fromRawHistoryItem(raw.item) : undefined,
  };
}

export async function getCodexWakeupCliStatus(): Promise<CodexCliStatus> {
  return fromRawCliStatus(await invoke<RawCodexCliStatus>('codex_wakeup_get_cli_status'));
}

export async function getCodexWakeupState(): Promise<CodexWakeupState> {
  return fromRawState(await invoke<RawCodexWakeupState>('codex_wakeup_get_state'));
}

export async function saveCodexWakeupState(
  enabled: boolean,
  tasks: CodexWakeupTask[],
): Promise<CodexWakeupState> {
  return fromRawState(
    await invoke<RawCodexWakeupState>('codex_wakeup_save_state', {
      enabled,
      tasks: tasks.map(toRawTask),
    }),
  );
}

export async function loadCodexWakeupHistory(): Promise<CodexWakeupHistoryItem[]> {
  return (await invoke<RawCodexWakeupHistoryItem[]>('codex_wakeup_load_history')).map(fromRawHistoryItem);
}

export async function clearCodexWakeupHistory(): Promise<void> {
  return await invoke('codex_wakeup_clear_history');
}

export async function testCodexWakeup(
  accountIds: string[],
  runId: string,
  prompt?: string,
): Promise<CodexWakeupBatchResult> {
  return fromRawBatchResult(
    await invoke<RawCodexWakeupBatchResult>('codex_wakeup_test', {
      accountIds,
      runId,
      prompt: prompt ?? null,
    }),
  );
}

export async function runCodexWakeupTask(taskId: string, runId: string): Promise<CodexWakeupBatchResult> {
  return fromRawBatchResult(
    await invoke<RawCodexWakeupBatchResult>('codex_wakeup_run_task', { taskId, runId }),
  );
}
