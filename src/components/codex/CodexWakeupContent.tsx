import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog';
import {
  Check,
  CircleAlert,
  Copy,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  CodexAccount,
  getCodexAuthMetadata,
  isCodexApiKeyAccount,
  isCodexTeamLikePlan,
} from '../../types/codex';
import { buildCodexAccountPresentation } from '../../presentation/platformAccountPresentation';
import {
  CodexWakeupBatchResult,
  CodexWakeupHistoryItem,
  CodexWakeupProgressPayload,
  CodexWakeupScheduleKind,
  CodexWakeupTask,
} from '../../types/codexWakeup';
import { useCodexWakeupStore } from '../../stores/useCodexWakeupStore';
import { fromRawWakeupProgressPayload } from '../../services/codexWakeupService';
import { AccountTagFilterDropdown } from '../AccountTagFilterDropdown';
import { ModalErrorMessage, useModalErrorState } from '../ModalErrorMessage';
import {
  MultiSelectFilterDropdown,
  type MultiSelectFilterOption,
} from '../MultiSelectFilterDropdown';

interface CodexWakeupContentProps {
  accounts: CodexAccount[];
  onRefreshAccounts: () => Promise<void>;
}

interface TaskDraft {
  id?: string;
  createdAt?: number;
  name: string;
  enabled: boolean;
  accountIds: string[];
  prompt: string;
  scheduleKind: CodexWakeupScheduleKind;
  dailyTime: string;
  weeklyDays: number[];
  weeklyTime: string;
  intervalHours: string;
}

interface AccountPickerFilters {
  query: string;
  planTypes: string[];
  tags: string[];
}

type ExecutionRecordStatus = 'pending' | 'running' | 'success' | 'error';

interface ExecutionRecordState {
  id: string;
  accountId: string;
  accountEmail: string;
  accountContextText?: string;
  triggerType: string;
  status: ExecutionRecordStatus;
  prompt?: string;
  reply?: string;
  error?: string;
  timestamp?: number;
  durationMs?: number;
}

interface ExecutionSessionState {
  runId: string;
  triggerType: string;
  title: string;
  runtime: CodexWakeupBatchResult['runtime'] | null;
  startedAt: number;
  durationMs?: number;
  total: number;
  completed: number;
  successCount: number;
  failureCount: number;
  taskName?: string;
  running: boolean;
  errorText?: string;
  records: ExecutionRecordState[];
}

interface HistoryBatchSummary {
  runId: string;
  triggerType: string;
  taskName?: string;
  timestamp: number;
  total: number;
  successCount: number;
  failureCount: number;
  durationMs?: number;
  cliPath?: string;
  records: CodexWakeupHistoryItem[];
}

type ExecutionRecordFilter = 'all' | ExecutionRecordStatus;

const WEEKDAY_OPTIONS = [
  { value: 1, short: 'Mon' },
  { value: 2, short: 'Tue' },
  { value: 3, short: 'Wed' },
  { value: 4, short: 'Thu' },
  { value: 5, short: 'Fri' },
  { value: 6, short: 'Sat' },
  { value: 0, short: 'Sun' },
];

const DEFAULT_PROMPT = 'hi';
const QUICK_TIME_OPTIONS = ['07:00', '08:00', '09:00', '10:00', '14:00', '18:00', '22:00'];

function createEmptyAccountPickerFilters(): AccountPickerFilters {
  return {
    query: '',
    planTypes: [],
    tags: [],
  };
}

function toggleStringSelection(values: string[], target: string) {
  return values.includes(target)
    ? values.filter((item) => item !== target)
    : [...values, target];
}

function normalizeWakeupTag(value: string) {
  return value.trim().toLowerCase();
}

function resolveWakeupPlanBucket(planClass?: string) {
  const upper = (planClass || '').trim().toUpperCase();
  if (!upper || upper === 'FREE') return 'FREE';
  if (upper.includes('ENTERPRISE')) return 'ENTERPRISE';
  if (upper.includes('TEAM') || upper.includes('BUSINESS') || upper.includes('EDU')) return 'TEAM';
  if (upper.includes('PLUS')) return 'PLUS';
  if (upper.includes('PRO')) return 'PRO';
  return 'OTHER';
}

function createEmptyTaskDraft(): TaskDraft {
  return {
    name: '',
    enabled: true,
    accountIds: [],
    prompt: '',
    scheduleKind: 'daily',
    dailyTime: '09:00',
    weeklyDays: [1, 2, 3, 4, 5],
    weeklyTime: '10:00',
    intervalHours: '6',
  };
}

function buildTaskDraft(task: CodexWakeupTask): TaskDraft {
  return {
    id: task.id,
    createdAt: task.created_at,
    name: task.name,
    enabled: task.enabled,
    accountIds: task.account_ids,
    prompt: task.prompt ?? '',
    scheduleKind: task.schedule.kind,
    dailyTime: task.schedule.daily_time ?? '09:00',
    weeklyDays: task.schedule.weekly_days.length > 0 ? task.schedule.weekly_days : [1, 2, 3, 4, 5],
    weeklyTime: task.schedule.weekly_time ?? '10:00',
    intervalHours: String(task.schedule.interval_hours ?? 6),
  };
}

function formatDateTime(value?: number) {
  if (!value) return '—';
  return new Date(value * 1000).toLocaleString();
}

function formatHistoryTimestamp(value?: number) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function formatDuration(value?: number) {
  if (!value && value !== 0) return '—';
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatTaskLastResult(
  task: CodexWakeupTask,
  t: ReturnType<typeof useTranslation>['t'],
) {
  const successCount = task.last_success_count ?? 0;
  const failureCount = task.last_failure_count ?? 0;
  if (successCount > 0 || failureCount > 0) {
    if (failureCount === 0) {
      return t('codex.wakeup.lastStatusSuccessSummary', { count: successCount });
    }
    if (successCount === 0) {
      return t('codex.wakeup.lastStatusFailedSummary', { count: failureCount });
    }
    return t('codex.wakeup.lastStatusMixedSummary', {
      success: successCount,
      failed: failureCount,
    });
  }
  if (task.last_status === 'success') {
    return t('common.success');
  }
  if (task.last_status === 'error') {
    return t('codex.wakeup.historyFailed');
  }
  return task.last_message || t('codex.wakeup.lastStatusIdle');
}

function executionStatusFromRecord(record: CodexWakeupHistoryItem): ExecutionRecordStatus {
  return record.success ? 'success' : 'error';
}

function scheduleSummary(task: CodexWakeupTask, t: ReturnType<typeof useTranslation>['t']) {
  const schedule = task.schedule;
  if (schedule.kind === 'daily') {
    return t('codex.wakeup.scheduleDailySummary', { time: schedule.daily_time || '09:00' });
  }
  if (schedule.kind === 'weekly') {
    const days = (schedule.weekly_days || [])
      .map((day) => t(`codex.wakeup.weekdays.${day}`))
      .join(' / ');
    return t('codex.wakeup.scheduleWeeklySummary', {
      days: days || t('codex.wakeup.weekdaysFallback'),
      time: schedule.weekly_time || '10:00',
    });
  }
  return t('codex.wakeup.scheduleIntervalSummary', {
    hours: schedule.interval_hours ?? 6,
  });
}

function triggerLabel(triggerType: string, t: ReturnType<typeof useTranslation>['t']) {
  if (triggerType === 'scheduled') return t('codex.wakeup.triggerScheduled');
  if (triggerType === 'manual_task') return t('codex.wakeup.triggerManualTask');
  return t('codex.wakeup.triggerTest');
}

function executionStatusLabel(
  status: ExecutionRecordStatus,
  t: ReturnType<typeof useTranslation>['t'],
) {
  if (status === 'running') return t('codex.wakeup.executionStatusRunning');
  if (status === 'pending') return t('codex.wakeup.executionStatusPending');
  if (status === 'success') return t('codex.wakeup.historySuccess');
  return t('codex.wakeup.historyFailed');
}

function filterAllLabel(t: ReturnType<typeof useTranslation>['t']) {
  return t('common.shared.filter.all', { count: 0 }).replace(/\s*[（(]\s*\d+\s*[)）]\s*$/u, '');
}

function deriveStateEnabled(tasks: CodexWakeupTask[]) {
  return tasks.some((task) => task.enabled);
}

function formatSelectionPreview(values: string[], limit: number = 2) {
  if (values.length === 0) return '—';
  if (values.length <= limit) return values.join(' / ');
  return `${values.slice(0, limit).join(' / ')} +${values.length - limit}`;
}

function resolveAccountContextText(
  account: CodexAccount,
  t: ReturnType<typeof useTranslation>['t'],
) {
  const metadata = getCodexAuthMetadata(account);
  const organizationId = (account.organization_id || '').trim();
  const matchedWorkspace = organizationId
    ? metadata.workspaces.find((workspace) => (workspace.id || '').trim() === organizationId)
    : null;
  const defaultWorkspace = metadata.workspaces.find((workspace) => workspace.is_default);
  const fallbackWorkspace = matchedWorkspace || defaultWorkspace || metadata.workspaces[0] || null;
  const workspaceTitle = fallbackWorkspace?.title?.trim() || '';
  const accountName = (account.account_name || '').trim();
  const structure = (account.account_structure || '').trim().toLowerCase();
  const isTeamLikePlan = isCodexTeamLikePlan(account.plan_type);
  const isPersonalStructure = structure.includes('personal');

  if (isPersonalStructure || (!structure && !isTeamLikePlan)) {
    return t('codex.account.personal', '个人账户');
  }

  return accountName || workspaceTitle || '';
}

function parseTimeValue(value: string) {
  const parts = value.trim().split(':');
  if (parts.length !== 2) return null;
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function atLocalTime(base: Date, time: string) {
  const parsed = parseTimeValue(time);
  if (!parsed) return null;
  const next = new Date(base);
  next.setHours(parsed.hour, parsed.minute, 0, 0);
  return next;
}

function calculatePreviewRuns(taskDraft: TaskDraft, count: number = 5) {
  const runs: Date[] = [];
  const now = new Date();

  if (taskDraft.scheduleKind === 'daily') {
    for (let offset = 0; offset < 14 && runs.length < count; offset += 1) {
      const date = new Date(now);
      date.setDate(now.getDate() + offset);
      const candidate = atLocalTime(date, taskDraft.dailyTime);
      if (candidate && candidate.getTime() > now.getTime()) {
        runs.push(candidate);
      }
    }
    return runs;
  }

  if (taskDraft.scheduleKind === 'weekly') {
    for (let offset = 0; offset < 21 && runs.length < count; offset += 1) {
      const date = new Date(now);
      date.setDate(now.getDate() + offset);
      if (!taskDraft.weeklyDays.includes(date.getDay())) continue;
      const candidate = atLocalTime(date, taskDraft.weeklyTime);
      if (candidate && candidate.getTime() > now.getTime()) {
        runs.push(candidate);
      }
    }
    return runs;
  }

  const intervalHours = Math.max(1, Number(taskDraft.intervalHours) || 1);
  for (let index = 1; index <= count; index += 1) {
    runs.push(new Date(now.getTime() + intervalHours * index * 60 * 60 * 1000));
  }
  return runs;
}

export function CodexWakeupContent({ accounts, onRefreshAccounts }: CodexWakeupContentProps) {
  const { t } = useTranslation();
  const {
    runtime,
    state,
    history,
    loading,
    saving,
    runningTaskId,
    testing,
    error,
    loadAll,
    refreshRuntime,
    saveState,
    runTask,
    runTest,
    clearHistory,
  } = useCodexWakeupStore();

  const oauthAccounts = useMemo(
    () => accounts.filter((account) => !isCodexApiKeyAccount(account)),
    [accounts],
  );
  const accountMap = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const wakeupAccountMetaMap = useMemo(() => {
    const map = new Map<
      string,
      {
        email: string;
        contextText: string;
        planLabel: string;
        planClass: string;
        planBucket: string;
      }
    >();
    oauthAccounts.forEach((account) => {
      const presentation = buildCodexAccountPresentation(account, t);
      map.set(account.id, {
        email: (account.email || account.id).trim() || account.id,
        contextText: resolveAccountContextText(account, t),
        planLabel: presentation.planLabel,
        planClass: presentation.planClass || 'unknown',
        planBucket: resolveWakeupPlanBucket(presentation.planClass),
      });
    });
    return map;
  }, [oauthAccounts, t]);
  const wakeupAvailableTags = useMemo(() => {
    const uniqueTags = new Set<string>();
    oauthAccounts.forEach((account) => {
      (account.tags || [])
        .map((tag) => tag.trim())
        .filter(Boolean)
        .forEach((tag) => uniqueTags.add(tag));
    });
    return Array.from(uniqueTags).sort((left, right) => left.localeCompare(right));
  }, [oauthAccounts]);
  const wakeupTierCounts = useMemo(() => {
    const counts = {
      all: oauthAccounts.length,
      FREE: 0,
      PLUS: 0,
      PRO: 0,
      TEAM: 0,
      ENTERPRISE: 0,
      OTHER: 0,
    };
    oauthAccounts.forEach((account) => {
      const bucket = wakeupAccountMetaMap.get(account.id)?.planBucket || 'FREE';
      if (bucket in counts) {
        counts[bucket as keyof typeof counts] += 1;
      }
    });
    return counts;
  }, [oauthAccounts, wakeupAccountMetaMap]);
  const wakeupTierFilterOptions = useMemo<MultiSelectFilterOption[]>(() => {
    const options: MultiSelectFilterOption[] = [
      { value: 'FREE', label: `FREE (${wakeupTierCounts.FREE})` },
      { value: 'PLUS', label: `PLUS (${wakeupTierCounts.PLUS})` },
      { value: 'PRO', label: `PRO (${wakeupTierCounts.PRO})` },
      { value: 'TEAM', label: `TEAM (${wakeupTierCounts.TEAM})` },
      { value: 'ENTERPRISE', label: `ENTERPRISE (${wakeupTierCounts.ENTERPRISE})` },
    ];
    if (wakeupTierCounts.OTHER > 0) {
      options.push({ value: 'OTHER', label: `OTHER (${wakeupTierCounts.OTHER})` });
    }
    return options;
  }, [wakeupTierCounts]);

  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [taskDraft, setTaskDraft] = useState<TaskDraft>(createEmptyTaskDraft());
  const {
    message: taskModalError,
    scrollKey: taskModalErrorScrollKey,
    set: setTaskModalError,
  } = useModalErrorState();
  const [taskAccountFilters, setTaskAccountFilters] = useState<AccountPickerFilters>(createEmptyAccountPickerFilters());
  const [showTestModal, setShowTestModal] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [testAccountIds, setTestAccountIds] = useState<string[]>([]);
  const [testPrompt, setTestPrompt] = useState('');
  const {
    message: testModalError,
    scrollKey: testModalErrorScrollKey,
    set: setTestModalError,
  } = useModalErrorState();
  const [testAccountFilters, setTestAccountFilters] = useState<AccountPickerFilters>(createEmptyAccountPickerFilters());
  const [executionSession, setExecutionSession] = useState<ExecutionSessionState | null>(null);
  const [executionFilter, setExecutionFilter] = useState<ExecutionRecordFilter>('all');
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [showRuntimeGuideModal, setShowRuntimeGuideModal] = useState(false);
  const [runtimeGuideRefreshing, setRuntimeGuideRefreshing] = useState(false);
  const [runtimeGuideAutoShown, setRuntimeGuideAutoShown] = useState(false);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadAll();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [loadAll]);

  useEffect(() => {
    if (error) {
      if (showTaskModal) {
        setTaskModalError(error);
      } else if (showTestModal) {
        setTestModalError(error);
      } else if (executionSession) {
        setExecutionSession((current) =>
          current ? { ...current, running: false, errorText: error } : current,
        );
      } else {
        setNotice({ tone: 'error', text: error });
      }
    }
  }, [error, executionSession, showTaskModal, showTestModal]);

  useEffect(() => {
    if (loading || runtime === null) {
      return;
    }
    if (runtime.available) {
      setShowRuntimeGuideModal(false);
      setRuntimeGuideAutoShown(false);
      return;
    }
    if (!runtimeGuideAutoShown) {
      setShowRuntimeGuideModal(true);
      setRuntimeGuideAutoShown(true);
    }
  }, [loading, runtime, runtimeGuideAutoShown]);

  const sortedTasks = useMemo(() => {
    const tasks = [...state.tasks];
    tasks.sort((left, right) => {
      if (left.enabled !== right.enabled) {
        return left.enabled ? -1 : 1;
      }
      const leftNext = left.next_run_at ?? Number.MAX_SAFE_INTEGER;
      const rightNext = right.next_run_at ?? Number.MAX_SAFE_INTEGER;
      if (leftNext !== rightNext) {
        return leftNext - rightNext;
      }
      return right.updated_at - left.updated_at;
    });
    return tasks;
  }, [state.tasks]);

  const historyBatches = useMemo<HistoryBatchSummary[]>(() => {
    const grouped = new Map<string, CodexWakeupHistoryItem[]>();
    history.forEach((item) => {
      const runId = item.run_id || item.id;
      const bucket = grouped.get(runId);
      if (bucket) {
        bucket.push(item);
      } else {
        grouped.set(runId, [item]);
      }
    });

    return Array.from(grouped.entries())
      .map(([runId, records]) => {
        const sorted = [...records].sort((left, right) => left.timestamp - right.timestamp);
        const latest = sorted[sorted.length - 1];
        const durationMs = sorted.reduce((sum, item) => sum + (item.duration_ms || 0), 0);
        const successCount = sorted.filter((item) => item.success).length;
        return {
          runId,
          triggerType: latest?.trigger_type || 'test',
          taskName: latest?.task_name,
          timestamp: latest?.timestamp || 0,
          total: sorted.length,
          successCount,
          failureCount: sorted.length - successCount,
          durationMs: durationMs > 0 ? durationMs : undefined,
          cliPath: sorted.find((item) => item.cli_path)?.cli_path,
          records: sorted.reverse(),
        };
      })
      .sort((left, right) => right.timestamp - left.timestamp);
  }, [history]);

  const buildExecutionSession = useCallback(
    (
      runId: string,
      triggerType: string,
      accountIds: string[],
      prompt?: string,
      taskName?: string,
    ): ExecutionSessionState => ({
      runId,
      triggerType,
      title:
        triggerType === 'test'
          ? t('codex.wakeup.testTitle')
          : taskName || t('codex.wakeup.resultsTitle'),
      runtime: runtime,
      startedAt: Date.now(),
      durationMs: undefined,
      total: accountIds.length,
      completed: 0,
      successCount: 0,
      failureCount: 0,
      taskName,
      running: true,
      errorText: undefined,
      records: accountIds.map((accountId, index) => {
        const account = accountMap.get(accountId);
        const meta = wakeupAccountMetaMap.get(accountId);
        return {
          id: `${runId}-${accountId}-${index}`,
          accountId,
          accountEmail: meta?.email || (account?.email || accountId),
          accountContextText: meta?.contextText || (account ? resolveAccountContextText(account, t) : undefined),
          triggerType,
          status: 'pending',
          prompt,
        };
      }),
    }),
    [accountMap, runtime, t, wakeupAccountMetaMap],
  );

  const buildExecutionSessionFromHistory = useCallback(
    (batch: HistoryBatchSummary): ExecutionSessionState => ({
      runId: batch.runId,
      triggerType: batch.triggerType,
      title:
        batch.taskName ||
        (batch.triggerType === 'test'
          ? t('codex.wakeup.testTitle')
          : t('codex.wakeup.resultsTitle')),
      runtime: batch.cliPath
        ? {
            available: true,
            binary_path: batch.cliPath,
            checked_at: batch.timestamp,
            install_hints: [],
          }
        : runtime,
      startedAt: batch.timestamp,
      durationMs: batch.durationMs,
      total: batch.total,
      completed: batch.total,
      successCount: batch.successCount,
      failureCount: batch.failureCount,
      taskName: batch.taskName,
      running: false,
      errorText: undefined,
      records: batch.records.map((item) => ({
        id: item.id,
        accountId: item.account_id,
        accountEmail: item.account_email,
        accountContextText: item.account_context_text,
        triggerType: item.trigger_type,
        status: executionStatusFromRecord(item),
        prompt: item.prompt,
        reply: item.reply,
        error: item.error,
        timestamp: item.timestamp,
        durationMs: item.duration_ms,
      })),
    }),
    [runtime, t],
  );

  useEffect(() => {
    setExecutionFilter('all');
  }, [executionSession?.runId]);

  const applyProgressPayload = useCallback((payload: CodexWakeupProgressPayload) => {
    setExecutionSession((current) => {
      if (!current || current.runId !== payload.run_id) {
        return current;
      }

      const nextRecords = current.records.map<ExecutionRecordState>((record) => {
        if (payload.current_account_id && record.accountId === payload.current_account_id) {
          if (payload.phase === 'account_started' && record.status === 'pending') {
            return { ...record, status: 'running' as const };
          }
          if (payload.phase === 'account_completed' && payload.item) {
            return {
              ...record,
              accountEmail: payload.item.account_email || record.accountEmail,
              accountContextText: payload.item.account_context_text || record.accountContextText,
              status: executionStatusFromRecord(payload.item),
              prompt: payload.item.prompt || record.prompt,
              reply: payload.item.reply,
              error: payload.item.error,
              timestamp: payload.item.timestamp,
              durationMs: payload.item.duration_ms,
              triggerType: payload.item.trigger_type || record.triggerType,
            };
          }
        }

        if (payload.phase === 'account_started' && record.status === 'running') {
          return { ...record, status: 'pending' as const };
        }

        return record;
      });

      return {
        ...current,
        triggerType: payload.trigger_type || current.triggerType,
        taskName: payload.task_name || current.taskName,
        total: payload.total,
        completed: payload.completed,
        successCount: payload.success_count,
        failureCount: payload.failure_count,
        running: payload.running,
        records: nextRecords,
      };
    });
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    void listen<Record<string, unknown>>('codex://wakeup-progress', (event) => {
      applyProgressPayload(fromRawWakeupProgressPayload(event.payload as never));
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [applyProgressPayload]);

  const previewRuns = useMemo(() => calculatePreviewRuns(taskDraft), [taskDraft]);
  const executionCounts = useMemo(() => {
    if (!executionSession) {
      return {
        pending: 0,
        running: 0,
      };
    }
    return {
      pending: executionSession.records.filter((item) => item.status === 'pending').length,
      running: executionSession.records.filter((item) => item.status === 'running').length,
    };
  }, [executionSession]);
  const filteredExecutionRecords = useMemo(() => {
    if (!executionSession) return [];
    if (executionFilter === 'all') return executionSession.records;
    return executionSession.records.filter((record) => record.status === executionFilter);
  }, [executionFilter, executionSession]);
  const executionDuration = useMemo(() => {
    if (!executionSession) return undefined;
    if (executionSession.durationMs !== undefined) return executionSession.durationMs;
    const totalDuration = executionSession.records.reduce(
      (sum, item) => sum + (item.durationMs || 0),
      0,
    );
    if (totalDuration > 0) return totalDuration;
    return undefined;
  }, [executionSession]);
  const executionFilterOptions = useMemo(
    () =>
      executionSession
        ? [
            {
              key: 'all' as const,
              label: filterAllLabel(t),
              count: executionSession.total,
              tone: 'all' as const,
            },
            {
              key: 'success' as const,
              label: t('codex.wakeup.resultsSuccess'),
              count: executionSession.successCount,
              tone: 'success' as const,
            },
            {
              key: 'error' as const,
              label: t('codex.wakeup.resultsFailed'),
              count: executionSession.failureCount,
              tone: 'error' as const,
            },
            {
              key: 'pending' as const,
              label: t('codex.wakeup.executionStatusPending'),
              count: executionCounts.pending,
              tone: 'pending' as const,
            },
            {
              key: 'running' as const,
              label: t('codex.wakeup.executionStatusRunning'),
              count: executionCounts.running,
              tone: 'running' as const,
            },
          ]
        : [],
    [executionCounts.pending, executionCounts.running, executionSession, t],
  );
  const filterWakeupAccounts = useCallback(
    (filters: AccountPickerFilters) => {
      const query = filters.query.trim().toLowerCase();
      const selectedPlanTypes = new Set(filters.planTypes);
      const selectedTags = new Set(filters.tags.map(normalizeWakeupTag));

      return oauthAccounts.filter((account) => {
        const meta = wakeupAccountMetaMap.get(account.id);
        const email = (meta?.email || account.email || account.id).toLowerCase();
        if (query && !email.includes(query)) {
          return false;
        }
        if (selectedPlanTypes.size > 0 && !selectedPlanTypes.has(meta?.planBucket || 'FREE')) {
          return false;
        }
        if (selectedTags.size > 0) {
          const accountTags = (account.tags || []).map(normalizeWakeupTag).filter(Boolean);
          if (!accountTags.some((tag) => selectedTags.has(tag))) {
            return false;
          }
        }
        return true;
      });
    },
    [oauthAccounts, wakeupAccountMetaMap],
  );
  const filteredTaskAccounts = useMemo(
    () => filterWakeupAccounts(taskAccountFilters),
    [filterWakeupAccounts, taskAccountFilters],
  );
  const filteredTestAccounts = useMemo(
    () => filterWakeupAccounts(testAccountFilters),
    [filterWakeupAccounts, testAccountFilters],
  );
  const allFilteredTaskSelected = useMemo(
    () =>
      filteredTaskAccounts.length > 0 &&
      filteredTaskAccounts.every((account) => taskDraft.accountIds.includes(account.id)),
    [filteredTaskAccounts, taskDraft.accountIds],
  );
  const allFilteredTestSelected = useMemo(
    () =>
      filteredTestAccounts.length > 0 &&
      filteredTestAccounts.every((account) => testAccountIds.includes(account.id)),
    [filteredTestAccounts, testAccountIds],
  );

  const copyCommand = useCallback(async (command: string) => {
    await navigator.clipboard.writeText(command);
    setCopiedCommand(command);
    window.setTimeout(() => setCopiedCommand(null), 1500);
  }, []);

  const renderInstallCommands = useCallback(
    (commands: { label: string; command: string }[]) => {
      if (commands.length === 0) return null;
      return (
        <div className="codex-wakeup-install-grid">
          {commands.map((hint) => (
            <div key={hint.label} className="codex-wakeup-install-command">
              <div className="codex-wakeup-install-command-head">
                <span>{hint.label}</span>
                <button className="btn btn-secondary" onClick={() => void copyCommand(hint.command)}>
                  {copiedCommand === hint.command ? <Check size={14} /> : <Copy size={14} />}
                  {copiedCommand === hint.command ? t('codex.wakeup.copied') : t('codex.wakeup.copyCommand')}
                </button>
              </div>
              <div className="codex-wakeup-install-terminal">
                <code>{hint.command}</code>
              </div>
            </div>
          ))}
        </div>
      );
    },
    [copiedCommand, copyCommand, t],
  );

  const renderWakeupAccountOption = useCallback(
    (account: CodexAccount, checked: boolean, onToggle: () => void) => {
      const meta = wakeupAccountMetaMap.get(account.id) ?? {
        email: (account.email || account.id).trim() || account.id,
        contextText: resolveAccountContextText(account, t),
        planLabel: buildCodexAccountPresentation(account, t).planLabel,
        planClass: buildCodexAccountPresentation(account, t).planClass || 'unknown',
        planBucket: resolveWakeupPlanBucket(buildCodexAccountPresentation(account, t).planClass),
      };
      return (
        <button
          key={account.id}
          type="button"
          className={`wakeup-chip codex-wakeup-account-chip ${checked ? 'selected' : ''}`}
          onClick={onToggle}
          title={[meta.email, meta.planLabel, meta.contextText].filter(Boolean).join(' · ')}
        >
          <div className="codex-wakeup-account-chip-head">
            <span className="codex-wakeup-account-chip-email">{meta.email}</span>
            <span className={`tier-badge ${meta.planClass}`}>{meta.planLabel}</span>
          </div>
          {meta.contextText && (
            <span className="codex-wakeup-account-chip-context">{meta.contextText}</span>
          )}
        </button>
      );
    },
    [t, wakeupAccountMetaMap],
  );

  const renderAccountPickerFilters = useCallback(
    (
      filters: AccountPickerFilters,
      setFilters: Dispatch<SetStateAction<AccountPickerFilters>>,
      filteredAccounts: CodexAccount[],
      allSelected: boolean,
      onToggleSelectAll: () => void,
    ) => (
      <>
        <div className="codex-wakeup-account-filter-toolbar">
          <label className="codex-wakeup-account-search">
            <Search size={16} className="codex-wakeup-account-search-icon" />
            <input
              type="text"
              value={filters.query}
              onChange={(event) =>
                setFilters((current) => ({ ...current, query: event.target.value }))
              }
              placeholder={t('codex.wakeup.accountSearchPlaceholder')}
            />
          </label>
          <div className="codex-wakeup-account-filter-actions">
            <MultiSelectFilterDropdown
              options={wakeupTierFilterOptions}
              selectedValues={filters.planTypes}
              allLabel={t('common.shared.filter.all', { count: wakeupTierCounts.all })}
              filterLabel={t('common.shared.filterLabel', '筛选')}
              clearLabel={t('accounts.clearFilter', '清空筛选')}
              emptyLabel={t('common.none', '暂无')}
              ariaLabel={t('common.shared.filterLabel', '筛选')}
              onToggleValue={(value) =>
                setFilters((current) => ({
                  ...current,
                  planTypes: toggleStringSelection(current.planTypes, value),
                }))
              }
              onClear={() =>
                setFilters((current) => ({
                  ...current,
                  planTypes: [],
                }))
              }
            />
            <AccountTagFilterDropdown
              availableTags={wakeupAvailableTags}
              selectedTags={filters.tags}
              onToggleTag={(tag) =>
                setFilters((current) => ({
                  ...current,
                  tags: toggleStringSelection(current.tags, tag),
                }))
              }
              onClear={() =>
                setFilters((current) => ({
                  ...current,
                  tags: [],
                }))
              }
            />
          </div>
        </div>
        <div className="codex-wakeup-account-selection-bar">
          <span className="codex-wakeup-account-selection-summary">
            {filteredAccounts.length === 0
              ? t('codex.wakeup.accountFilterEmpty')
              : t('codex.wakeup.accountFilteredCount', { count: filteredAccounts.length })}
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onToggleSelectAll}
            disabled={filteredAccounts.length === 0}
          >
            {allSelected
              ? `${t('wakeup.verification.actions.clearSelectedAccounts')} (${filteredAccounts.length})`
              : `${t('wakeup.verification.actions.selectAllAccounts')} (${filteredAccounts.length})`}
          </button>
        </div>
      </>
    ),
    [t, wakeupAvailableTags, wakeupTierCounts.all, wakeupTierFilterOptions],
  );

  const openRuntimeGuideModal = useCallback(() => {
    setShowRuntimeGuideModal(true);
  }, []);

  const closeRuntimeGuideModal = useCallback(() => {
    if (runtimeGuideRefreshing) return;
    setShowRuntimeGuideModal(false);
  }, [runtimeGuideRefreshing]);

  const handleRefreshRuntimeGuide = useCallback(async () => {
    setRuntimeGuideRefreshing(true);
    try {
      await loadAll();
    } finally {
      setRuntimeGuideRefreshing(false);
    }
  }, [loadAll]);

  const openNewTaskModal = useCallback(async () => {
    if (runtime && !runtime.available) {
      openRuntimeGuideModal();
      return;
    }
    setTaskDraft(createEmptyTaskDraft());
    setTaskModalError(null);
    setTaskAccountFilters(createEmptyAccountPickerFilters());
    setShowTaskModal(true);
  }, [openRuntimeGuideModal, runtime]);

  const openEditTaskModal = useCallback((task: CodexWakeupTask) => {
    setTaskDraft(buildTaskDraft(task));
    setTaskModalError(null);
    setTaskAccountFilters(createEmptyAccountPickerFilters());
    setShowTaskModal(true);
  }, []);

  const openTestModal = useCallback(async () => {
    if (runtime && !runtime.available) {
      openRuntimeGuideModal();
      return;
    }
    setTestModalError(null);
    setTestAccountFilters(createEmptyAccountPickerFilters());
    setShowTestModal(true);
  }, [openRuntimeGuideModal, runtime]);

  const closeTaskModal = useCallback(() => {
    if (saving) return;
    setShowTaskModal(false);
    setTaskModalError(null);
    setTaskDraft(createEmptyTaskDraft());
  }, [saving]);

  const closeTestModal = useCallback(() => {
    if (testing) return;
    setShowTestModal(false);
    setTestModalError(null);
  }, [testing]);

  const persistTasks = useCallback(
    async (enabled: boolean, tasks: CodexWakeupTask[]) => {
      const next = await saveState(enabled, tasks);
      setNotice({
        tone: 'success',
        text: enabled
          ? t('codex.wakeup.noticeSavedEnabled', { count: next.tasks.length })
          : t('codex.wakeup.noticeSavedDisabled', { count: next.tasks.length }),
      });
      return next;
    },
    [saveState, t],
  );

  const toggleAllTasks = useCallback(async () => {
    if (state.tasks.length === 0) return;
    const nextEnabled = !state.enabled;
    const nextTasks = state.tasks.map((task) => ({ ...task, enabled: nextEnabled }));
    await persistTasks(nextEnabled, nextTasks);
  }, [persistTasks, state.enabled, state.tasks]);

  const handleDeleteTask = useCallback(
    async (task: CodexWakeupTask) => {
      const confirmed = await confirmDialog(
        t('codex.wakeup.deleteConfirm', { name: task.name }),
        {
          title: t('common.confirm', '确认'),
          kind: 'warning',
        },
      );
      if (!confirmed) return;
      const nextTasks = state.tasks.filter((item) => item.id !== task.id);
      await persistTasks(deriveStateEnabled(nextTasks), nextTasks);
    },
    [persistTasks, state.tasks, t],
  );

  const handleToggleTask = useCallback(
    async (task: CodexWakeupTask) => {
      const nextTasks = state.tasks.map((item) =>
        item.id === task.id ? { ...item, enabled: !item.enabled } : item,
      );
      await persistTasks(deriveStateEnabled(nextTasks), nextTasks);
    },
    [persistTasks, state.tasks],
  );

  const handleSaveTask = useCallback(async () => {
    const trimmedName = taskDraft.name.trim();
    if (!trimmedName) {
      setTaskModalError(t('codex.wakeup.taskNameRequired'));
      return;
    }
    if (taskDraft.accountIds.length === 0) {
      setTaskModalError(t('codex.wakeup.taskAccountsRequired'));
      return;
    }
    if (taskDraft.scheduleKind === 'weekly' && taskDraft.weeklyDays.length === 0) {
      setTaskModalError(t('codex.wakeup.weeklyDaysRequired'));
      return;
    }
    setTaskModalError(null);

    const now = Math.floor(Date.now() / 1000);
    const existingTask = taskDraft.id
      ? state.tasks.find((item) => item.id === taskDraft.id)
      : undefined;
    const nextTask: CodexWakeupTask = {
      id: taskDraft.id ?? crypto.randomUUID(),
      name: trimmedName,
      enabled: taskDraft.enabled,
      account_ids: taskDraft.accountIds,
      prompt: taskDraft.prompt.trim() || undefined,
      schedule: {
        kind: taskDraft.scheduleKind,
        daily_time: taskDraft.scheduleKind === 'daily' ? taskDraft.dailyTime : undefined,
        weekly_days: taskDraft.scheduleKind === 'weekly' ? taskDraft.weeklyDays : [],
        weekly_time: taskDraft.scheduleKind === 'weekly' ? taskDraft.weeklyTime : undefined,
        interval_hours:
          taskDraft.scheduleKind === 'interval'
            ? Math.max(1, Number(taskDraft.intervalHours) || 1)
            : undefined,
      },
      created_at: existingTask?.created_at ?? taskDraft.createdAt ?? now,
      updated_at: now,
      last_run_at: existingTask?.last_run_at,
      last_status: existingTask?.last_status,
      last_message: existingTask?.last_message,
      last_success_count: existingTask?.last_success_count,
      last_failure_count: existingTask?.last_failure_count,
      last_duration_ms: existingTask?.last_duration_ms,
      next_run_at: existingTask?.next_run_at,
    };

    const nextTasks = taskDraft.id
      ? state.tasks.map((item) => (item.id === taskDraft.id ? { ...item, ...nextTask } : item))
      : [nextTask, ...state.tasks];
    try {
      await persistTasks(deriveStateEnabled(nextTasks), nextTasks);
      setShowTaskModal(false);
      setTaskModalError(null);
    } catch (error) {
      setTaskModalError(String(error));
    }
  }, [persistTasks, state.tasks, t, taskDraft]);

  const handleRunTask = useCallback(
    async (task: CodexWakeupTask) => {
      const runId = crypto.randomUUID();
      setExecutionSession(
        buildExecutionSession(runId, 'manual_task', task.account_ids, task.prompt, task.name),
      );
      try {
        const result = await runTask(task.id, runId);
        await onRefreshAccounts();
        setExecutionSession((current) =>
          current && current.runId === runId
            ? {
                ...current,
                runtime: result.runtime,
                completed: result.records.length,
                total: result.records.length,
                successCount: result.success_count,
                failureCount: result.failure_count,
                durationMs: result.records.reduce((sum, item) => sum + (item.duration_ms || 0), 0),
                running: false,
                records: current.records.map((record) => {
                  const matched = result.records.find((item) => item.account_id === record.accountId);
                  if (!matched) {
                    return record;
                  }
                  return {
                    ...record,
                    accountEmail: matched.account_email || record.accountEmail,
                    accountContextText: matched.account_context_text || record.accountContextText,
                    status: executionStatusFromRecord(matched),
                    prompt: matched.prompt || record.prompt,
                    reply: matched.reply,
                    error: matched.error,
                    timestamp: matched.timestamp,
                    durationMs: matched.duration_ms,
                    triggerType: matched.trigger_type || record.triggerType,
                  };
                }),
              }
            : current,
        );
        setNotice({
          tone: result.failure_count > 0 ? 'error' : 'success',
          text:
            result.failure_count > 0
              ? t('codex.wakeup.noticeTaskFinishedWithError', {
                  success: result.success_count,
                  failed: result.failure_count,
                })
              : t('codex.wakeup.noticeTaskFinished', { count: result.success_count }),
        });
      } catch (error) {
        setExecutionSession((current) =>
          current && current.runId === runId
            ? { ...current, running: false, errorText: String(error) }
            : current,
        );
      }
    },
    [buildExecutionSession, onRefreshAccounts, runTask, t],
  );

  const handleRunTest = useCallback(async () => {
    if (testAccountIds.length === 0) {
      setTestModalError(t('codex.wakeup.testAccountsRequired'));
      return;
    }
    setTestModalError(null);
    const runId = crypto.randomUUID();
    const promptValue = testPrompt.trim() || undefined;
    setExecutionSession(buildExecutionSession(runId, 'test', testAccountIds, promptValue));
    setShowTestModal(false);
    try {
      const result = await runTest(testAccountIds, runId, promptValue);
      await onRefreshAccounts();
      setExecutionSession((current) =>
        current && current.runId === runId
          ? {
              ...current,
              runtime: result.runtime,
              completed: result.records.length,
              total: result.records.length,
              successCount: result.success_count,
              failureCount: result.failure_count,
              durationMs: result.records.reduce((sum, item) => sum + (item.duration_ms || 0), 0),
              running: false,
              records: current.records.map((record) => {
                const matched = result.records.find((item) => item.account_id === record.accountId);
                if (!matched) {
                  return record;
                }
                return {
                  ...record,
                  accountEmail: matched.account_email || record.accountEmail,
                  accountContextText: matched.account_context_text || record.accountContextText,
                  status: executionStatusFromRecord(matched),
                  prompt: matched.prompt || record.prompt,
                  reply: matched.reply,
                  error: matched.error,
                  timestamp: matched.timestamp,
                  durationMs: matched.duration_ms,
                  triggerType: matched.trigger_type || record.triggerType,
                };
              }),
            }
          : current,
      );
      setTestAccountIds([]);
      setTestPrompt('');
      setNotice({
        tone: result.failure_count > 0 ? 'error' : 'success',
        text:
          result.failure_count > 0
            ? t('codex.wakeup.noticeTestFinishedWithError', {
                success: result.success_count,
                failed: result.failure_count,
              })
            : t('codex.wakeup.noticeTestFinished', { count: result.success_count }),
      });
    } catch (error) {
      setExecutionSession((current) =>
        current && current.runId === runId
          ? { ...current, running: false, errorText: String(error) }
          : current,
      );
    }
  }, [buildExecutionSession, onRefreshAccounts, runTest, t, testAccountIds, testPrompt]);

  const handleClearHistory = useCallback(async () => {
    const confirmed = await confirmDialog(t('codex.wakeup.clearHistoryConfirm'), {
      title: t('common.confirm', '确认'),
      kind: 'warning',
    });
    if (!confirmed) return;
    await clearHistory();
    setNotice({ tone: 'success', text: t('codex.wakeup.historyCleared') });
  }, [clearHistory, t]);

  return (
    <div className="wakeup-page codex-wakeup-content">
      {notice && (
        <div className={`action-message ${notice.tone}`}>
          <span className="action-message-text">{notice.text}</span>
          <button className="action-message-close" onClick={() => setNotice(null)} aria-label={t('common.close')}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="toolbar wakeup-toolbar">
        <div className="toolbar-left">
          <div className={`wakeup-global-toggle ${state.enabled ? 'is-on' : 'is-off'}`}>
            <span className="toggle-label">{t('codex.wakeup.tab')}</span>
            <span className={`pill ${state.enabled ? 'pill-success' : 'pill-secondary'}`}>
              {state.enabled ? t('codex.wakeup.taskEnabled') : t('codex.wakeup.taskPaused')}
            </span>
            <label
              className="wakeup-switch"
              onClick={(event) => {
                event.preventDefault();
                void toggleAllTasks();
              }}
            >
              <input type="checkbox" checked={state.enabled} readOnly />
              <span className="wakeup-slider" />
            </label>
          </div>
        </div>
        <div className="toolbar-right">
          <button className="btn btn-primary" onClick={() => void openNewTaskModal()} disabled={oauthAccounts.length === 0}>
            <Plus size={16} /> {t('codex.wakeup.addTask')}
          </button>
          <button className="btn btn-secondary" onClick={() => void openTestModal()} disabled={oauthAccounts.length === 0}>
            {t('codex.wakeup.testNow')}
          </button>
          <button className="btn btn-secondary" onClick={() => setShowHistoryModal(true)}>
            {history.length > 0 ? `${t('codex.wakeup.historyTitle')} (${history.length})` : t('codex.wakeup.historyTitle')}
          </button>
          <button className="btn btn-secondary" onClick={() => void refreshRuntime()}>
            <RefreshCw size={16} /> {t('codex.wakeup.refreshRuntime')}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="loading-container">
          <RefreshCw size={24} className="loading-spinner" />
          <p>{t('common.loading', '加载中...')}</p>
        </div>
      ) : sortedTasks.length === 0 ? (
        <div className="empty-state">
          <div className="icon">
            <Power size={40} />
          </div>
          <h3>{t('codex.wakeup.emptyTitle')}</h3>
          <p>{t('codex.wakeup.emptyDesc')}</p>
          <button className="btn btn-primary" onClick={() => void openNewTaskModal()} disabled={oauthAccounts.length === 0}>
            <Plus size={18} /> {t('codex.wakeup.addTask')}
          </button>
        </div>
      ) : (
        <div className="wakeup-task-grid">
          {sortedTasks.map((task) => {
            const accountLabels = task.account_ids.map((accountId) => accountMap.get(accountId)?.email || accountId);
            return (
              <div key={task.id} className={`wakeup-task-card ${task.enabled ? 'is-enabled' : 'is-disabled'}`}>
                <div className="wakeup-task-header">
                  <div className="wakeup-task-title">
                    <span>{task.name}</span>
                    <span className={`pill ${task.enabled ? 'pill-success' : 'pill-secondary'}`}>
                      {task.enabled ? t('codex.wakeup.taskEnabled') : t('codex.wakeup.taskPaused')}
                    </span>
                  </div>
                  <div className="wakeup-task-actions">
                    <button
                      className="btn btn-secondary icon-only"
                      onClick={() => void handleRunTask(task)}
                      disabled={runningTaskId === task.id}
                      title={t('codex.wakeup.testNow')}
                    >
                      {runningTaskId === task.id ? <RefreshCw size={14} className="loading-spinner" /> : <Play size={14} />}
                    </button>
                    <button
                      className="btn btn-secondary icon-only"
                      onClick={() => openEditTaskModal(task)}
                      title={t('common.edit', '编辑')}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className="btn btn-secondary icon-only"
                      onClick={() => void handleToggleTask(task)}
                      title={task.enabled ? t('codex.wakeup.pauseOne') : t('codex.wakeup.resumeOne')}
                    >
                      <Power size={14} />
                    </button>
                    <button
                      className="btn btn-danger icon-only"
                      onClick={() => void handleDeleteTask(task)}
                      title={t('common.delete')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <div className="wakeup-task-section wakeup-task-section-primary">
                  <div className="wakeup-task-meta wakeup-task-meta-schedule">
                    <span>{scheduleSummary(task, t)}</span>
                  </div>
                </div>

                <div className="wakeup-task-section">
                  <div className="wakeup-task-meta wakeup-task-meta-accounts">
                    <span>{t('codex.wakeup.taskAccountsLabel')}: {formatSelectionPreview(accountLabels)}</span>
                  </div>
                  {task.prompt && (
                    <div className="wakeup-task-meta wakeup-task-meta-prompt">
                      <span>{t('codex.wakeup.promptLabel')}: {task.prompt}</span>
                    </div>
                  )}
                </div>

                <div className="wakeup-task-section wakeup-task-section-muted">
                  <div className="wakeup-task-meta wakeup-task-meta-status">
                    <span>{t('codex.wakeup.lastStatusLabel')}: {formatTaskLastResult(task, t)}</span>
                    <span>{t('codex.wakeup.lastDurationLabel')}: {formatDuration(task.last_duration_ms)}</span>
                  </div>
                  <div className="wakeup-task-meta wakeup-task-meta-timeline">
                    <span>{t('codex.wakeup.lastRunLabel', { time: formatDateTime(task.last_run_at) })}</span>
                    <span>{t('codex.wakeup.nextRunLabel', { time: formatDateTime(task.next_run_at) })}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showRuntimeGuideModal && runtime && !runtime.available && (
        <div className="modal-overlay" onClick={closeRuntimeGuideModal}>
          <div
            className="modal wakeup-modal codex-wakeup-runtime-guide-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2>{t('codex.wakeup.installTitle')}</h2>
              <button className="modal-close" onClick={closeRuntimeGuideModal} disabled={runtimeGuideRefreshing}>
                <X />
              </button>
            </div>
            <div className="modal-body codex-wakeup-runtime-guide-body">
              <div className="codex-wakeup-runtime-guide-hero">
                <div className="codex-wakeup-runtime-guide-icon">
                  <CircleAlert size={20} />
                </div>
                <div className="codex-wakeup-runtime-guide-copy">
                  <span className="codex-wakeup-runtime-guide-kicker">
                    {t('codex.wakeup.runtimeMissing')}
                  </span>
                  <h3>{t('codex.wakeup.installTitle')}</h3>
                  <p>{runtime.message || t('codex.wakeup.installSubtitle')}</p>
                </div>
              </div>
              {renderInstallCommands(runtime.install_hints || [])}
              <p className="codex-wakeup-install-footnote">{t('codex.wakeup.installFootnote')}</p>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={closeRuntimeGuideModal} disabled={runtimeGuideRefreshing}>
                {t('common.close')}
              </button>
              <button className="btn btn-primary" onClick={() => void handleRefreshRuntimeGuide()} disabled={runtimeGuideRefreshing}>
                <RefreshCw size={16} className={runtimeGuideRefreshing ? 'loading-spinner' : ''} />
                {t('codex.wakeup.refreshRuntime')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showTaskModal && (
        <div className="modal-overlay" onClick={closeTaskModal}>
          <div className="modal modal-lg wakeup-modal codex-wakeup-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{taskDraft.id ? t('codex.wakeup.editTaskTitle') : t('codex.wakeup.createTaskTitle')}</h2>
              <button className="modal-close" onClick={closeTaskModal}>
                <X />
              </button>
            </div>
            <div className="modal-body codex-wakeup-modal-body">
              <ModalErrorMessage message={taskModalError} scrollKey={taskModalErrorScrollKey} />
              <div className="wakeup-form-group">
                <label>{t('codex.wakeup.taskNameLabel')}</label>
                <input
                  className="wakeup-input"
                  value={taskDraft.name}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, name: event.target.value }))}
                  placeholder={t('codex.wakeup.taskNamePlaceholder')}
                />
              </div>

              <div className="wakeup-form-group">
                <label>{t('common.status', '状态')}</label>
                <div className="wakeup-toggle-group">
                  <button
                    className={`btn btn-secondary ${taskDraft.enabled ? 'is-active' : ''}`}
                    onClick={() => setTaskDraft((current) => ({ ...current, enabled: true }))}
                  >
                    {t('common.enable')}
                  </button>
                  <button
                    className={`btn btn-secondary ${!taskDraft.enabled ? 'is-active' : ''}`}
                    onClick={() => setTaskDraft((current) => ({ ...current, enabled: false }))}
                  >
                    {t('common.disable')}
                  </button>
                </div>
              </div>

              <div className="wakeup-form-group">
                <label>{t('codex.wakeup.taskAccountsLabel')}</label>
                <p className="wakeup-hint">{t('codex.wakeup.taskAccountsHint')}</p>
                {renderAccountPickerFilters(
                  taskAccountFilters,
                  setTaskAccountFilters,
                  filteredTaskAccounts,
                  allFilteredTaskSelected,
                  () =>
                    setTaskDraft((current) => {
                      const visibleIds = filteredTaskAccounts.map((account) => account.id);
                      const visibleSet = new Set(visibleIds);
                      if (allFilteredTaskSelected) {
                        return {
                          ...current,
                          accountIds: current.accountIds.filter((item) => !visibleSet.has(item)),
                        };
                      }
                      return {
                        ...current,
                        accountIds: Array.from(new Set([...current.accountIds, ...visibleIds])),
                      };
                    }),
                )}
                {filteredTaskAccounts.length === 0 ? (
                  <div className="codex-wakeup-account-empty">
                    {t('codex.wakeup.accountFilterEmpty')}
                  </div>
                ) : (
                  <div className="wakeup-chip-list codex-wakeup-account-list">
                    {filteredTaskAccounts.map((account) => {
                    const checked = taskDraft.accountIds.includes(account.id);
                    return renderWakeupAccountOption(account, checked, () =>
                      setTaskDraft((current) => ({
                        ...current,
                        accountIds: checked
                          ? current.accountIds.filter((item) => item !== account.id)
                          : [...current.accountIds, account.id],
                      })),
                    );
                  })}
                  </div>
                )}
              </div>

              <div className="wakeup-form-group">
                <label>{t('codex.wakeup.scheduleLabel')}</label>
                <div className="wakeup-segmented">
                  {(['daily', 'weekly', 'interval'] as CodexWakeupScheduleKind[]).map((kind) => (
                    <button
                      type="button"
                      key={kind}
                      className={`wakeup-segment-btn ${taskDraft.scheduleKind === kind ? 'active' : ''}`}
                      onClick={() => setTaskDraft((current) => ({ ...current, scheduleKind: kind }))}
                    >
                      {t(`codex.wakeup.schedule.${kind}`)}
                    </button>
                  ))}
                </div>
              </div>

              {taskDraft.scheduleKind === 'daily' && (
                <div className="wakeup-form-group">
                  <label>{t('codex.wakeup.dailyTimeLabel')}</label>
                  <div className="wakeup-chip-grid">
                    {QUICK_TIME_OPTIONS.map((time) => (
                      <button
                        key={time}
                        type="button"
                        className={`wakeup-chip ${taskDraft.dailyTime === time ? 'selected' : ''}`}
                        onClick={() => setTaskDraft((current) => ({ ...current, dailyTime: time }))}
                      >
                        {time}
                      </button>
                    ))}
                  </div>
                  <input
                    type="time"
                    className="wakeup-input wakeup-input-time"
                    value={taskDraft.dailyTime}
                    onChange={(event) => setTaskDraft((current) => ({ ...current, dailyTime: event.target.value }))}
                  />
                </div>
              )}

              {taskDraft.scheduleKind === 'weekly' && (
                <>
                  <div className="wakeup-form-group">
                    <label>{t('codex.wakeup.weeklyDaysLabel')}</label>
                    <div className="wakeup-chip-grid">
                      {WEEKDAY_OPTIONS.map((item) => {
                        const active = taskDraft.weeklyDays.includes(item.value);
                        return (
                          <button
                            type="button"
                            key={item.value}
                            className={`wakeup-chip ${active ? 'selected' : ''}`}
                            onClick={() =>
                              setTaskDraft((current) => ({
                                ...current,
                                weeklyDays: active
                                  ? current.weeklyDays.filter((value) => value !== item.value)
                                  : [...current.weeklyDays, item.value],
                              }))
                            }
                          >
                            {t(`codex.wakeup.weekdays.${item.value}`)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="wakeup-form-group">
                    <label>{t('codex.wakeup.weeklyTimeLabel')}</label>
                    <div className="wakeup-chip-grid">
                      {QUICK_TIME_OPTIONS.map((time) => (
                        <button
                          key={time}
                          type="button"
                          className={`wakeup-chip ${taskDraft.weeklyTime === time ? 'selected' : ''}`}
                          onClick={() => setTaskDraft((current) => ({ ...current, weeklyTime: time }))}
                        >
                          {time}
                        </button>
                      ))}
                    </div>
                    <input
                      type="time"
                      className="wakeup-input wakeup-input-time"
                      value={taskDraft.weeklyTime}
                      onChange={(event) => setTaskDraft((current) => ({ ...current, weeklyTime: event.target.value }))}
                    />
                  </div>
                </>
              )}

              {taskDraft.scheduleKind === 'interval' && (
                <div className="wakeup-form-group">
                  <label>{t('codex.wakeup.intervalHoursLabel')}</label>
                  <input
                    type="number"
                    min={1}
                    max={24}
                    className="wakeup-input wakeup-input-small"
                    value={taskDraft.intervalHours}
                    onChange={(event) =>
                      setTaskDraft((current) => ({ ...current, intervalHours: event.target.value }))
                    }
                  />
                </div>
              )}

              <div className="wakeup-form-group">
                <label>{t('codex.wakeup.promptLabel')}</label>
                <textarea
                  className="token-input codex-wakeup-prompt-input"
                  value={taskDraft.prompt}
                  onChange={(event) => setTaskDraft((current) => ({ ...current, prompt: event.target.value }))}
                  placeholder={t('codex.wakeup.promptPlaceholder', { prompt: DEFAULT_PROMPT })}
                />
              </div>

              <div className="wakeup-form-group">
                <label>{t('wakeup.form.nextRuns', '接下来执行')}</label>
                <ul className="wakeup-preview-list">
                  {previewRuns.length === 0 && <li>{t('wakeup.form.nextRunsEmpty', '暂无预览')}</li>}
                  {previewRuns.map((date, index) => (
                    <li key={`${date.toISOString()}-${index}`}>
                      {index + 1}. {date.toLocaleString()}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={closeTaskModal} disabled={saving}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary" onClick={() => void handleSaveTask()} disabled={saving}>
                {saving ? t('common.saving', '保存中...') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showTestModal && (
        <div className="modal-overlay" onClick={closeTestModal}>
          <div className="modal modal-lg wakeup-modal wakeup-test-modal codex-wakeup-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('codex.wakeup.testTitle')}</h2>
              <button className="modal-close" onClick={closeTestModal}>
                <X />
              </button>
            </div>
            <div className="modal-body codex-wakeup-modal-body">
              <ModalErrorMessage message={testModalError} scrollKey={testModalErrorScrollKey} />
              <div className="wakeup-form-group">
                <label>{t('codex.wakeup.testAccountsLabel')}</label>
                {renderAccountPickerFilters(
                  testAccountFilters,
                  setTestAccountFilters,
                  filteredTestAccounts,
                  allFilteredTestSelected,
                  () =>
                    setTestAccountIds((current) => {
                      const visibleIds = filteredTestAccounts.map((account) => account.id);
                      const visibleSet = new Set(visibleIds);
                      if (allFilteredTestSelected) {
                        return current.filter((item) => !visibleSet.has(item));
                      }
                      return Array.from(new Set([...current, ...visibleIds]));
                    }),
                )}
                {filteredTestAccounts.length === 0 ? (
                  <div className="codex-wakeup-account-empty">
                    {t('codex.wakeup.accountFilterEmpty')}
                  </div>
                ) : (
                  <div className="wakeup-chip-list codex-wakeup-account-list">
                    {filteredTestAccounts.map((account) => {
                    const checked = testAccountIds.includes(account.id);
                    return renderWakeupAccountOption(account, checked, () =>
                      setTestAccountIds((current) =>
                        checked
                          ? current.filter((item) => item !== account.id)
                          : [...current, account.id],
                      ),
                    );
                  })}
                  </div>
                )}
              </div>
              <div className="wakeup-form-group">
                <label>{t('codex.wakeup.promptLabel')}</label>
                <textarea
                  className="token-input codex-wakeup-prompt-input"
                  value={testPrompt}
                  onChange={(event) => setTestPrompt(event.target.value)}
                  placeholder={t('codex.wakeup.promptPlaceholder', { prompt: DEFAULT_PROMPT })}
                />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={closeTestModal} disabled={testing}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary" onClick={() => void handleRunTest()} disabled={testing || !runtime?.available}>
                {testing ? <RefreshCw size={16} className="loading-spinner" /> : <Play size={16} />}
                {testing ? t('codex.wakeup.testing') : t('codex.wakeup.startTest')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showHistoryModal && (
        <div className="modal-overlay" onClick={() => setShowHistoryModal(false)}>
          <div className="modal wakeup-modal wakeup-history-modal codex-wakeup-history-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('codex.wakeup.historyTitle')}</h2>
              <button className="modal-close" onClick={() => setShowHistoryModal(false)}>
                <X />
              </button>
            </div>
            <div className="modal-body">
              {historyBatches.length === 0 ? (
                <p className="wakeup-hint">{t('codex.wakeup.historyEmptyDesc')}</p>
              ) : (
                <ul className="codex-wakeup-history-run-list">
                  {historyBatches.map((batch) => {
                    const badgeClass = batch.triggerType === 'scheduled' ? 'auto' : 'manual';
                    return (
                      <li key={batch.runId} className="codex-wakeup-history-run-card">
                        <div className="codex-wakeup-history-run-head">
                          <div className="codex-wakeup-history-run-copy">
                            <h4>
                              {batch.taskName ||
                                (batch.triggerType === 'test'
                                  ? t('codex.wakeup.testTitle')
                                  : triggerLabel(batch.triggerType, t))}
                            </h4>
                            <div className="codex-wakeup-history-run-meta">
                              <span>{formatHistoryTimestamp(batch.timestamp)}</span>
                              {batch.durationMs !== undefined && <span>{formatDuration(batch.durationMs)}</span>}
                              <span>{t('accounts.groups.accountCount', { count: batch.total })}</span>
                            </div>
                          </div>
                          <div className="codex-wakeup-history-run-actions">
                            <span className={`wakeup-history-badge codex-wakeup-history-trigger-badge ${badgeClass}`}>
                              {triggerLabel(batch.triggerType, t)}
                            </span>
                            <button
                              className="btn btn-secondary codex-wakeup-history-detail-btn"
                              onClick={() => {
                                setShowHistoryModal(false);
                                setExecutionSession(buildExecutionSessionFromHistory(batch));
                              }}
                            >
                              {t('common.detail')}
                            </button>
                          </div>
                        </div>

                        <div className="codex-wakeup-history-run-stats">
                          <span className="codex-wakeup-history-stat-chip is-total">
                            <span>{t('codex.wakeup.resultsTotal')}</span>
                            <strong>{batch.total}</strong>
                          </span>
                          <span className="codex-wakeup-history-stat-chip is-success">
                            <span>{t('codex.wakeup.resultsSuccess')}</span>
                            <strong>{batch.successCount}</strong>
                          </span>
                          <span className="codex-wakeup-history-stat-chip is-error">
                            <span>{t('codex.wakeup.resultsFailed')}</span>
                            <strong>{batch.failureCount}</strong>
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary codex-wakeup-subtle-btn" onClick={() => setShowHistoryModal(false)}>
                {t('common.close')}
              </button>
              <button className="btn btn-secondary codex-wakeup-subtle-btn" onClick={() => void handleClearHistory()} disabled={historyBatches.length === 0}>
                {t('codex.wakeup.clearHistory')}
              </button>
            </div>
          </div>
        </div>
      )}

      {executionSession && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (!executionSession.running) {
              setExecutionSession(null);
            }
          }}
        >
          <div
            className="modal codex-wakeup-modal codex-wakeup-results-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2>{t('codex.wakeup.resultsTitle')}</h2>
              <button
                className="modal-close"
                onClick={() => setExecutionSession(null)}
                disabled={executionSession.running}
              >
                <X />
              </button>
            </div>
            <div className="modal-body codex-wakeup-modal-body codex-wakeup-results-body">
              <ModalErrorMessage message={executionSession.errorText} />
              <section className="codex-wakeup-results-summary-bar">
                <div className="codex-wakeup-results-summary-copy">
                  <div className="codex-wakeup-results-summary-head">
                    <span className="codex-wakeup-results-kicker">
                      {triggerLabel(executionSession.triggerType, t)}
                    </span>
                    <h3>{executionSession.title}</h3>
                  </div>
                  <div className="codex-wakeup-results-summary-meta">
                    <span>
                      {executionSession.running
                        ? t('codex.wakeup.executionStatusRunning')
                        : formatHistoryTimestamp(executionSession.startedAt)}
                    </span>
                    {!executionSession.running && executionDuration !== undefined && (
                      <span>{formatDuration(executionDuration)}</span>
                    )}
                    <span>{t('accounts.groups.accountCount', { count: executionSession.total })}</span>
                  </div>
                </div>
                <div className="codex-wakeup-results-summary-progress">
                  <strong>
                    {executionSession.completed}/{executionSession.total}
                  </strong>
                  <span>
                    {executionSession.running
                      ? t('codex.wakeup.executionStatusRunning')
                      : t('codex.wakeup.executionStatusCompleted')}
                  </span>
                </div>
              </section>

              <section className="codex-wakeup-results-progress-strip">
                <div className="codex-wakeup-results-progress-head">
                  <span>{t('codex.wakeup.resultsTitle')}</span>
                  <strong>
                    {executionSession.completed}/{executionSession.total}
                  </strong>
                </div>
                <div className="codex-wakeup-results-progress-track">
                  <div
                    className="codex-wakeup-results-progress-fill"
                    style={{
                      width: `${
                        executionSession.total > 0
                          ? (executionSession.completed / executionSession.total) * 100
                          : 0
                      }%`,
                    }}
                  />
                </div>
              </section>

              <div className="codex-wakeup-results-filter-bar">
                {executionFilterOptions.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    className={`codex-wakeup-results-filter-chip ${
                      executionFilter === option.key ? 'active' : ''
                    } tone-${option.tone}`}
                    onClick={() => setExecutionFilter(option.key)}
                  >
                    <span>{option.label}</span>
                    <strong>{option.count}</strong>
                  </button>
                ))}
              </div>

              <div className="codex-wakeup-results-runtime-meta">
                <span>{t('codex.wakeup.runtimeCardTitle')}</span>
                <strong className="codex-wakeup-runtime-path">
                  {executionSession.runtime?.binary_path || t('codex.wakeup.runtimeUnknownPath')}
                </strong>
                {(executionSession.runtime?.version ||
                  executionSession.runtime?.source ||
                  executionSession.runtime?.message) && (
                  <span>
                    {[
                      executionSession.runtime?.version,
                      executionSession.runtime?.source,
                      executionSession.runtime?.message,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
              </div>

              {executionSession.runtime && !executionSession.runtime.available && (
                <div className="codex-wakeup-runtime-warning">
                  <div>
                    <strong>{t('codex.wakeup.installTitle')}</strong>
                    <span>
                      {executionSession.runtime.message || t('codex.wakeup.installSubtitle')}
                    </span>
                  </div>
                  <button className="btn btn-secondary" onClick={openRuntimeGuideModal}>
                    {t('codex.wakeup.installTitle')}
                  </button>
                </div>
              )}
              <div className="codex-wakeup-results-list">
                {filteredExecutionRecords.map((record) => (
                  <article
                    key={record.id}
                    className={`codex-wakeup-execution-row is-${record.status}`}
                  >
                    <div className="codex-wakeup-execution-row-head">
                      <div>
                        <h4 className="codex-wakeup-execution-row-title">
                          {record.accountContextText
                            ? `${record.accountEmail} · ${record.accountContextText}`
                            : record.accountEmail}
                        </h4>
                        <span className="codex-wakeup-execution-row-subtitle">
                          {triggerLabel(record.triggerType, t)}
                        </span>
                      </div>
                      <span className={`codex-wakeup-execution-badge is-${record.status}`}>
                        {record.status === 'running' && <RefreshCw size={14} className="loading-spinner" />}
                        {executionStatusLabel(record.status, t)}
                      </span>
                    </div>
                    {record.prompt && (
                      <div className="codex-wakeup-execution-row-prompt">
                        {t('codex.wakeup.promptLabel')}: {record.prompt}
                      </div>
                    )}
                    <p className="codex-wakeup-execution-row-message">
                      {record.status === 'pending'
                        ? t('codex.wakeup.executionPendingDesc')
                        : record.status === 'running'
                          ? t('codex.wakeup.executionRunningDesc')
                          : record.status === 'success'
                            ? record.reply || t('codex.wakeup.historyNoReply')
                            : record.error || t('codex.wakeup.historyUnknownError')}
                    </p>
                    <div className="codex-wakeup-execution-row-meta">
                      {record.timestamp && <span>{formatHistoryTimestamp(record.timestamp)}</span>}
                      {record.durationMs !== undefined && <span>{formatDuration(record.durationMs)}</span>}
                    </div>
                  </article>
                ))}
                {filteredExecutionRecords.length === 0 && (
                  <p className="wakeup-hint">{t('common.none', '暂无')}</p>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-primary codex-wakeup-results-close-btn"
                onClick={() => setExecutionSession(null)}
                disabled={executionSession.running}
              >
                {t('common.close', '关闭')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
