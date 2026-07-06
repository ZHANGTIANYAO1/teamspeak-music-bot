# Save/Load Playlists + Queue Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop losing the play queue — add named save/load of queues (chat + web), auto-restore-and-resume the live queue across restarts, and an option to make single-song `!play` insert instead of clearing — all behind default-off toggles.

**Architecture:** New SQLite tables (`saved_queues`, `queue_state`) storing song lists as JSON blobs; a per-user + `__shared__` ownership model for saved queues; a new `/api/saved-queues` router; new chat commands; a `PlayQueue.snapshot/restore` pair driven off the existing `stateChange` emit and the `connected` lifecycle event; and a `BotInstance.playSingleSong` seam that both chat `cmdPlay` and the web `/play-song` route funnel through so the `playKeepsQueue` decision lives in one place.

**Tech Stack:** TypeScript (Node 20, ESM `.js` import suffixes), better-sqlite3, Express, Vitest, Vue 3 + Pinia + vue-tsc.

## Global Constraints

- **All three behaviors default OFF.** `savedQueuesEnabled: false`, `playKeepsQueue: false`. No behavior change until an operator opts in.
- **`savedQueuesEnabled` is admin-controlled** via `POST /api/bot/settings` (gated `requirePermission("bot.manage")`). When false: chat save/load/queues reply `"此功能未启用"`; `/api/saved-queues/*` returns 403; WebUI page hidden; NO snapshotting; NO auto-restore.
- **Config sanitization mirrors existing flags:** every new config field is coerced with `=== true` on load (like `spotify.enabled`) so a hand-edited/legacy/corrupt `config.json` can never silently enable a feature.
- **Songs are stored as a JSON `TEXT` blob** — an array of `Omit<QueuedSong, "url">` (URLs are re-resolved lazily). Corrupt blobs degrade to `[]`, never throw into a route or the restore path.
- **`SHARED_QUEUE_OWNER = "__shared__"`** — reserved owner id for chat-saved / shared queues; can never collide with a real user id.
- **Caps:** ≤ 50 saved queues per owner; ≤ 1000 songs per saved queue.
- **ESM imports** use the `.js` suffix even for `.ts` files. New source files get colocated `*.test.ts`.
- **Verification per task:** `npx vitest run <file> --no-file-parallelism`. Final gate (Task 13): full `npx vitest run --no-file-parallelism`, `npx tsc --noEmit`, and `cd web && npm run build`.
- **Branch:** all work on `feat/issue-119-saved-queues` (already created off `main`).
- **Play-history attribution:** loaded songs are tagged with the loader's `requestedBy` (integrates with #121).

---

## File Structure

**Create:**
- `src/web/api/saved-queues.ts` — the `/api/saved-queues` router (Feature 1).
- `src/web/api/saved-queues.test.ts` — its tests.
- `web/src/views/SavedQueues.vue` — the WebUI page (Feature 1).
- `web/src/composables/useSavedQueues.ts` — API composable.
- `web/src/composables/savedQueues.ts` + `savedQueues.test.ts` — pure list/dedup helper (unit-tested).

**Modify:**
- `src/data/config.ts` — two new `BotConfig` flags + defaults + load sanitization.
- `src/data/config.test.ts` — sanitization tests.
- `src/web/api/bot.ts` — settings GET/POST echo the two flags.
- `src/web/api/bot.test.ts` — settings persistence tests.
- `web/src/views/Settings.vue` — two toggles in 行为设置; nav gating.
- `src/bot/instance.ts` — `playSingleSong`, chat `!save`/`!load`/`!queues`, help text, snapshot/restore wiring, `SHARED_QUEUE_OWNER` usage.
- `src/bot/instance.test.ts` — command + playKeepsQueue + snapshot/restore tests.
- `src/web/api/player.ts` — `/play-song` funnels through `bot.playSingleSong`.
- `src/data/database.ts` — `saved_queues` + `queue_state` tables, migrations, methods, interfaces, `SHARED_QUEUE_OWNER` export.
- `src/data/database.test.ts` — DB method tests.
- `src/audio/queue.ts` — `snapshot()` / `restore()`.
- `src/audio/queue.test.ts` — round-trip tests.
- `src/web/server.ts` — mount the saved-queues router.
- `README.md` — commands, toggles, caveats.

---

## Stage 1 — Config + gates + Settings UI

### Task 1: Config flags + load sanitization

**Files:**
- Modify: `src/data/config.ts` (`BotConfig`, `getDefaultConfig`, `loadConfig`)
- Test: `src/data/config.test.ts`

**Interfaces:**
- Produces: `BotConfig.savedQueuesEnabled: boolean`, `BotConfig.playKeepsQueue: boolean` (both default `false`).

- [ ] **Step 1: Write the failing tests**

Add to `src/data/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { getDefaultConfig, loadConfig } from "./config.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("savedQueues/playKeepsQueue config", () => {
  it("defaults both flags to false", () => {
    const c = getDefaultConfig();
    expect(c.savedQueuesEnabled).toBe(false);
    expect(c.playKeepsQueue).toBe(false);
  });

  it("coerces non-boolean values to false on load", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ savedQueuesEnabled: "yes", playKeepsQueue: 1 }));
    const c = loadConfig(p);
    expect(c.savedQueuesEnabled).toBe(false);
    expect(c.playKeepsQueue).toBe(false);
  });

  it("preserves true when explicitly enabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify({ savedQueuesEnabled: true, playKeepsQueue: true }));
    const c = loadConfig(p);
    expect(c.savedQueuesEnabled).toBe(true);
    expect(c.playKeepsQueue).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/data/config.test.ts --no-file-parallelism`
Expected: FAIL — `savedQueuesEnabled` is `undefined`.

- [ ] **Step 3: Implement**

In `src/data/config.ts`, add to the `BotConfig` interface (near `localAudioEnabled`):

```ts
  /** Enable named save/load of queues + auto-restore of the live queue across restart. Admin-controlled. */
  savedQueuesEnabled: boolean;
  /** When true, single-song !play inserts-and-plays instead of clearing the queue. */
  playKeepsQueue: boolean;
```

In `getDefaultConfig()` return object (near `localAudioEnabled: true`):

```ts
    savedQueuesEnabled: false,
    playKeepsQueue: false,
```

In `loadConfig()`, inside the final `return { ...defaults, ...partial, ... }` block, override both with strict coercion so junk can't enable them. Add these before the `return`:

```ts
    const savedQueuesEnabled = partial.savedQueuesEnabled === true;
    const playKeepsQueue = partial.playKeepsQueue === true;
```

and add `savedQueuesEnabled, playKeepsQueue,` to the returned object (after `spotify,`).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/data/config.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/config.ts src/data/config.test.ts
git commit -m "feat(config): add savedQueuesEnabled + playKeepsQueue flags (default off) (#119)"
```

---

### Task 2: Settings API round-trips the two flags

**Files:**
- Modify: `src/web/api/bot.ts` (GET `/settings`, POST `/settings`)
- Test: `src/web/api/bot.test.ts`

**Interfaces:**
- Consumes: `BotConfig.savedQueuesEnabled`, `BotConfig.playKeepsQueue`.
- Produces: settings GET/POST include `savedQueuesEnabled`, `playKeepsQueue`.

- [ ] **Step 1: Write the failing test**

Add to `src/web/api/bot.test.ts` (follow the existing settings-test setup in that file — reuse its `app`/`request` harness and admin auth). Add a test:

```ts
it("persists savedQueuesEnabled and playKeepsQueue", async () => {
  const res = await adminRequest()
    .post("/api/bot/settings")
    .send({ savedQueuesEnabled: true, playKeepsQueue: true });
  expect(res.status).toBe(200);
  expect(res.body.savedQueuesEnabled).toBe(true);
  expect(res.body.playKeepsQueue).toBe(true);

  const get = await adminRequest().get("/api/bot/settings");
  expect(get.body.savedQueuesEnabled).toBe(true);
  expect(get.body.playKeepsQueue).toBe(true);
});

it("ignores non-boolean flag values", async () => {
  const res = await adminRequest()
    .post("/api/bot/settings")
    .send({ savedQueuesEnabled: "nope" });
  expect(res.body.savedQueuesEnabled).toBe(false); // unchanged from default
});
```

(If `bot.test.ts` lacks an `adminRequest()` helper, mirror the auth setup already used by the existing `POST /settings` tests in that file.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/web/api/bot.test.ts --no-file-parallelism`
Expected: FAIL — response lacks the fields.

- [ ] **Step 3: Implement**

In `src/web/api/bot.ts`:

In BOTH the GET `/settings` response and the POST `/settings` response objects, add:

```ts
      savedQueuesEnabled: config.savedQueuesEnabled,
      playKeepsQueue: config.playKeepsQueue,
```

In the POST `/settings` handler, after the `hasLocalAudioEnabled` block, add:

```ts
    if (typeof req.body.savedQueuesEnabled === "boolean") {
      config.savedQueuesEnabled = req.body.savedQueuesEnabled;
    }
    if (typeof req.body.playKeepsQueue === "boolean") {
      config.playKeepsQueue = req.body.playKeepsQueue;
    }
```

(No per-bot push needed: `BotInstance.this.config` is the same object reference as this `config` — see `instance.ts:171 this.config = options.config`. **Verify** during implementation that the config passed to `createBotRouter` and to each `BotInstance` is the same reference; it is threaded from `index.ts`. Both booleans are read live from `this.config`.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/web/api/bot.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/api/bot.ts src/web/api/bot.test.ts
git commit -m "feat(settings): round-trip savedQueuesEnabled + playKeepsQueue (#119)"
```

---

### Task 3: Settings.vue toggles

**Files:**
- Modify: `web/src/views/Settings.vue` (行为设置 section + the settings load/save payload)

**Interfaces:**
- Consumes: settings API fields `savedQueuesEnabled`, `playKeepsQueue`.

- [ ] **Step 1: Locate the 行为设置 toggles**

Find where `localAudioEnabled` / `autoPauseOnEmpty` are rendered (a labeled toggle bound to a reactive settings object) and where the settings object is loaded from `GET /api/bot/settings` and sent by `POST /api/bot/settings`.

- [ ] **Step 2: Add the reactive fields**

Add `savedQueuesEnabled` and `playKeepsQueue` to the settings reactive object's initial shape (default `false`), to the GET hydration, and to the POST payload — exactly mirroring how `localAudioEnabled` is wired.

- [ ] **Step 3: Add two toggle rows**

In the 行为设置 section, after the local-audio toggle, add two toggle rows mirroring the existing markup:

```html
<!-- 保存/加载播放清单 + 重启恢复队列（管理员开关，默认关闭） -->
<label class="setting-row">
  <span>保存/加载播放清单（含重启后自动恢复队列）</span>
  <input type="checkbox" v-model="settings.savedQueuesEnabled" />
</label>
<!-- 单曲直接播放不清空队列 -->
<label class="setting-row">
  <span>直接播放单曲时不清空队列（播完继续原队列）</span>
  <input type="checkbox" v-model="settings.playKeepsQueue" />
</label>
```

(Match the actual class names / toggle component used by neighboring rows.)

- [ ] **Step 4: Build check**

Run: `cd web && npm run build`
Expected: build succeeds (vue-tsc clean).

- [ ] **Step 5: Commit**

```bash
git add web/src/views/Settings.vue
git commit -m "feat(web): saved-queues + play-keeps-queue toggles in 行为设置 (#119)"
```

---

## Stage 2 — Feature 3: `playKeepsQueue`

### Task 4: `BotInstance.playSingleSong` + route `cmdPlay` through it

**Files:**
- Modify: `src/bot/instance.ts` (`cmdPlay` at ~909; add `playSingleSong`)
- Test: `src/bot/instance.test.ts`

**Interfaces:**
- Consumes: `this.config.playKeepsQueue`, `this.queue` (`PlayQueue`), `this.withRequester`, `this.disableFmMode`, `this.resolveAndPlay`, `this.cleanupQueuedLocalSongs`.
- Produces: `async playSingleSong(song: QueuedSong, requesterName?: string): Promise<boolean>` — public (called by the web route in Task 5).

- [ ] **Step 1: Write the failing tests**

Add to `src/bot/instance.test.ts` (reuse the file's existing BotInstance harness that stubs the player/queue/providers). Two tests:

```ts
describe("playSingleSong / playKeepsQueue", () => {
  it("clears the queue when playKeepsQueue is false (default)", async () => {
    const bot = makeBot({ playKeepsQueue: false }); // helper sets config flag
    const q = bot.getQueueManager();
    q.add({ id: "a", name: "A", artist: "", album: "", platform: "netease", coverUrl: "", duration: 10 });
    q.play();
    await bot.playSingleSong(
      { id: "b", name: "B", artist: "", album: "", platform: "netease", coverUrl: "", duration: 10 },
      "alice",
    );
    expect(q.list().map((s) => s.id)).toEqual(["b"]);
    expect(q.current()?.id).toBe("b");
  });

  it("inserts-after-current and keeps the queue when playKeepsQueue is true", async () => {
    const bot = makeBot({ playKeepsQueue: true });
    const q = bot.getQueueManager();
    q.add({ id: "a", name: "A", artist: "", album: "", platform: "netease", coverUrl: "", duration: 10 });
    q.add({ id: "c", name: "C", artist: "", album: "", platform: "netease", coverUrl: "", duration: 10 });
    q.play(); // current = a (index 0)
    await bot.playSingleSong(
      { id: "b", name: "B", artist: "", album: "", platform: "netease", coverUrl: "", duration: 10 },
      "alice",
    );
    expect(q.list().map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(q.current()?.id).toBe("b");
    expect(q.current()?.requestedBy).toBe("alice");
  });
});
```

(If `instance.test.ts` has no `makeBot` helper, add a minimal factory that constructs a `BotInstance` with a stub player whose `resolveAndPlay` succeeds — mirror the existing construction in that file's other describe blocks. `resolveAndPlay` can be spied to resolve `true` without real resolution.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/bot/instance.test.ts -t "playSingleSong" --no-file-parallelism`
Expected: FAIL — `playSingleSong` is not a function.

- [ ] **Step 3: Implement `playSingleSong`**

Add to `BotInstance` (public method, near `cmdPlay`):

```ts
  /**
   * Play a single resolved song immediately. Honors config.playKeepsQueue:
   * when true (and the queue isn't empty), insert-after-current + jump so the
   * rest of the queue survives and continues after this track; otherwise clear
   * the queue and play only this song (legacy behavior). Shared by chat !play
   * and the web /play-song route so the toggle lives in one place.
   */
  async playSingleSong(song: QueuedSong, requesterName?: string): Promise<boolean> {
    const s = this.withRequester(song, requesterName);
    if (this.config.playKeepsQueue && !this.queue.isEmpty()) {
      // Take manual control (stop FM auto-refill) but KEEP the queued songs.
      const insertedAt =
        this.queue.getCurrentIndex() < 0
          ? this.queue.size()
          : this.queue.getCurrentIndex() + 1;
      this.disableFmMode();
      this.queue.addNext(s);
      this.queue.playAt(insertedAt);
    } else {
      this.queue.clear();
      this.disableFmMode();
      this.queue.add(s);
      this.queue.play();
      // Only the clear path replaces the queue, so only it sweeps prior local uploads.
      this.cleanupQueuedLocalSongs?.("queue_replaced");
    }
    this.player.resetFailures();
    return this.resolveAndPlay(this.queue.current()!);
  }
```

Then in `cmdPlay`, replace the clear+add+play block:

```ts
    this.queue.clear();
    this.disableFmMode();
    this.queue.add(this.withRequester(song0, requesterName));
    this.queue.play();
    // Reset failure counter on user-initiated play
    ...resolveAndPlay(...)
```

with:

```ts
    await this.playSingleSong(song0, requesterName);
```

(Preserve the surrounding `cmdPlay` return string, e.g. `Now playing: ...`, and any `resetFailures` already inside `playSingleSong`. Remove the now-duplicated `resolveAndPlay` call from `cmdPlay`.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/bot/instance.test.ts -t "playSingleSong" --no-file-parallelism`
Expected: PASS. Then run the whole file to catch regressions:
Run: `npx vitest run src/bot/instance.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/instance.ts src/bot/instance.test.ts
git commit -m "feat(player): playSingleSong seam honoring playKeepsQueue (#119)"
```

---

### Task 5: Web `/play-song` funnels through `playSingleSong`

**Files:**
- Modify: `src/web/api/player.ts` (`/:botId/play-song` at ~461)
- Test: `src/web/api/player.test.ts` (or the existing player-route test file)

**Interfaces:**
- Consumes: `bot.playSingleSong(song, requesterName)` from Task 4.

- [ ] **Step 1: Write the failing test**

In the player-route test file, add a test that with `playKeepsQueue = true` a `/play-song` call preserves an existing queued song. Mirror the existing route-test harness (a fake `bot` exposing `getQueueManager`, `playSingleSong`, `runExclusive`). Assert the fake `bot.playSingleSong` is invoked with the song + requester and the pre-existing queue entry is retained. If the route tests use a real `BotInstance` stub, assert queue contents as in Task 4.

```ts
it("/play-song routes through playSingleSong (keeps queue when enabled)", async () => {
  const bot = makeRouteBot({ playKeepsQueue: true });
  bot.getQueueManager().add({ id: "a", platform: "netease", name: "A", artist: "", album: "", coverUrl: "", duration: 5 });
  bot.getQueueManager().play();
  await request(app).post(`/api/player/${BOT}/play-song`).send({ song: { id: "b", platform: "netease", name: "B" } });
  expect(bot.getQueueManager().list().map((s) => s.id)).toContain("a");
  expect(bot.getQueueManager().current()?.id).toBe("b");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/web/api/player.test.ts --no-file-parallelism`
Expected: FAIL (route still clears).

- [ ] **Step 3: Implement**

Replace the body of `/:botId/play-song` (the `queue.clear(); queue.add(...); queue.play(); resolveAndPlay; cleanupQueuedLocalSongs` block) with a single call, wrapped in `runExclusive` for consistency with `/play-now-song`:

```ts
      const body = await bot.runExclusive(async () => {
        const ok = await bot.playSingleSong(
          { ...song },
          requesterName(req),
        );
        return ok
          ? { ok: true, message: `正在播放：${song.name || "Unknown"} - ${song.artist || "Unknown"}` }
          : { ok: false, message: `无法播放「${song.name || song.id}」（区域/版权限制）` };
      });
      res.json(body);
```

(The `cleanupQueuedLocalSongs` sweep now lives inside `playSingleSong`'s clear branch — do NOT also call it here, or it would delete retained local uploads in keep-queue mode.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/web/api/player.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/api/player.ts src/web/api/player.test.ts
git commit -m "feat(web): /play-song honors playKeepsQueue via playSingleSong (#119)"
```

---

## Stage 3 — Feature 1: named save/load

### Task 6: DB — `saved_queues` table + methods

**Files:**
- Modify: `src/data/database.ts` (interfaces, `migrateSchema`, `initTables`, `createDatabase` body, `BotDatabase`)
- Test: `src/data/database.test.ts`

**Interfaces:**
- Produces (exports + `BotDatabase` methods):

```ts
export const SHARED_QUEUE_OWNER = "__shared__";
export type StoredSong = Omit<QueuedSong, "url">;           // imported from ../audio/queue.js
export interface SavedQueueMeta {
  id: number; ownerId: string; name: string; songCount: number;
  createdAt: string; updatedAt: string;
}
export interface SavedQueue extends SavedQueueMeta { songs: StoredSong[]; }

// on BotDatabase:
saveQueue(ownerId: string, name: string, songs: StoredSong[]): SavedQueue;   // upsert by (ownerId,name)
listSavedQueues(ownerId: string, includeShared: boolean): SavedQueueMeta[];
getSavedQueue(id: number): SavedQueue | null;
deleteSavedQueue(id: number): boolean;
```

- [ ] **Step 1: Write the failing tests**

Add to `src/data/database.test.ts`:

```ts
import { SHARED_QUEUE_OWNER } from "./database.js";

const song = (id: string) => ({ id, name: id, artist: "", album: "", platform: "netease" as const, coverUrl: "", duration: 1 });

describe("saved_queues", () => {
  it("upserts by (ownerId,name) and returns songs", () => {
    const db = createDatabase(":memory:");
    db.saveQueue("u1", "night", [song("a"), song("b")]);
    const again = db.saveQueue("u1", "night", [song("c")]); // overwrite
    expect(again.songCount).toBe(1);
    const list = db.listSavedQueues("u1", false);
    expect(list).toHaveLength(1);
    const full = db.getSavedQueue(again.id)!;
    expect(full.songs.map((s) => s.id)).toEqual(["c"]);
    db.close();
  });

  it("lists own + shared when includeShared, own-only otherwise", () => {
    const db = createDatabase(":memory:");
    db.saveQueue("u1", "mine", [song("a")]);
    db.saveQueue(SHARED_QUEUE_OWNER, "party", [song("b")]);
    expect(db.listSavedQueues("u1", false).map((q) => q.name)).toEqual(["mine"]);
    expect(db.listSavedQueues("u1", true).map((q) => q.name).sort()).toEqual(["mine", "party"]);
    db.close();
  });

  it("caps songs at 1000 and queues at 50", () => {
    const db = createDatabase(":memory:");
    expect(() => db.saveQueue("u1", "big", Array.from({ length: 1001 }, (_, i) => song("s" + i)))).toThrow(/1000/);
    for (let i = 0; i < 50; i++) db.saveQueue("u1", "q" + i, [song("a")]);
    expect(() => db.saveQueue("u1", "q50", [song("a")])).toThrow(/50/);
    db.close();
  });

  it("deletes and degrades a corrupt blob to empty", () => {
    const db = createDatabase(":memory:");
    const q = db.saveQueue("u1", "x", [song("a")]);
    db.db.prepare("UPDATE saved_queues SET songs='not json' WHERE id=?").run(q.id);
    expect(db.getSavedQueue(q.id)!.songs).toEqual([]);
    expect(db.deleteSavedQueue(q.id)).toBe(true);
    expect(db.getSavedQueue(q.id)).toBeNull();
    db.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/data/database.test.ts --no-file-parallelism`
Expected: FAIL — `saveQueue` undefined / `SHARED_QUEUE_OWNER` undefined.

- [ ] **Step 3: Implement**

At the top of `src/data/database.ts` add the import + exports:

```ts
import type { QueuedSong } from "../audio/queue.js";

export const SHARED_QUEUE_OWNER = "__shared__";
export const MAX_SAVED_QUEUES = 50;
export const MAX_QUEUE_SONGS = 1000;
export type StoredSong = Omit<QueuedSong, "url">;
export interface SavedQueueMeta {
  id: number; ownerId: string; name: string; songCount: number;
  createdAt: string; updatedAt: string;
}
export interface SavedQueue extends SavedQueueMeta { songs: StoredSong[]; }
```

Add the four methods to the `BotDatabase` interface (signatures above).

In `initTables`, add the table (inside the `db.exec` template):

```sql
    CREATE TABLE IF NOT EXISTS saved_queues (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ownerId   TEXT NOT NULL,
      name      TEXT NOT NULL,
      songs     TEXT NOT NULL,
      songCount INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(ownerId, name)
    );
    CREATE INDEX IF NOT EXISTS idx_saved_queues_ownerId ON saved_queues(ownerId);
```

(No `migrateSchema` entry needed — `CREATE TABLE IF NOT EXISTS` handles fresh + existing DBs.)

In `createDatabase`, implement the methods (add prepared statements + return-object methods). A safe song-parse helper:

```ts
  const parseSongs = (raw: string): StoredSong[] => {
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; }
    catch { return []; }
  };
  const rowToMeta = (r: any): SavedQueueMeta => ({
    id: r.id, ownerId: r.ownerId, name: r.name, songCount: r.songCount,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  });
```

Methods on the returned object:

```ts
    saveQueue(ownerId, name, songs) {
      if (songs.length > MAX_QUEUE_SONGS) throw new Error(`queue exceeds ${MAX_QUEUE_SONGS} songs`);
      const stripped = songs.map(({ url: _url, ...s }: any) => s);
      const json = JSON.stringify(stripped);
      const existing = db.prepare("SELECT id FROM saved_queues WHERE ownerId=? AND name=?").get(ownerId, name) as { id: number } | undefined;
      if (!existing) {
        const count = (db.prepare("SELECT COUNT(*) c FROM saved_queues WHERE ownerId=?").get(ownerId) as { c: number }).c;
        if (count >= MAX_SAVED_QUEUES) throw new Error(`owner exceeds ${MAX_SAVED_QUEUES} saved queues`);
      }
      db.prepare(`
        INSERT INTO saved_queues (ownerId, name, songs, songCount)
        VALUES (@ownerId, @name, @songs, @songCount)
        ON CONFLICT(ownerId, name) DO UPDATE SET
          songs=excluded.songs, songCount=excluded.songCount, updatedAt=datetime('now')
      `).run({ ownerId, name, songs: json, songCount: stripped.length });
      const row = db.prepare("SELECT * FROM saved_queues WHERE ownerId=? AND name=?").get(ownerId, name);
      return { ...rowToMeta(row), songs: stripped };
    },
    listSavedQueues(ownerId, includeShared) {
      const rows = includeShared
        ? db.prepare("SELECT id,ownerId,name,songCount,createdAt,updatedAt FROM saved_queues WHERE ownerId=? OR ownerId=? ORDER BY updatedAt DESC").all(ownerId, SHARED_QUEUE_OWNER)
        : db.prepare("SELECT id,ownerId,name,songCount,createdAt,updatedAt FROM saved_queues WHERE ownerId=? ORDER BY updatedAt DESC").all(ownerId);
      return (rows as any[]).map(rowToMeta);
    },
    getSavedQueue(id) {
      const row = db.prepare("SELECT * FROM saved_queues WHERE id=?").get(id) as any;
      if (!row) return null;
      return { ...rowToMeta(row), songs: parseSongs(row.songs) };
    },
    deleteSavedQueue(id) {
      return db.prepare("DELETE FROM saved_queues WHERE id=?").run(id).changes > 0;
    },
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/data/database.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/database.ts src/data/database.test.ts
git commit -m "feat(db): saved_queues table + save/list/get/delete with caps (#119)"
```

---

### Task 7: `/api/saved-queues` router + mount + feature gate

**Files:**
- Create: `src/web/api/saved-queues.ts`, `src/web/api/saved-queues.test.ts`
- Modify: `src/web/server.ts` (import + mount at `/api/saved-queues`)

**Interfaces:**
- Consumes: `BotDatabase` saved-queue methods (Task 6); `BotManager` (`getBot`); a `() => boolean` feature-gate reading `config.savedQueuesEnabled`; `bot.getQueueManager()`, `bot.playSingleSong`/queue load helpers.
- Produces: `createSavedQueuesRouter(database, botManager, isEnabled, logger): Router`.

- [ ] **Step 1: Write the failing tests**

Create `src/web/api/saved-queues.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createDatabase } from "../../data/database.js";
import { createSavedQueuesRouter } from "./saved-queues.js";

function mount(enabled: boolean) {
  const db = createDatabase(":memory:");
  const bot = {
    getQueueManager: () => ({ list: () => [{ id: "a", name: "A", artist: "", album: "", platform: "netease", coverUrl: "", duration: 1 }] }),
    loadSavedQueue: (_songs: any[], _mode: string, _by?: string) => {},
  };
  const botManager = { getBot: (_id: string) => bot } as any;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { id: "u1", username: "alice" }; next(); });
  app.use("/api/saved-queues", createSavedQueuesRouter(db, botManager, () => enabled, console as any));
  return { app, db };
}

describe("saved-queues router", () => {
  it("403s all routes when feature disabled", async () => {
    const { app } = mount(false);
    expect((await request(app).get("/api/saved-queues")).status).toBe(403);
    expect((await request(app).post("/api/saved-queues").send({ botId: "b", name: "x" })).status).toBe(403);
  });

  it("saves current queue (private) and lists it", async () => {
    const { app } = mount(true);
    const save = await request(app).post("/api/saved-queues").send({ botId: "b", name: "night" });
    expect(save.status).toBe(200);
    const list = await request(app).get("/api/saved-queues");
    expect(list.body.queues.map((q: any) => q.name)).toContain("night");
  });

  it("saves shared when shared:true and rejects loading another user's private queue", async () => {
    const { app, db } = mount(true);
    db.saveQueue("someoneElse", "private", [{ id: "z" } as any]);
    const other = db.listSavedQueues("someoneElse", false)[0];
    const load = await request(app).post(`/api/saved-queues/${other.id}/load`).send({ botId: "b", mode: "replace" });
    expect(load.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/web/api/saved-queues.test.ts --no-file-parallelism`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the router**

Create `src/web/api/saved-queues.ts`:

```ts
import { Router } from "express";
import type { BotDatabase } from "../../data/database.js";
import { SHARED_QUEUE_OWNER } from "../../data/database.js";
import type { BotManager } from "../../bot/manager.js";
import type { Logger } from "../../logger.js";

export function createSavedQueuesRouter(
  database: BotDatabase,
  botManager: BotManager,
  isEnabled: () => boolean,
  logger: Logger,
): Router {
  const router = Router();

  // Feature gate — inert when savedQueuesEnabled is false.
  router.use((_req, res, next) => {
    if (!isEnabled()) { res.status(403).json({ error: "此功能未启用" }); return; }
    next();
  });

  // GET / — own + shared (meta only)
  router.get("/", (req, res) => {
    const userId = (req as any).user.id;
    res.json({ queues: database.listSavedQueues(userId, true) });
  });

  // POST / — snapshot the bot's current queue, upsert
  router.post("/", (req, res) => {
    const userId = (req as any).user.id;
    const { botId, name, shared } = req.body ?? {};
    if (typeof name !== "string" || !name.trim() || !botId) {
      res.status(400).json({ error: "botId and name are required" }); return;
    }
    const bot = botManager.getBot(botId);
    if (!bot) { res.status(404).json({ error: "bot not found" }); return; }
    const songs = bot.getQueueManager().list();
    if (songs.length === 0) { res.status(400).json({ error: "队列为空，无法保存" }); return; }
    const ownerId = shared === true ? SHARED_QUEUE_OWNER : userId;
    try {
      const saved = database.saveQueue(ownerId, name.trim(), songs as any);
      res.json({ queue: { id: saved.id, ownerId, name: saved.name, songCount: saved.songCount } });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // POST /:id/load — replace | append into a bot
  router.post("/:id/load", async (req, res) => {
    const userId = (req as any).user.id;
    const username = (req as any).user.username as string | undefined;
    const id = parseInt(req.params.id, 10);
    const { botId, mode } = req.body ?? {};
    if (Number.isNaN(id) || !botId) { res.status(400).json({ error: "invalid id/botId" }); return; }
    const sq = database.getSavedQueue(id);
    if (!sq || (sq.ownerId !== userId && sq.ownerId !== SHARED_QUEUE_OWNER)) {
      res.status(404).json({ error: "not found" }); return;
    }
    const bot = botManager.getBot(botId);
    if (!bot) { res.status(404).json({ error: "bot not found" }); return; }
    const loadMode = mode === "append" ? "append" : "replace";
    await bot.loadSavedQueue(sq.songs, loadMode, username || "游客");
    res.json({ ok: true, loaded: sq.songs.length, mode: loadMode });
  });

  // DELETE /:id — own or shared only
  router.delete("/:id", (req, res) => {
    const userId = (req as any).user.id;
    const id = parseInt(req.params.id, 10);
    const sq = database.getSavedQueue(id);
    if (!sq || (sq.ownerId !== userId && sq.ownerId !== SHARED_QUEUE_OWNER)) {
      res.status(404).json({ error: "not found" }); return;
    }
    database.deleteSavedQueue(id);
    logger.info({ userId, id }, "saved queue deleted");
    res.json({ ok: true });
  });

  return router;
}
```

Add `loadSavedQueue` to `BotInstance` (used here + by chat in Task 8):

```ts
  /** Load a saved list into this bot's queue. replace: clear + play; append: add to end. */
  async loadSavedQueue(songs: StoredSong[], mode: "replace" | "append", requesterName?: string): Promise<void> {
    const tagged = songs.map((s) => this.withRequester(s as QueuedSong, requesterName));
    if (mode === "replace") {
      this.queue.clear();
      this.disableFmMode();
      for (const s of tagged) this.queue.add(s);
      this.cleanupQueuedLocalSongs?.("queue_replaced");
      const first = this.queue.play();
      this.player.resetFailures();
      if (first) await this.resolveAndPlay(first);
    } else {
      const wasIdle = this.player.getState() === "idle";
      const startAt = this.queue.size();
      for (const s of tagged) this.queue.add(s);
      if (wasIdle && this.queue.size() > 0) {
        this.queue.playAt(startAt);
        this.player.resetFailures();
        await this.resolveAndPlay(this.queue.current()!);
      }
    }
    this.emit("stateChange");
  }
```

- [ ] **Step 4: Mount in `server.ts`**

Add import near the other API imports:

```ts
import { createSavedQueuesRouter } from "./api/saved-queues.js";
```

Mount alongside favorites (both `requireNotGuest`):

```ts
  app.use("/api/saved-queues", requireNotGuest, createSavedQueuesRouter(
    options.database,
    options.botManager,
    () => options.config.savedQueuesEnabled,
    logger,
  ));
```

(Confirm the exact names `options.botManager` / `options.config` / `options.database` from the surrounding `createPlayerRouter`/`createFavoritesRouter` mounts.)

- [ ] **Step 5: Run + commit**

Run: `npx vitest run src/web/api/saved-queues.test.ts --no-file-parallelism`
Expected: PASS.

```bash
git add src/web/api/saved-queues.ts src/web/api/saved-queues.test.ts src/web/server.ts src/bot/instance.ts
git commit -m "feat(web): /api/saved-queues router + loadSavedQueue (#119)"
```

---

### Task 8: Chat commands `!save` / `!load` / `!queues`

**Files:**
- Modify: `src/bot/instance.ts` (`executeCommand` switch ~604-656, add `cmdSave`/`cmdLoad`/`cmdQueues`, `cmdHelp` ~1361)
- Test: `src/bot/instance.test.ts`

**Interfaces:**
- Consumes: `this.database` saved-queue methods, `SHARED_QUEUE_OWNER`, `this.config.savedQueuesEnabled`, `this.loadSavedQueue` (Task 7), `cmd.flags.has("a")` for append.

- [ ] **Step 1: Write the failing tests**

Add to `src/bot/instance.test.ts`:

```ts
describe("chat save/load/queues", () => {
  it("replies feature-disabled when savedQueuesEnabled is false", async () => {
    const bot = makeBot({ savedQueuesEnabled: false });
    expect(await bot.executeCommand(parseCommand("!save night", "!")!)).toBe("此功能未启用");
  });

  it("saves the current queue to the shared bucket and loads it back", async () => {
    const bot = makeBot({ savedQueuesEnabled: true });
    const q = bot.getQueueManager();
    q.add({ id: "a", name: "A", artist: "", album: "", platform: "netease", coverUrl: "", duration: 1 });
    await bot.executeCommand(parseCommand("!save night", "!")!);
    expect(bot.database.listSavedQueues(SHARED_QUEUE_OWNER, false).map((x) => x.name)).toContain("night");
    const list = await bot.executeCommand(parseCommand("!queues", "!")!);
    expect(list).toContain("night");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/bot/instance.test.ts -t "chat save/load" --no-file-parallelism`
Expected: FAIL — Unknown command.

- [ ] **Step 3: Implement**

In the `executeCommand` switch, add cases (before `default`):

```ts
      case "save":
        return this.cmdSaveQueue(cmd);
      case "load":
        return this.cmdLoadQueue(cmd);
      case "queues":
        return this.cmdListQueues();
```

Add the methods:

```ts
  private savedQueuesGuard(): string | null {
    return this.config.savedQueuesEnabled ? null : "此功能未启用";
  }

  private cmdSaveQueue(cmd: ParsedCommand): string {
    const off = this.savedQueuesGuard(); if (off) return off;
    const name = cmd.args.trim();
    if (!name) return `Usage: ${this.config.commandPrefix}save <名称>`;
    const songs = this.queue.list();
    if (songs.length === 0) return "队列为空，无法保存";
    try {
      const saved = this.database.saveQueue(SHARED_QUEUE_OWNER, name, songs);
      return `已保存队列「${name}」（${saved.songCount} 首）`;
    } catch (err) {
      return `保存失败：${(err as Error).message}`;
    }
  }

  private async cmdLoadQueue(cmd: ParsedCommand): Promise<string> {
    const off = this.savedQueuesGuard(); if (off) return off;
    const name = cmd.args.trim();
    if (!name) return `Usage: ${this.config.commandPrefix}load [-a] <名称>`;
    const owned = this.database.listSavedQueues(SHARED_QUEUE_OWNER, false).find((q) => q.name === name);
    if (!owned) return `找不到已保存队列「${name}」`;
    const full = this.database.getSavedQueue(owned.id);
    if (!full) return `找不到已保存队列「${name}」`;
    const mode = cmd.flags.has("a") ? "append" : "replace";
    await this.loadSavedQueue(full.songs, mode);
    return mode === "append"
      ? `已追加「${name}」（${full.songs.length} 首）到队列`
      : `已加载「${name}」（${full.songs.length} 首）`;
  }

  private cmdListQueues(): string {
    const off = this.savedQueuesGuard(); if (off) return off;
    const list = this.database.listSavedQueues(SHARED_QUEUE_OWNER, false);
    if (list.length === 0) return "还没有已保存的队列";
    return ["已保存队列：", ...list.map((q) => `• ${q.name}（${q.songCount} 首）`)].join("\n");
  }
```

In `cmdHelp`, add before `${p}help`:

```ts
      `${p}save <名称>  — Save current queue`,
      `${p}load [-a] <名称> — Load a saved queue (-a appends)`,
      `${p}queues       — List saved queues`,
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/bot/instance.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/instance.ts src/bot/instance.test.ts
git commit -m "feat(chat): !save / !load [-a] / !queues commands (#119)"
```

---

### Task 9: WebUI Saved Queues page

**Files:**
- Create: `web/src/composables/savedQueues.ts` + `savedQueues.test.ts` (pure helper), `web/src/composables/useSavedQueues.ts`, `web/src/views/SavedQueues.vue`
- Modify: `web/src/router` (route), the nav/menu component (entry, shown only when feature enabled)

**Interfaces:**
- Consumes: `/api/saved-queues` (Task 7); the settings store/flag `savedQueuesEnabled` for nav gating.

- [ ] **Step 1: Write the failing helper test**

Create `web/src/composables/savedQueues.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sortQueues, isShared } from "./savedQueues";

describe("savedQueues helper", () => {
  it("flags shared owner", () => {
    expect(isShared({ ownerId: "__shared__" } as any)).toBe(true);
    expect(isShared({ ownerId: "u1" } as any)).toBe(false);
  });
  it("sorts by updatedAt desc", () => {
    const out = sortQueues([
      { id: 1, updatedAt: "2026-01-01" }, { id: 2, updatedAt: "2026-02-01" },
    ] as any);
    expect(out.map((q) => q.id)).toEqual([2, 1]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/composables/savedQueues.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `web/src/composables/savedQueues.ts`:

```ts
export interface SavedQueueMeta {
  id: number; ownerId: string; name: string; songCount: number;
  createdAt: string; updatedAt: string;
}
export const SHARED_OWNER = "__shared__";
export function isShared(q: SavedQueueMeta): boolean { return q.ownerId === SHARED_OWNER; }
export function sortQueues(qs: SavedQueueMeta[]): SavedQueueMeta[] {
  return [...qs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
```

- [ ] **Step 4: Run helper test**

Run: `cd web && npx vitest run src/composables/savedQueues.test.ts`
Expected: PASS.

- [ ] **Step 5: Build the composable + page + nav**

Create `web/src/composables/useSavedQueues.ts` (axios calls mirroring `useSpotifySettings`/favorites): `list()`, `save(botId, name, shared)`, `load(id, botId, mode)`, `remove(id)`.

Create `web/src/views/SavedQueues.vue`: a page that on mount calls `list()`, shows a **Save current queue** control (text input + 共享 checkbox + bot selector reusing the app's current-bot scope), and a list of entries (name / song count / shared badge via `isShared`) with **Load** (replace), **Append**, **Delete** buttons. Reuse existing list/`SongCard`-style CSS.

Register the route (path `/saved-queues`, component `SavedQueues.vue`) in the router, and add a nav entry that is rendered only when the settings flag `savedQueuesEnabled` is true (read the same settings the Settings page loads — reuse the existing settings store/composable; if none, fetch `/api/bot/settings` once in the nav or an app-level store).

- [ ] **Step 6: Build check**

Run: `cd web && npm run build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add web/src/composables/savedQueues.ts web/src/composables/savedQueues.test.ts web/src/composables/useSavedQueues.ts web/src/views/SavedQueues.vue web/src/router* web/src/**/*Nav* 2>/dev/null; git add -A web/src
git commit -m "feat(web): Saved Queues page + nav gated on savedQueuesEnabled (#119)"
```

---

## Stage 4 — Feature 2: auto-restore live queue

### Task 10: `PlayQueue.snapshot()` / `restore()`

**Files:**
- Modify: `src/audio/queue.ts`
- Test: `src/audio/queue.test.ts`

**Interfaces:**
- Produces:

```ts
export interface QueueSnapshot {
  songs: Omit<QueuedSong, "url">[];
  currentIndex: number;
  mode: PlayMode;
}
// on PlayQueue:
snapshot(): QueueSnapshot;
restore(s: QueueSnapshot): void;
```

- [ ] **Step 1: Write the failing test**

Add to `src/audio/queue.test.ts`:

```ts
it("snapshot/restore round-trips songs, index, and mode", () => {
  const q = new PlayQueue();
  q.add({ id: "a", name: "A", artist: "", album: "", platform: "netease", coverUrl: "", duration: 1, url: "http://x" });
  q.add({ id: "b", name: "B", artist: "", album: "", platform: "qq", coverUrl: "", duration: 2 });
  q.setMode(PlayMode.Loop);
  q.play(); q.next(); // current = index 1
  const snap = q.snapshot();
  expect(snap.currentIndex).toBe(1);
  expect(snap.mode).toBe(PlayMode.Loop);
  expect((snap.songs[0] as any).url).toBeUndefined(); // url stripped

  const q2 = new PlayQueue();
  q2.restore(snap);
  expect(q2.list().map((s) => s.id)).toEqual(["a", "b"]);
  expect(q2.getCurrentIndex()).toBe(1);
  expect(q2.getMode()).toBe(PlayMode.Loop);
  expect(q2.current()?.id).toBe("b");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/audio/queue.test.ts --no-file-parallelism`
Expected: FAIL — `snapshot` undefined.

- [ ] **Step 3: Implement**

Add the interface export near `QueuedSong`, and these methods to `PlayQueue`:

```ts
  snapshot(): QueueSnapshot {
    return {
      songs: this.songs.map(({ url: _url, ...s }) => s),
      currentIndex: this.currentIndex,
      mode: this.mode,
    };
  }

  restore(s: QueueSnapshot): void {
    this.songs = s.songs.map((song) => ({ ...song }));
    this.mode = s.mode;
    this.currentIndex =
      s.currentIndex >= 0 && s.currentIndex < this.songs.length ? s.currentIndex : -1;
    // Rebuild derived state consistently for the restored position.
    this.playedIndices = new Set(this.currentIndex >= 0 ? [this.currentIndex] : []);
    this.history = [];
    this.forwardStack = [];
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/audio/queue.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/audio/queue.ts src/audio/queue.test.ts
git commit -m "feat(queue): snapshot/restore for cross-restart persistence (#119)"
```

---

### Task 11: DB — `queue_state` table + methods

**Files:**
- Modify: `src/data/database.ts`
- Test: `src/data/database.test.ts`

**Interfaces:**
- Produces:

```ts
export interface QueueStateRow {
  botId: string; songs: StoredSong[]; currentIndex: number;
  mode: string; isFmMode: boolean; fmPlatform: string;
}
// on BotDatabase:
saveQueueState(state: QueueStateRow): void;   // upsert by botId
getQueueState(botId: string): QueueStateRow | null;
clearQueueState(botId: string): void;
```

- [ ] **Step 1: Write the failing test**

Add to `src/data/database.test.ts`:

```ts
describe("queue_state", () => {
  it("upserts, reads back, and clears per bot", () => {
    const db = createDatabase(":memory:");
    db.saveQueueState({ botId: "b1", songs: [{ id: "a" } as any], currentIndex: 0, mode: "loop", isFmMode: true, fmPlatform: "netease" });
    db.saveQueueState({ botId: "b1", songs: [{ id: "a" } as any, { id: "b" } as any], currentIndex: 1, mode: "seq", isFmMode: false, fmPlatform: "" });
    const st = db.getQueueState("b1")!;
    expect(st.songs.map((s) => s.id)).toEqual(["a", "b"]);
    expect(st.currentIndex).toBe(1);
    expect(st.isFmMode).toBe(false);
    db.clearQueueState("b1");
    expect(db.getQueueState("b1")).toBeNull();
    db.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/data/database.test.ts -t "queue_state" --no-file-parallelism`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add `QueueStateRow` export + the three `BotDatabase` methods. Add the table to `initTables`:

```sql
    CREATE TABLE IF NOT EXISTS queue_state (
      botId        TEXT PRIMARY KEY,
      songs        TEXT NOT NULL,
      currentIndex INTEGER NOT NULL,
      mode         TEXT NOT NULL,
      isFmMode     INTEGER NOT NULL DEFAULT 0,
      fmPlatform   TEXT NOT NULL DEFAULT '',
      updatedAt    TEXT NOT NULL DEFAULT (datetime('now'))
    );
```

In `createDatabase`:

```ts
    saveQueueState(state) {
      db.prepare(`
        INSERT INTO queue_state (botId, songs, currentIndex, mode, isFmMode, fmPlatform, updatedAt)
        VALUES (@botId, @songs, @currentIndex, @mode, @isFmMode, @fmPlatform, datetime('now'))
        ON CONFLICT(botId) DO UPDATE SET
          songs=excluded.songs, currentIndex=excluded.currentIndex, mode=excluded.mode,
          isFmMode=excluded.isFmMode, fmPlatform=excluded.fmPlatform, updatedAt=datetime('now')
      `).run({
        botId: state.botId, songs: JSON.stringify(state.songs), currentIndex: state.currentIndex,
        mode: state.mode, isFmMode: state.isFmMode ? 1 : 0, fmPlatform: state.fmPlatform,
      });
    },
    getQueueState(botId) {
      const r = db.prepare("SELECT * FROM queue_state WHERE botId=?").get(botId) as any;
      if (!r) return null;
      return {
        botId: r.botId, songs: parseSongs(r.songs), currentIndex: r.currentIndex,
        mode: r.mode, isFmMode: r.isFmMode === 1, fmPlatform: r.fmPlatform,
      };
    },
    clearQueueState(botId) {
      db.prepare("DELETE FROM queue_state WHERE botId=?").run(botId);
    },
```

(Reuse the `parseSongs` helper from Task 6.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/data/database.test.ts -t "queue_state" --no-file-parallelism`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/database.ts src/data/database.test.ts
git commit -m "feat(db): queue_state table for live-queue persistence (#119)"
```

---

### Task 12: BotInstance snapshot-on-change + restore-on-connect

**Files:**
- Modify: `src/bot/instance.ts` (constructor/emit path, `connect`/`connected` handler)
- Test: `src/bot/instance.test.ts`

**Interfaces:**
- Consumes: `this.database.saveQueueState/getQueueState/clearQueueState`, `this.queue.snapshot()/restore()`, `this.config.savedQueuesEnabled`, `this.isFmMode`, `this.fmProvider`, `this.resolveAndPlay`.

- [ ] **Step 1: Write the failing tests**

Add to `src/bot/instance.test.ts`:

```ts
describe("live-queue persistence", () => {
  it("persists a snapshot on stateChange when enabled", async () => {
    const bot = makeBot({ savedQueuesEnabled: true });
    bot.getQueueManager().add({ id: "a", name: "A", artist: "", album: "", platform: "netease", coverUrl: "", duration: 1 });
    bot.getQueueManager().play();
    bot["persistQueueSnapshot"](); // call the (debounced) writer's inner sync fn directly
    const st = bot.database.getQueueState(bot.id)!;
    expect(st.songs.map((s: any) => s.id)).toEqual(["a"]);
  });

  it("does NOT persist when feature disabled", () => {
    const bot = makeBot({ savedQueuesEnabled: false });
    bot.getQueueManager().add({ id: "a", name: "A", artist: "", album: "", platform: "netease", coverUrl: "", duration: 1 });
    bot["persistQueueSnapshot"]();
    expect(bot.database.getQueueState(bot.id)).toBeNull();
  });

  it("restores and resumes on restore()", async () => {
    const src = makeBot({ savedQueuesEnabled: true });
    src.getQueueManager().add({ id: "a", name: "A", artist: "", album: "", platform: "netease", coverUrl: "", duration: 1 });
    src.getQueueManager().play();
    src["persistQueueSnapshot"]();

    const bot = makeBot({ savedQueuesEnabled: true }, src.database); // share DB
    const spy = vi.spyOn(bot, "resolveAndPlay").mockResolvedValue(true);
    await bot["restoreQueueFromSnapshot"]();
    expect(bot.getQueueManager().list().map((s) => s.id)).toEqual(["a"]);
    expect(spy).toHaveBeenCalled();
  });
});
```

(Extend `makeBot` to accept an optional shared `database`. The two private methods are called via bracket access in tests.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/bot/instance.test.ts -t "live-queue persistence" --no-file-parallelism`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement**

Add a debounced snapshot writer + a restore method to `BotInstance`:

```ts
  private snapshotTimer: NodeJS.Timeout | null = null;

  /** Synchronous snapshot writer (debounced via scheduleQueueSnapshot). */
  private persistQueueSnapshot(): void {
    if (!this.config.savedQueuesEnabled) return;
    try {
      const snap = this.queue.snapshot();
      if (snap.songs.length === 0) {
        this.database.clearQueueState(this.id);
        return;
      }
      this.database.saveQueueState({
        botId: this.id,
        songs: snap.songs,
        currentIndex: snap.currentIndex,
        mode: snap.mode,
        isFmMode: this.isFmMode,
        fmPlatform: this.isFmMode && this.fmProvider ? this.fmProvider.platform : "",
      });
    } catch (err) {
      this.logger.warn({ err }, "queue snapshot persist failed");
    }
  }

  private scheduleQueueSnapshot(): void {
    if (!this.config.savedQueuesEnabled) return;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => this.persistQueueSnapshot(), 1000);
  }

  /** Restore + resume the live queue after (re)connect. Best-effort. */
  private async restoreQueueFromSnapshot(): Promise<void> {
    if (!this.config.savedQueuesEnabled) return;
    const st = this.database.getQueueState(this.id);
    if (!st || st.songs.length === 0) return;
    this.queue.restore({ songs: st.songs, currentIndex: st.currentIndex, mode: st.mode as PlayMode });
    if (st.isFmMode && st.fmPlatform) {
      this.isFmMode = true;
      this.fmProvider = this.providerForPlatform(st.fmPlatform); // reuse existing platform→provider map
    }
    const current = this.queue.current();
    if (current) {
      this.player.resetFailures();
      await this.resolveAndPlay(current); // resumes from track start
    }
  }
```

Wire the debounced writer into the existing `stateChange` emit path. The cleanest single hook: add a listener in the constructor:

```ts
    this.on("stateChange", () => this.scheduleQueueSnapshot());
```

Wire the restore into the connect flow — after `this.emit("connected")` in `connect()`:

```ts
    void this.restoreQueueFromSnapshot();
```

(Restore runs once per connect. `providerForPlatform` — reuse the existing platform→provider resolution used by `getProvider`/FM; if only a flags-based `getProvider` exists, add a small `providerForPlatform(platform: string): MusicProvider` switch that returns the matching provider, defaulting to netease.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/bot/instance.test.ts --no-file-parallelism`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bot/instance.ts src/bot/instance.test.ts
git commit -m "feat(player): snapshot live queue on change + resume on reconnect (#119)"
```

---

## Stage 5 — Docs & final verification

### Task 13: README + full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**

- Commands table: add `!save <名称>`, `!load [-a] <名称>`, `!queues`.
- 行为设置 / feature docs: document `savedQueuesEnabled` (default off, admin — enables save/load + restart auto-resume) and `playKeepsQueue` (default off — single-song `!play` keeps the queue).
- Changelog "最新版本 → 功能增强": add `#119 保存/加载播放清单 + 重启恢复队列 + 单曲播放不清空队列（均默认关闭）` with the honest caveats: restart resumes the current track **from its start**; Spotify auto-resume is best-effort.

- [ ] **Step 2: Full verification**

```bash
npx vitest run --no-file-parallelism
npx tsc --noEmit
cd web && npm run build && cd ..
```

Expected: all tests pass; tsc exit 0; web build clean.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document save/load queues + playKeepsQueue toggles (#119)"
```

- [ ] **Step 4: Push + open PR**

```bash
git push -u origin feat/issue-119-saved-queues
gh pr create --fill --base main
```

---

## Self-Review

**Spec coverage:**
- Feature 1 (named save/load, per-user + shared, chat + web, replace/append) → Tasks 6, 7, 8, 9. ✓
- Feature 2 (auto-restore + resume) → Tasks 10, 11, 12. ✓
- Feature 3 (`playKeepsQueue`) → Tasks 4, 5. ✓
- Config gates (both default off, sanitized) → Task 1; admin settings → Tasks 2, 3. ✓
- Caps, corrupt-blob degradation, ownership 404 → Task 6/7 tests. ✓
- Caveats (track-start resume, Spotify best-effort) → Task 13 docs; behavior in Task 12. ✓

**Type consistency:** `StoredSong`, `SavedQueue(Meta)`, `QueueSnapshot`, `QueueStateRow`, `SHARED_QUEUE_OWNER`, `playSingleSong`, `loadSavedQueue`, `saveQueue/listSavedQueues/getSavedQueue/deleteSavedQueue`, `saveQueueState/getQueueState/clearQueueState`, `snapshot/restore`, `persistQueueSnapshot/scheduleQueueSnapshot/restoreQueueFromSnapshot` — names are used identically across the tasks that define and consume them.

**Open verification items for the implementer (flagged inline):**
- Confirm the `config` object is shared by reference from `index.ts` → `createBotRouter` AND → each `BotInstance` (Task 2), so the toggles take effect without restart.
- Confirm `WebServerOptions` exposes `botManager`, `config`, `database` under those names at the `server.ts` mount site (Task 7).
- Confirm/add `providerForPlatform` on `BotInstance` (Task 12).
