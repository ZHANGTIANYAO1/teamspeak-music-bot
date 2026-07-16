import { describe, it, expect } from 'vitest';
import { isShared, sortQueues, SHARED_OWNER, type SavedQueueMeta } from './savedQueues';

const meta = (over: Partial<SavedQueueMeta>): SavedQueueMeta => ({
  id: 1,
  ownerId: 'u1',
  name: 'q',
  songCount: 0,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  ...over,
});

describe('savedQueues helper', () => {
  it('flags the shared owner', () => {
    expect(isShared({ ownerId: SHARED_OWNER })).toBe(true);
    expect(isShared({ ownerId: 'u1' })).toBe(false);
  });

  it('sorts by updatedAt descending (newest first)', () => {
    const out = sortQueues([
      meta({ id: 1, updatedAt: '2026-01-01' }),
      meta({ id: 2, updatedAt: '2026-02-01' }),
      meta({ id: 3, updatedAt: '2026-01-15' }),
    ]);
    expect(out.map((q) => q.id)).toEqual([2, 3, 1]);
  });

  it('does not mutate the input array', () => {
    const input = [meta({ id: 1, updatedAt: '2026-01-01' }), meta({ id: 2, updatedAt: '2026-02-01' })];
    sortQueues(input);
    expect(input.map((q) => q.id)).toEqual([1, 2]);
  });
});
