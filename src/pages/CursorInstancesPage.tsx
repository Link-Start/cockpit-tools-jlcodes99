import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PlatformInstancesContent } from '../components/platform/PlatformInstancesContent';
import { useCursorInstanceStore } from '../stores/useCursorInstanceStore';
import { useCursorAccountStore } from '../stores/useCursorAccountStore';
import type { CursorAccount } from '../types/cursor';
import { getCursorAccountDisplayEmail, getCursorQuotaClass, getCursorUsage } from '../types/cursor';
import { usePlatformRuntimeSupport } from '../hooks/usePlatformRuntimeSupport';

/**
 * Cursor 多开实例内容组件（不包含 header）
 * 用于嵌入到 CursorAccountsPage 中
 */
export function CursorInstancesContent() {
  const { t } = useTranslation();
  const instanceStore = useCursorInstanceStore();
  const { accounts, fetchAccounts } = useCursorAccountStore();
  type AccountForSelect = CursorAccount & { email: string };
  const accountsForSelect = useMemo(
    () =>
      accounts.map((acc) => ({
        ...acc,
        email: acc.email || getCursorAccountDisplayEmail(acc),
      })) as AccountForSelect[],
    [accounts],
  );
  const isSupportedPlatform = usePlatformRuntimeSupport('desktop');

  const resolveQuotaClass = (percentage: number) => getCursorQuotaClass(percentage);

  const renderCursorQuotaPreview = (account: AccountForSelect) => {
    const usage = getCursorUsage(account);
    const inlinePct = usage.inlineSuggestionsUsedPercent;
    const chatPct = usage.chatMessagesUsedPercent;
    if (inlinePct == null && chatPct == null) {
      return <span className="account-quota-empty">{t('instances.quota.empty', '暂无配额缓存')}</span>;
    }
    return (
      <div className="account-quota-preview">
        <span className="account-quota-item">
          <span className={`quota-dot ${resolveQuotaClass(inlinePct ?? 0)}`} />
          <span className={`quota-text ${resolveQuotaClass(inlinePct ?? 0)}`}>
            {t('common.shared.instances.quota.inline', 'Inline Suggestions')} {inlinePct ?? '-'}%
          </span>
        </span>
        <span className="account-quota-item">
          <span className={`quota-dot ${resolveQuotaClass(chatPct ?? 0)}`} />
          <span className={`quota-text ${resolveQuotaClass(chatPct ?? 0)}`}>
            {t('common.shared.instances.quota.chat', 'Chat messages')} {chatPct ?? '-'}%
          </span>
        </span>
      </div>
    );
  };

  return (
    <PlatformInstancesContent<AccountForSelect>
      instanceStore={instanceStore}
      accounts={accountsForSelect}
      fetchAccounts={fetchAccounts}
      renderAccountQuotaPreview={renderCursorQuotaPreview}
      getAccountSearchText={(account) => account.email}
      appType="cursor"
      isSupported={isSupportedPlatform}
      unsupportedTitleKey="common.shared.instances.unsupported.title"
      unsupportedTitleDefault="暂不支持当前系统"
      unsupportedDescKey="cursor.instances.unsupported.descPlatform"
      unsupportedDescDefault="Cursor 多开实例仅支持 macOS、Windows 和 Linux。"
    />
  );
}
