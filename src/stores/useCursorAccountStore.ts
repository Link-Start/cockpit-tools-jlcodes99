import {
  CursorAccount,
  getCursorAccountDisplayEmail,
  getCursorPlanBadge,
  getCursorUsage,
} from '../types/cursor';
import * as cursorService from '../services/cursorService';
import { createProviderAccountStore } from './createProviderAccountStore';

const CURSOR_ACCOUNTS_CACHE_KEY = 'agtools.cursor.accounts.cache';

export const useCursorAccountStore = createProviderAccountStore<CursorAccount>(
  CURSOR_ACCOUNTS_CACHE_KEY,
  {
    listAccounts: cursorService.listCursorAccounts,
    deleteAccount: cursorService.deleteCursorAccount,
    deleteAccounts: cursorService.deleteCursorAccounts,
    injectAccount: cursorService.injectCursorToVSCode,
    refreshToken: cursorService.refreshCursorToken,
    refreshAllTokens: cursorService.refreshAllCursorTokens,
    importFromJson: cursorService.importCursorFromJson,
    exportAccounts: cursorService.exportCursorAccounts,
    updateAccountTags: cursorService.updateCursorAccountTags,
  },
  {
    getDisplayEmail: getCursorAccountDisplayEmail,
    getPlanBadge: getCursorPlanBadge,
    getUsage: getCursorUsage,
  },
);
