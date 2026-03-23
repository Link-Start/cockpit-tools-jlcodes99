export interface CodexCliInstallHint {
  label: string;
  command: string;
}

export interface CodexCliStatus {
  available: boolean;
  binary_path?: string;
  version?: string;
  source?: string;
  message?: string;
  checked_at: number;
  install_hints: CodexCliInstallHint[];
}

export type CodexWakeupScheduleKind = 'daily' | 'weekly' | 'interval';

export interface CodexWakeupSchedule {
  kind: CodexWakeupScheduleKind;
  daily_time?: string;
  weekly_days: number[];
  weekly_time?: string;
  interval_hours?: number;
}

export interface CodexWakeupTask {
  id: string;
  name: string;
  enabled: boolean;
  account_ids: string[];
  prompt?: string;
  schedule: CodexWakeupSchedule;
  created_at: number;
  updated_at: number;
  last_run_at?: number;
  last_status?: string;
  last_message?: string;
  last_success_count?: number;
  last_failure_count?: number;
  last_duration_ms?: number;
  next_run_at?: number;
}

export interface CodexWakeupState {
  enabled: boolean;
  tasks: CodexWakeupTask[];
}

export interface CodexQuotaSnapshot {
  hourly_percentage?: number;
  hourly_reset_time?: number;
  weekly_percentage?: number;
  weekly_reset_time?: number;
}

export interface CodexWakeupHistoryItem {
  id: string;
  run_id: string;
  timestamp: number;
  trigger_type: string;
  task_id?: string;
  task_name?: string;
  account_id: string;
  account_email: string;
  account_context_text?: string;
  success: boolean;
  prompt?: string;
  reply?: string;
  error?: string;
  quota_refresh_error?: string;
  duration_ms?: number;
  cli_path?: string;
  quota_before?: CodexQuotaSnapshot;
  quota_after?: CodexQuotaSnapshot;
}

export interface CodexWakeupBatchResult {
  run_id: string;
  runtime: CodexCliStatus;
  records: CodexWakeupHistoryItem[];
  success_count: number;
  failure_count: number;
}

export interface CodexWakeupProgressPayload {
  run_id: string;
  trigger_type: string;
  task_id?: string;
  task_name?: string;
  total: number;
  completed: number;
  success_count: number;
  failure_count: number;
  running: boolean;
  phase: string;
  current_account_id?: string;
  item?: CodexWakeupHistoryItem;
}
