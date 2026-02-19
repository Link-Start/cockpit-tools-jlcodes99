import { Page } from './navigation';

export type PlatformId = 'antigravity' | 'codex' | 'cursor' | 'github-copilot' | 'windsurf' | 'kiro';

export const ALL_PLATFORM_IDS: PlatformId[] = ['antigravity', 'codex', 'cursor', 'github-copilot', 'windsurf', 'kiro'];

export const PLATFORM_PAGE_MAP: Record<PlatformId, Page> = {
  antigravity: 'overview',
  codex: 'codex',
  cursor: 'cursor',
  'github-copilot': 'github-copilot',
  windsurf: 'windsurf',
  kiro: 'kiro',
};
