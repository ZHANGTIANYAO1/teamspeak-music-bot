# Save/Load Playlists + Queue Persistence — Design

**Issue:** [#119](https://github.com/ZHANGTIANYAO1/teamspeak-music-bot/issues/119) — 加入保存和加载播放清单功能
**Date:** 2026-07-06
**Status:** Approved (design), pending implementation plan

## Problem

The play queue lives only in memory (`PlayQueue` inside each `BotInstance`). It is lost in two situations the user calls out:

1. **On restart** — the process stops, the in-memory queue is gone.
2. **On "直接播放"** — `!play <song>` (and the WebUI "play now" path) call `queue.clear()`, wiping the queue to play one song.

The user wants to stop losing the queue. Two related-but-separate capabilities were agreed:

- **Named save/load** of queues (manual), plus **auto-restore** of the live queue across restarts.
- An **independent** option to make single-song immediate-play *not* clear the queue.

Everything ships **behind admin/independent toggles that default OFF**, so existing behavior is unchanged until an operator opts in.

## Scope & agreed decisions

| Decision | Choice |
| --- | --- |
| Core behavior | **Both** — named save/load **and** auto-restore live queue across restart |
| Saved-queue ownership | **Per-user** (like `favorite_playlists`), plus a reserved `__shared__` owner for chat + opt-in sharing |
| Trigger surface | **Web + chat** commands |
| Auto-restore on restart | **Restore and resume playing** (gated by `savedQueuesEnabled`) |
| Load semantics | **Replace (default) + append option** (`-a` flag / WebUI Append button) |
| Feature gate | `savedQueuesEnabled` — **default false, admin-controlled** |
| Single-play clear | Independent `playKeepsQueue` toggle — **default false** |

### Out of scope (YAGNI)

- Renaming a saved queue (delete + re-save instead).
- Mid-track resume on restart (resume from the current track's **start**; URLs are re-resolved).
- Normalized per-song storage (songs stored as a JSON blob).
- Sharing granularity beyond "private to me" vs "shared" (one boolean).

## Storage approach

A saved queue is an ordered list of songs that is only ever saved and loaded **whole** — never queried song-by-song. So songs are stored as a **JSON `TEXT` blob**, not a normalized child table. Each stored song is a `QueuedSong` **without `url`** (URLs are resolved lazily at play time, exactly as today). This mirrors how `QueuedSong` already flows and keeps the schema to a single row per saved queue.

---

## Feature 1 — Named save/load (`savedQueuesEnabled`)

### Data model

New table:

```sql
CREATE TABLE IF NOT EXISTS saved_queues (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ownerId   TEXT NOT NULL,          -- WebUI user id, or the reserved SHARED owner
  name      TEXT NOT NULL,
  songs     TEXT NOT NULL,          -- JSON array of stored songs (QueuedSong minus url)
  songCount INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(ownerId, name)
);
CREATE INDEX IF NOT EXISTS idx_saved_queues_ownerId ON saved_queues(ownerId);
```

- **`ownerId`** is either a real user id **or** a reserved constant `SHARED_QUEUE_OWNER = "__shared__"` (a value that can never collide with a real user id).
- **Ownership rule (reconciles per-user with chat):**
  - **WebUI save** has a **"共享 (shared)" checkbox.** Off → `ownerId = req.user.id` (private to you). On → `ownerId = SHARED_QUEUE_OWNER`.
  - **Chat `!save`** always writes `ownerId = SHARED_QUEUE_OWNER` (TeamSpeak users have no WebUI account).
  - **WebUI list** shows **your own + shared** (labeled). **Chat `!queues`/`!load`** see **shared only**.
- **Overwrite:** `UNIQUE(ownerId, name)` → save is an **upsert** (same owner+name replaces `songs`, `songCount`, `updatedAt`).
- **Caps** (reject with a clear message): ≤ **50** saved queues per owner; ≤ **1000** songs per saved queue.

### DB methods (added to `BotDatabase`)

```ts
saveQueue(ownerId: string, name: string, songs: StoredSong[]): SavedQueue;   // upsert
listSavedQueues(ownerId: string, includeShared: boolean): SavedQueueMeta[];  // meta only (no songs blob)
getSavedQueue(id: number): SavedQueue | null;                                // full, with songs
deleteSavedQueue(id: number): boolean;
```

- `StoredSong` = `Omit<QueuedSong, "url">`.
- `SavedQueueMeta` = row without the `songs` blob (id, ownerId, name, songCount, timestamps) — keeps list responses light.
- JSON (de)serialize at the DB boundary; parse failures on a corrupt blob degrade to an empty song list (never throw into a route).

### Web API — `src/web/api/saved-queues.ts`

All routes require auth + `player.queue` capability, and **404/403 when `savedQueuesEnabled` is false** (feature inert).

| Method / path | Behavior |
| --- | --- |
| `GET /api/saved-queues` | list current user's own + shared (meta only) |
| `POST /api/saved-queues` | body `{ botId, name, shared? }` → snapshot that bot's **current queue** songs, upsert |
| `POST /api/saved-queues/:id/load` | body `{ botId, mode: "replace"\|"append" }` → load into that bot |
| `DELETE /api/saved-queues/:id` | delete (only own or shared; not another user's private) |

Ownership check on load/delete: allow if `ownerId === req.user.id` or `ownerId === SHARED_QUEUE_OWNER`; else 404 (no existence leak, matching the favorites pattern).

### Chat commands (new, in `BotInstance.executeCommand`)

- `!save <名称>` — save current queue → shared bucket.
- `!load <名称>` — replace queue with a saved (shared) queue and play.
- `!load -a <名称>` — append a saved (shared) queue to the end.
- `!queues` — list shared saved queues (names + counts).

All four reply **"此功能未启用"** when `savedQueuesEnabled` is false. Added to help text and the command table.

### Load semantics (shared by web + chat)

- **replace** — `queue.clear()`, add all stored songs, `queue.play()` + `resolveAndPlay(first)` (same shape as `cmdPlaylist`). Exits FM mode.
- **append** — add all stored songs to the end; if idle, start the first newly-added one; never interrupts a playing track.
- Loaded songs are re-tagged with a `requestedBy` of the loader (WebUI username / `游客` / chat `invokerName`) so play-history attribution stays correct (integrates with #121).

### WebUI

A new **"已保存队列 / Saved Queues"** page (nav entry visible only when `savedQueuesEnabled`):

- **Save current queue**: name input + **共享** checkbox → `POST`.
- Per entry (reusing `SongCard`/list styles): **Load** (replace), **Append**, **Delete**, showing name / song count / shared badge / owner.
- Store/composable follows the existing `favorites` pattern.

---

## Feature 2 — Auto-restore live queue across restart (`savedQueuesEnabled`)

Gated by the **same** `savedQueuesEnabled` flag (part of the "saved queues" feature).

### Data model

One row per bot (the live snapshot, continuously overwritten):

```sql
CREATE TABLE IF NOT EXISTS queue_state (
  botId        TEXT PRIMARY KEY,
  songs        TEXT NOT NULL,       -- JSON array of StoredSong
  currentIndex INTEGER NOT NULL,
  mode         TEXT NOT NULL,       -- PlayMode value
  isFmMode     INTEGER NOT NULL DEFAULT 0,
  fmPlatform   TEXT NOT NULL DEFAULT '',
  updatedAt    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

DB methods: `saveQueueState(state)` (upsert), `getQueueState(botId)`, `clearQueueState(botId)`.

### Snapshot (write path)

- Add `PlayQueue.snapshot(): QueueSnapshot` and `PlayQueue.restore(snapshot)`.
  - `snapshot` captures `songs` (minus url), `currentIndex`, `mode`.
  - `restore` rebuilds `songs`, `currentIndex`, `mode`, and resets the derived `playedIndices`/`history`/`forwardStack` to a clean, consistent state for the restored index.
- `BotInstance` writes the snapshot **debounced (~1 s)** on `stateChange` (queue mutations, track changes, and mode changes already emit `stateChange`). FM mode + fm platform captured alongside.
- When the queue becomes empty (`clear()` with nothing re-added), the row is cleared via `clearQueueState`.

### Restore (read path — "resume and play")

When a bot reaches **connected/ready** (the same lifecycle point `autoStart` uses):

1. If `savedQueuesEnabled` and a `queue_state` row exists → `PlayQueue.restore(...)`, restore FM mode/provider.
2. If there was a current track → `resolveAndPlay(current)` (re-resolves URL, plays **from the track's start**).

**Honest caveats (documented in README + spec):**

- Resumes the **current track from its start**, not the exact millisecond (URLs are re-resolved; no persisted elapsed/seek).
- **Spotify** auto-resume is **best-effort** — it depends on the sidecar/controller being back up; non-Spotify sources are reliable.
- Resume only happens for bots that reach the connected state (auto-started, or on next manual start).

---

## Feature 3 — `playKeepsQueue` (independent single-play toggle)

**Independent** config flag, **not** gated by `savedQueuesEnabled`. Default false → today's behavior.

Affects **single-song immediate play only**: chat `!play <song | #N | id:<id> | URL>` and the WebUI play-now / play-by-id path.

| `playKeepsQueue` | `!play <song>` behavior |
| --- | --- |
| `false` (default) | `queue.clear()` → play only that song (today) |
| `true` | `addNext(song)` (insert after current) → `playAt(insertedAt)` (jump & play now) → `resolveAndPlay`; queue **kept**; on track-end, `next()` continues the queue |

- Reuses existing `PlayQueue.addNext` + `playAt` — **no new queue logic.**
- **Not** applied to collection loads — `!playlist` / `!album` / `!artist` / `!fm` still replace the queue (loading a collection is meant to replace; the request is about 单曲/single songs).
- **Empty queue** → equivalent to a normal play (nothing to preserve).
- **FM mode** → `!play` still exits FM (manual takeover), but existing queued songs are preserved and continue after the single song (auto-refill stops because FM is off). Documented.

---

## Config

Add to `BotConfig` (in `src/data/config.ts`), both **default false**, both sanitized on load exactly like `localAudioEnabled` / `autoPauseOnEmpty` (so a hand-edited / legacy / corrupt `config.json` can never silently enable them):

```ts
savedQueuesEnabled: boolean;  // default false — gates Features 1 & 2 (admin-controlled)
playKeepsQueue: boolean;      // default false — independent (Feature 3)
```

- Set via **Settings → 行为设置** (the existing admin behavior-settings surface, written through `POST /api/bot/settings`).
- When `savedQueuesEnabled` is false: chat save/load/queues reply "此功能未启用"; `/api/saved-queues/*` return 403/404; the WebUI page/nav is hidden; no snapshotting; no auto-restore.

## Error handling & edge cases

- Corrupt `songs` JSON blob → treated as empty list; never throws into a route or the restore path.
- Save with a duplicate name → upsert (overwrite), not an error.
- Load/delete of a non-owned private queue → 404.
- Caps exceeded → 4xx with a clear message (web) / friendly reply (chat).
- Snapshot writes are best-effort and debounced; a DB write failure logs and never interrupts playback.
- Restore of a Spotify-containing queue → best-effort per source; failures skip to next (existing `resolveAndPlay` skip behavior).

## Testing (TDD)

- **DB:** `saveQueue` upsert + caps; `listSavedQueues` own vs shared; `getSavedQueue`/`deleteSavedQueue`; ownership; `queue_state` upsert/get/clear; JSON round-trip + corrupt-blob degradation.
- **PlayQueue:** `snapshot`/`restore` round-trip (songs, index, mode; derived state consistent).
- **BotInstance:** `!save`/`!load`/`!load -a`/`!queues`; feature-disabled replies; snapshot-on-stateChange (debounced); resume-on-ready; `playKeepsQueue` insert-and-jump vs clear; collections still replace; FM interaction.
- **Web API:** auth + capability + feature-gate (403/404); save (own/shared); load replace/append; delete ownership; caps.
- **Config:** defaults false; load sanitization (legacy/corrupt/non-boolean → false).
- **Frontend:** Saved Queues page (save w/ shared toggle, load, append, delete, hidden when disabled); store/composable.
- Then: full suite (`npx vitest run --no-file-parallelism`) + `npx tsc --noEmit` + `cd web && npm run build`.

## Rollout / staging

Implement in stages (each independently valuable, all default-off):

1. **Config + gates** — `savedQueuesEnabled`, `playKeepsQueue`, sanitization, Settings UI.
2. **Feature 3** — `playKeepsQueue` single-play behavior (small, self-contained).
3. **Feature 1** — named save/load (DB → API → chat → WebUI page).
4. **Feature 2** — live-queue snapshot + resume-on-restart.
5. **Docs** — README (commands, toggles, caveats).
