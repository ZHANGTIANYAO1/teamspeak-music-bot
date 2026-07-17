// Pure, framework-free helpers for the Saved Queues feature (#119). Kept
// separate from the API composable so the list/ownership logic is unit-testable
// without a DOM or axios.

export interface SavedQueueMeta {
  id: number;
  ownerId: string;
  name: string;
  songCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Must match SHARED_QUEUE_OWNER in src/data/database.ts. */
export const SHARED_OWNER = '__shared__';

/** Whether a saved queue lives in the shared bucket (vs. private to a user). */
export function isShared(q: Pick<SavedQueueMeta, 'ownerId'>): boolean {
  return q.ownerId === SHARED_OWNER;
}

/** Newest-updated first; stable for equal timestamps. */
export function sortQueues<T extends { updatedAt: string }>(qs: T[]): T[] {
  return [...qs].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
  );
}
