import type { Source } from './player.js';

const STORAGE_KEY = 'source-tabs';

export type TabKey =
  | 'home.recommend'
  | 'home.daily'
  | 'home.user'
  | 'library.user';

function readAll(): Partial<Record<TabKey, Source>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // typeof null === 'object' and typeof [] === 'object' — both pass a
    // naive check but neither is a valid record. Reject explicitly so a
    // corrupted / manipulated value can't smuggle wrong shapes through.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Partial<Record<TabKey, Source>>;
  } catch {
    return {};
  }
}

export function loadTabSource(key: TabKey, fallback: Source = 'netease'): Source {
  const all = readAll();
  const v = all[key];
  return v === 'jellyfin' || v === 'netease' || v === 'qq' || v === 'kugou' || v === 'spotify' ? v : fallback;
}

export function saveTabSource(key: TabKey, value: Source): void {
  try {
    const all = readAll();
    all[key] = value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // localStorage may be unavailable (private browsing); silently no-op
  }
}
