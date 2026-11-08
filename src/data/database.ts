import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { CAPABILITIES, BOTS_ALL } from "./permissions.js";
import { GUEST_USER_ID, GUEST_USERNAME } from "./users.js";
import type { QueuedSong } from "../audio/queue.js";

/**
 * Reserved owner id for chat-saved / opt-in-shared queues. A `__`-bracketed
 * literal can never collide with a real WebUI user id (UUIDs), so it cleanly
 * partitions "shared" saved queues from per-user private ones (issue #119).
 */
export const SHARED_QUEUE_OWNER = "__shared__";
/** Cap per owner (private user OR the shared bucket). */
export const MAX_SAVED_QUEUES = 50;
/** Cap per saved queue / persisted live-queue snapshot. */
export const MAX_QUEUE_SONGS = 1000;

/** A stored song is a QueuedSong minus the lazily-resolved `url`. */
export type StoredSong = Omit<QueuedSong, "url">;

/** Saved-queue row without the (potentially large) songs blob — for list views. */
export interface SavedQueueMeta {
  id: number;
  ownerId: string;
  name: string;
  songCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Full saved queue, including its songs. */
export interface SavedQueue extends SavedQueueMeta {
  songs: StoredSong[];
}

/** One-row-per-bot persisted live-queue state (Feature 2, auto-restore). */
export interface QueueStateRow {
  botId: string;
  songs: StoredSong[];
  currentIndex: number;
  mode: string;
  isFmMode: boolean;
  fmPlatform: string;
}

export interface PlayHistoryEntry {
  botId: string;
  songId: string;
  songName: string;
  artist: string;
  album: string;
  platform: "netease" | "qq" | "bilibili" | "youtube" | "local" | "kugou" | "spotify" | "jellyfin";
  coverUrl: string;
  requestedBy?: string;
}

export interface PlayHistoryRecord extends PlayHistoryEntry {
  id: number;
  playedAt: string;
}

export interface BotInstance {
  id: string;
  name: string;
  serverAddress: string;
  serverPort: number;
  nickname: string;
  defaultChannel: string;
  channelId: string;
  channelPassword: string;
  autoStart: boolean;
  /** "ts3" | "ts6" | "" (empty = auto-detect) */
  serverProtocol: string;
  /** API key for TS6 HTTP Query */
  ts6ApiKey: string;
  /** Password to join the TS server (server password) */
  serverPassword: string;
  identity?: string;
}

export interface ProfileConfig {
  avatarEnabled: boolean;
  descriptionEnabled: boolean;
  nicknameEnabled: boolean;
  awayStatusEnabled: boolean;
  channelDescEnabled: boolean;
  nowPlayingMsgEnabled: boolean;
}

export const DEFAULT_PROFILE_CONFIG: ProfileConfig = {
  avatarEnabled: true,
  descriptionEnabled: true,
  nicknameEnabled: true,
  awayStatusEnabled: true,
  channelDescEnabled: true,
  nowPlayingMsgEnabled: true,
};

/**
 * Per-bot player settings persisted across restarts (#125): the playback volume
 * and play mode. These reset to defaults on process restart when kept only in
 * memory (AudioPlayer/PlayQueue), so they are stored on the bot_instances row —
 * exactly like the per-bot profile flags — and restored when the bot is (re)built.
 */
export interface PlayerSettings {
  /** 0-100. */
  volume: number;
  /** PlayMode string: "seq" | "loop" | "random" | "rloop". */
  playMode: string;
}

const PLAY_MODES = new Set(["seq", "loop", "random", "rloop"]);

export const DEFAULT_PLAYER_SETTINGS: PlayerSettings = {
  volume: 75,
  playMode: "seq",
};

export interface FavoritePlaylist {
  id: number;
  userId: string;
  platform: string;
  playlistId: string;
  name: string;
  coverUrl: string;
  songCount: number;
  createdAt: string;
}

/**
 * A music-platform login the ADMIN owns and may hand out to members
 * (`perUserMusicAccounts`, #164 follow-up).
 *
 * Two separate tables, on purpose:
 *   - `music_accounts`  = the pool. Only the admin writes it.
 *   - `music_account_grants` = "member X may use account Y".
 *
 * Keeping grants out of `user_music_cookies` is what makes "self-linked beats
 * admin-granted" possible: a member scanning their own QR code must not
 * silently overwrite (or be overwritten by) an account the admin assigned, and
 * unlinking on the member side must never revoke what the admin granted.
 *
 * `cookie` is server-side only — the API layer masks it before answering.
 */
export interface MusicAccount {
  id: string;
  platform: string;
  /** Admin-facing name ("网易云-主号"). Members see this instead of a nickname. */
  label: string;
  cookie: string;
  /** Who provided the login; null = imported from the bot's shared login. */
  ownerId: string | null;
  /** 0 = any number of grantees, 1 = exclusive (one member at a time). */
  capacity: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One row of `music_account_grants`, joined with display fields for the UI. */
export interface MusicAccountGrant {
  userId: string;
  username: string;
  platform: string;
  accountId: string;
  accountLabel: string;
  grantedBy: string;
  grantedAt: string;
}

/** An account resolved FOR a user: what provider-scope needs to build a view. */
export interface GrantedMusicAccount {
  accountId: string;
  label: string;
  cookie: string;
}

export interface BotDatabase {
  db: Database.Database;
  addPlayHistory(entry: PlayHistoryEntry): void;
  getPlayHistory(botId: string, limit: number): PlayHistoryRecord[];
  saveBotInstance(instance: BotInstance): void;
  getBotInstances(): BotInstance[];
  deleteBotInstance(id: string): boolean;
  getProfileConfig(botId: string): ProfileConfig;
  saveProfileConfig(botId: string, config: ProfileConfig): void;
  getPlayerSettings(botId: string): PlayerSettings;
  saveVolume(botId: string, volume: number): void;
  savePlayMode(botId: string, playMode: string): void;
  getCustomAvatarPath(botId: string): string | null;
  setCustomAvatarPath(botId: string, path: string | null): void;
  addFavorite(userId: string, playlist: { platform: string; playlistId: string; name: string; coverUrl: string; songCount: number }): void;
  removeFavorite(userId: string, playlistId: string, platform: string): boolean;
  getFavorites(userId: string): FavoritePlaylist[];
  isFavorited(userId: string, playlistId: string, platform: string): boolean;
  // Per-user music account cookies (#164).
  getUserMusicCookie(userId: string, platform: string): string | null;
  setUserMusicCookie(userId: string, platform: string, cookie: string): void;
  deleteUserMusicCookie(userId: string, platform: string): boolean;
  /** null when the member never chose; callers treat that as "prefer own". */
  getUserMusicPreference(userId: string, platform: string): { preferShared: boolean } | null;
  setUserMusicPreference(userId: string, platform: string, preferShared: boolean): void;
  // Admin-owned account pool + assignments (#164 follow-up).
  listMusicAccounts(platform?: string): MusicAccount[];
  getMusicAccount(id: string): MusicAccount | null;
  createMusicAccount(input: {
    platform: string;
    label: string;
    cookie: string;
    ownerId?: string | null;
    capacity?: number;
    enabled?: boolean;
  }): MusicAccount;
  /**
   * Partial update; false when the id does not exist.
   *
   * `platform` is intentionally NOT patchable: grants are keyed by
   * (userId, platform) while pointing at `accountId`, so moving an account to
   * another platform would silently orphan every existing assignment (the
   * grant would still say "netease" while the account says "qq"). Re-create the
   * account instead — that path preserves the invariant.
   */
  updateMusicAccount(
    id: string,
    patch: Partial<Pick<MusicAccount, "label" | "cookie" | "capacity" | "enabled">>,
  ): boolean;
  /** Removes the account AND every grant pointing at it (FK cascade). */
  deleteMusicAccount(id: string): boolean;
  countMusicAccountGrants(accountId: string): number;
  listMusicAccountGrants(accountId: string): MusicAccountGrant[];
  /** Every grant, grouped for the admin overview page. */
  listAllMusicAccountGrants(): MusicAccountGrant[];
  /**
   * Assign `accountId` to `userId`, enforcing enabled/capacity in ONE
   * transaction so two concurrent assignments cannot both pass the capacity
   * check and overshoot an exclusive account.
   */
  assignMusicAccount(
    userId: string,
    accountId: string,
    grantedBy: string,
  ):
    | { ok: true; replacedAccountId: string | null }
    | { ok: false; reason: "not_found" | "disabled" | "exclusive" | "full" };
  deleteMusicAccountGrant(userId: string, platform: string): boolean;
  /** The account an admin assigned to `userId`, or null. Disabled accounts are skipped. */
  getGrantedMusicAccount(userId: string, platform: string): GrantedMusicAccount | null;
  // Saved queues (Feature 1) — upsert by (ownerId, name), capped.
  saveQueue(ownerId: string, name: string, songs: StoredSong[]): SavedQueue;
  listSavedQueues(ownerId: string, includeShared: boolean): SavedQueueMeta[];
  getSavedQueue(id: number): SavedQueue | null;
  deleteSavedQueue(id: number): boolean;
  // Live-queue persistence (Feature 2) — one row per bot.
  saveQueueState(state: QueueStateRow): void;
  getQueueState(botId: string): QueueStateRow | null;
  clearQueueState(botId: string): void;
  close(): void;
}

function migrateSchema(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(bot_instances)").all() as Array<{ name: string }>;
  const names = columns.map((c) => c.name);
  if (!names.includes("identity")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN identity TEXT");
  }
  if (!names.includes("serverProtocol")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN serverProtocol TEXT NOT NULL DEFAULT ''");
  }
  if (!names.includes("ts6ApiKey")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN ts6ApiKey TEXT NOT NULL DEFAULT ''");
  }
  if (!names.includes("serverPassword")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN serverPassword TEXT NOT NULL DEFAULT ''");
  }
  if (!names.includes("channelId")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN channelId TEXT NOT NULL DEFAULT ''");
  }
  // Profile feature flags
  const profileCols = [
    "profile_avatar_enabled",
    "profile_description_enabled",
    "profile_nickname_enabled",
    "profile_away_enabled",
    "profile_channel_desc_enabled",
    "profile_now_playing_enabled",
  ];
  for (const col of profileCols) {
    if (!names.includes(col)) {
      db.exec(`ALTER TABLE bot_instances ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 1`);
    }
  }
  if (!names.includes("custom_avatar_path")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN custom_avatar_path TEXT");
  }
  // Per-bot persisted player settings (#125): volume + play mode. Defaults match
  // AudioPlayer/PlayQueue's in-memory defaults so pre-existing rows keep behaving
  // exactly as before until the user changes them.
  if (!names.includes("volume")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN volume INTEGER NOT NULL DEFAULT 75");
  }
  if (!names.includes("play_mode")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN play_mode TEXT NOT NULL DEFAULT 'seq'");
  }

  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const userColNames = userColumns.map((c) => c.name);
  if (!userColNames.includes("role")) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
  }
  if (!userColNames.includes("accentColor")) {
    db.exec("ALTER TABLE users ADD COLUMN accentColor TEXT NOT NULL DEFAULT '#335eea'");
  }

  const historyColumns = db.prepare("PRAGMA table_info(play_history)").all() as Array<{ name: string }>;
  const historyColNames = historyColumns.map((c) => c.name);
  if (!historyColNames.includes("requestedBy")) {
    db.exec("ALTER TABLE play_history ADD COLUMN requestedBy TEXT NOT NULL DEFAULT ''");
  }
}

function initTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      botId TEXT NOT NULL,
      songId TEXT NOT NULL,
      songName TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT NOT NULL,
      platform TEXT NOT NULL,
      coverUrl TEXT NOT NULL,
      requestedBy TEXT NOT NULL DEFAULT '',
      playedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bot_instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      serverAddress TEXT NOT NULL,
      serverPort INTEGER NOT NULL,
      nickname TEXT NOT NULL,
      defaultChannel TEXT NOT NULL,
      channelId TEXT NOT NULL DEFAULT '',
      channelPassword TEXT NOT NULL,
      autoStart INTEGER NOT NULL DEFAULT 0,
      serverProtocol TEXT NOT NULL DEFAULT '',
      ts6ApiKey TEXT NOT NULL DEFAULT '',
      serverPassword TEXT NOT NULL DEFAULT '',
      volume INTEGER NOT NULL DEFAULT 75,
      play_mode TEXT NOT NULL DEFAULT 'seq',
      identity TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      passwordHash TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin'
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL,
      lastSeenAt INTEGER NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_userId ON sessions(userId);
    CREATE INDEX IF NOT EXISTS idx_sessions_expiresAt ON sessions(expiresAt);

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      name TEXT NOT NULL,
      keyHash TEXT NOT NULL UNIQUE,
      keyPrefix TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      lastUsedAt INTEGER,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_userId ON api_keys(userId);

    CREATE TABLE IF NOT EXISTS user_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      actorId TEXT,
      actorUsername TEXT,
      targetUserId TEXT,
      targetUsername TEXT,
      action TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_audit_timestamp ON user_audit(timestamp DESC);

    CREATE TABLE IF NOT EXISTS favorite_playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      platform TEXT NOT NULL,
      playlistId TEXT NOT NULL,
      name TEXT NOT NULL,
      coverUrl TEXT NOT NULL DEFAULT '',
      songCount INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(userId, platform, playlistId)
    );
    CREATE INDEX IF NOT EXISTS idx_favorites_userId ON favorite_playlists(userId);

    CREATE TABLE IF NOT EXISTS user_permissions (
      userId     TEXT NOT NULL,
      permission TEXT NOT NULL,
      PRIMARY KEY (userId, permission),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS user_bot_access (
      userId TEXT NOT NULL,
      botId  TEXT NOT NULL,
      PRIMARY KEY (userId, botId),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_bot_access_userId ON user_bot_access(userId);

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

    CREATE TABLE IF NOT EXISTS queue_state (
      botId        TEXT PRIMARY KEY,
      songs        TEXT NOT NULL,
      currentIndex INTEGER NOT NULL,
      mode         TEXT NOT NULL,
      isFmMode     INTEGER NOT NULL DEFAULT 0,
      fmPlatform   TEXT NOT NULL DEFAULT '',
      updatedAt    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- A web user's own music-platform login (#164), used for their personal
    -- FM instead of the bot's shared account. Secret: never sent to clients.
    CREATE TABLE IF NOT EXISTS user_music_cookies (
      userId    TEXT NOT NULL,
      platform  TEXT NOT NULL,
      cookie    TEXT NOT NULL,
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (userId, platform),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Which login a member wants to use for a platform (#164 follow-up).
    -- preferShared = 1 means "ignore my own / assigned account and play
    -- through the bot's shared login", which is how someone whose own account
    -- has no membership still gets to play paid tracks. Default 0 keeps the
    -- privacy-first behaviour (own account wins).
    CREATE TABLE IF NOT EXISTS user_music_prefs (
      userId       TEXT NOT NULL,
      platform     TEXT NOT NULL,
      preferShared INTEGER NOT NULL DEFAULT 0,
      updatedAt    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (userId, platform),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Admin-owned music logins that can be handed out to members (#164
    -- follow-up). Separate from user_music_cookies so a member's own QR login
    -- and an admin's assignment never overwrite each other.
    CREATE TABLE IF NOT EXISTS music_accounts (
      id        TEXT PRIMARY KEY,
      platform  TEXT NOT NULL,
      label     TEXT NOT NULL,
      cookie    TEXT NOT NULL,
      ownerId   TEXT,
      capacity  INTEGER NOT NULL DEFAULT 0,
      enabled   INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_music_accounts_platform ON music_accounts(platform);

    -- "member X may use account Y". PK (userId, platform) = at most one
    -- assigned account per platform per member; assigning another replaces it.
    -- accountId cascade keeps a deleted account from leaving dangling grants.
    CREATE TABLE IF NOT EXISTS music_account_grants (
      userId    TEXT NOT NULL,
      platform  TEXT NOT NULL,
      accountId TEXT NOT NULL,
      grantedBy TEXT NOT NULL,
      grantedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (userId, platform),
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (accountId) REFERENCES music_accounts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_music_account_grants_accountId
      ON music_account_grants(accountId);
  `);
}

/**
 * One-time backfill: existing `member` users created before the
 * account-permissions feature are granted full access (all 5 capabilities +
 * the `bots.all` marker), exactly once per database. Admins are skipped (they
 * bypass permission checks). New members created after this runs are not
 * affected — they get the basic tier via POST /api/users. A marker row in
 * `schema_meta` makes this idempotent.
 */
export function backfillMemberPermissions(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)`);
  const done = db.prepare("SELECT value FROM schema_meta WHERE key = 'perm_backfill_done'").get();
  if (done) return;
  const members = db.prepare("SELECT id FROM users WHERE role = 'member'").all() as { id: string }[];
  const insCap = db.prepare("INSERT OR IGNORE INTO user_permissions (userId, permission) VALUES (?, ?)");
  const tokens = [...CAPABILITIES, BOTS_ALL];
  const tx = db.transaction(() => {
    for (const m of members) {
      for (const t of tokens) insCap.run(m.id, t);
    }
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('perm_backfill_done', ?)").run(String(members.length));
  });
  tx();
}

/**
 * Ensure the reserved guest principal exists. Idempotent via the PK on
 * `users.id`. This row only backs login-less guest sessions; it is excluded
 * from countUsers()/listUsers() so it never interferes with first-run setup
 * or the user-management UI, and holds an unusable password hash.
 */
export function ensureGuestUser(db: Database.Database): void {
  const now = Date.now();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, passwordHash, createdAt, updatedAt, role) VALUES (?, ?, '!', ?, ?, 'guest')"
  ).run(GUEST_USER_ID, GUEST_USERNAME, now, now);
}

export function createDatabase(dbPath: string): BotDatabase {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initTables(db);
  migrateSchema(db);
  backfillMemberPermissions(db);
  ensureGuestUser(db);

  const insertHistory = db.prepare(`
    INSERT INTO play_history (botId, songId, songName, artist, album, platform, coverUrl, requestedBy)
    VALUES (@botId, @songId, @songName, @artist, @album, @platform, @coverUrl, @requestedBy)
  `);

  const selectHistory = db.prepare(`
    SELECT * FROM play_history WHERE botId = ? ORDER BY id DESC LIMIT ?
  `);

  const upsertInstance = db.prepare(`
    INSERT INTO bot_instances (id, name, serverAddress, serverPort, nickname, defaultChannel, channelId, channelPassword, autoStart, serverProtocol, ts6ApiKey, serverPassword, identity)
    VALUES (@id, @name, @serverAddress, @serverPort, @nickname, @defaultChannel, @channelId, @channelPassword, @autoStart, @serverProtocol, @ts6ApiKey, @serverPassword, @identity)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      serverAddress = excluded.serverAddress,
      serverPort = excluded.serverPort,
      nickname = excluded.nickname,
      defaultChannel = excluded.defaultChannel,
      channelId = excluded.channelId,
      channelPassword = excluded.channelPassword,
      autoStart = excluded.autoStart,
      serverProtocol = excluded.serverProtocol,
      ts6ApiKey = excluded.ts6ApiKey,
      serverPassword = excluded.serverPassword,
      identity = excluded.identity
  `);

  const selectInstances = db.prepare(`SELECT * FROM bot_instances`);

  const deleteInstance = db.prepare(`DELETE FROM bot_instances WHERE id = ?`);

  const selectProfileConfig = db.prepare(`
    SELECT profile_avatar_enabled, profile_description_enabled,
           profile_nickname_enabled, profile_away_enabled,
           profile_channel_desc_enabled, profile_now_playing_enabled
    FROM bot_instances WHERE id = ?
  `);

  const updateProfileConfig = db.prepare(`
    UPDATE bot_instances SET
      profile_avatar_enabled = @avatar,
      profile_description_enabled = @description,
      profile_nickname_enabled = @nickname,
      profile_away_enabled = @away,
      profile_channel_desc_enabled = @channelDesc,
      profile_now_playing_enabled = @nowPlaying
    WHERE id = @id
  `);

  const selectPlayerSettings = db.prepare(
    `SELECT volume, play_mode FROM bot_instances WHERE id = ?`,
  );
  const updateVolume = db.prepare(`UPDATE bot_instances SET volume = ? WHERE id = ?`);
  const updatePlayMode = db.prepare(`UPDATE bot_instances SET play_mode = ? WHERE id = ?`);

  const selectCustomAvatar = db.prepare(`SELECT custom_avatar_path FROM bot_instances WHERE id = ?`);
  const updateCustomAvatar = db.prepare(`UPDATE bot_instances SET custom_avatar_path = ? WHERE id = ?`);

  const insertFavorite = db.prepare(`
    INSERT INTO favorite_playlists (userId, platform, playlistId, name, coverUrl, songCount)
    VALUES (@userId, @platform, @playlistId, @name, @coverUrl, @songCount)
  `);

  const deleteFavorite = db.prepare(`
    DELETE FROM favorite_playlists WHERE userId = ? AND playlistId = ? AND platform = ?
  `);

  const selectFavorites = db.prepare(`
    SELECT id, userId, platform, playlistId, name, coverUrl, songCount, createdAt
    FROM favorite_playlists WHERE userId = ? ORDER BY createdAt DESC
  `);

  const checkFavorited = db.prepare(`
    SELECT 1 FROM favorite_playlists WHERE userId = ? AND playlistId = ? AND platform = ?
  `);

  const selectUserMusicCookie = db.prepare(
    `SELECT cookie FROM user_music_cookies WHERE userId = ? AND platform = ?`,
  );
  const upsertUserMusicCookie = db.prepare(`
    INSERT INTO user_music_cookies (userId, platform, cookie) VALUES (?, ?, ?)
    ON CONFLICT(userId, platform) DO UPDATE SET cookie = excluded.cookie, updatedAt = datetime('now')
  `);
  const deleteUserMusicCookieStmt = db.prepare(
    `DELETE FROM user_music_cookies WHERE userId = ? AND platform = ?`,
  );

  const selectUserMusicPref = db.prepare(
    `SELECT preferShared FROM user_music_prefs WHERE userId = ? AND platform = ?`,
  );
  const upsertUserMusicPref = db.prepare(`
    INSERT INTO user_music_prefs (userId, platform, preferShared) VALUES (?, ?, ?)
    ON CONFLICT(userId, platform) DO UPDATE SET preferShared = excluded.preferShared, updatedAt = datetime('now')
  `);

  // ---- Admin-owned account pool (#164 follow-up) -------------------------
  const MUSIC_ACCOUNT_GRANT_SELECT = `
    SELECT g.userId, COALESCE(u.username, g.userId) AS username, g.platform,
           g.accountId, a.label AS accountLabel, g.grantedBy, g.grantedAt
    FROM music_account_grants g
    JOIN music_accounts a ON a.id = g.accountId
    LEFT JOIN users u ON u.id = g.userId`;

  const selectMusicAccount = db.prepare(`SELECT * FROM music_accounts WHERE id = ?`);
  const selectMusicAccountsAll = db.prepare(
    `SELECT * FROM music_accounts ORDER BY platform ASC, createdAt ASC`,
  );
  const selectMusicAccountsByPlatform = db.prepare(
    `SELECT * FROM music_accounts WHERE platform = ? ORDER BY createdAt ASC`,
  );
  const insertMusicAccount = db.prepare(`
    INSERT INTO music_accounts (id, platform, label, cookie, ownerId, capacity, enabled)
    VALUES (@id, @platform, @label, @cookie, @ownerId, @capacity, @enabled)
  `);
  const updateMusicAccountStmt = db.prepare(`
    UPDATE music_accounts
    SET platform = @platform, label = @label, cookie = @cookie,
        capacity = @capacity, enabled = @enabled, updatedAt = datetime('now')
    WHERE id = @id
  `);
  const deleteMusicAccountStmt = db.prepare(`DELETE FROM music_accounts WHERE id = ?`);
  const countGrantsByAccount = db.prepare(
    `SELECT COUNT(*) AS c FROM music_account_grants WHERE accountId = ?`,
  );
  const selectGrantsByAccount = db.prepare(
    `${MUSIC_ACCOUNT_GRANT_SELECT} WHERE g.accountId = ? ORDER BY username ASC`,
  );
  const selectGrantsAll = db.prepare(
    `${MUSIC_ACCOUNT_GRANT_SELECT} ORDER BY g.platform ASC, username ASC`,
  );
  const upsertGrantStmt = db.prepare(`
    INSERT INTO music_account_grants (userId, platform, accountId, grantedBy)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(userId, platform) DO UPDATE SET
      accountId = excluded.accountId,
      grantedBy = excluded.grantedBy,
      grantedAt = datetime('now')
  `);
  const deleteGrantStmt = db.prepare(
    `DELETE FROM music_account_grants WHERE userId = ? AND platform = ?`,
  );
  // A disabled account is invisible to the resolver, so switching it off is an
  // instant, reversible rollback for everyone holding it (shared login returns).
  const selectGrantedAccount = db.prepare(`
    SELECT a.id AS accountId, a.label, a.cookie
    FROM music_account_grants g
    JOIN music_accounts a ON a.id = g.accountId
    WHERE g.userId = ? AND g.platform = ? AND a.enabled = 1
  `);

  const rowToMusicAccount = (r: Record<string, unknown>): MusicAccount => ({
    id: String(r.id),
    platform: String(r.platform),
    label: String(r.label),
    cookie: String(r.cookie),
    ownerId: r.ownerId === null || r.ownerId === undefined ? null : String(r.ownerId),
    capacity: Number(r.capacity ?? 0),
    enabled: Number(r.enabled ?? 1) === 1,
    createdAt: String(r.createdAt ?? ""),
    updatedAt: String(r.updatedAt ?? ""),
  });

  const selectGrantForUser = db.prepare(
    `SELECT accountId FROM music_account_grants WHERE userId = ? AND platform = ?`,
  );

  /** Row → object lookup shared by the read/update paths (no `this` reliance). */
  const getAccountById = (id: string): MusicAccount | null => {
    const row = selectMusicAccount.get(id) as Record<string, unknown> | undefined;
    return row ? rowToMusicAccount(row) : null;
  };

  /**
   * Capacity check + grant write in ONE transaction. Reading the holder count
   * outside the write would let two admins assigning simultaneously both pass
   * the check and overshoot an exclusive account.
   */
  const assignMusicAccountTx = db.transaction(
    (
      userId: string,
      accountId: string,
      grantedBy: string,
    ):
      | { ok: true; replacedAccountId: string | null }
      | { ok: false; reason: "not_found" | "disabled" | "exclusive" | "full" } => {
      const row = selectMusicAccount.get(accountId) as Record<string, unknown> | undefined;
      if (!row) return { ok: false, reason: "not_found" };
      const account = rowToMusicAccount(row);
      if (!account.enabled) return { ok: false, reason: "disabled" };

      const existing = selectGrantForUser.get(userId, account.platform) as
        | { accountId: string }
        | undefined;
      // Re-assigning the SAME account is a no-op, not a capacity conflict.
      if (existing?.accountId === account.id) return { ok: true, replacedAccountId: null };
      const replacedAccountId = existing ? existing.accountId : null;

      const { c } = countGrantsByAccount.get(account.id) as { c: number };
      if (account.capacity === 1 && c >= 1) return { ok: false, reason: "exclusive" };
      if (account.capacity > 1 && c >= account.capacity) return { ok: false, reason: "full" };

      upsertGrantStmt.run(userId, account.platform, account.id, grantedBy);
      return { ok: true, replacedAccountId };
    },
  );

  // A corrupt/hand-edited songs blob must never throw into a route or the
  // restore path — degrade to an empty list instead.
  const parseSongs = (raw: string): StoredSong[] => {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? (v as StoredSong[]) : [];
    } catch {
      return [];
    }
  };
  const rowToSavedMeta = (r: {
    id: number; ownerId: string; name: string; songCount: number; createdAt: string; updatedAt: string;
  }): SavedQueueMeta => ({
    id: r.id,
    ownerId: r.ownerId,
    name: r.name,
    songCount: r.songCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });

  const upsertSavedQueue = db.prepare(`
    INSERT INTO saved_queues (ownerId, name, songs, songCount)
    VALUES (@ownerId, @name, @songs, @songCount)
    ON CONFLICT(ownerId, name) DO UPDATE SET
      songs = excluded.songs,
      songCount = excluded.songCount,
      updatedAt = datetime('now')
  `);
  const selectSavedQueueByOwnerName = db.prepare(
    "SELECT * FROM saved_queues WHERE ownerId = ? AND name = ?",
  );
  const selectSavedQueueIdByOwnerName = db.prepare(
    "SELECT id FROM saved_queues WHERE ownerId = ? AND name = ?",
  );
  const countSavedQueues = db.prepare(
    "SELECT COUNT(*) AS c FROM saved_queues WHERE ownerId = ?",
  );
  const listSavedQueuesOwn = db.prepare(
    "SELECT id, ownerId, name, songCount, createdAt, updatedAt FROM saved_queues WHERE ownerId = ? ORDER BY updatedAt DESC",
  );
  const listSavedQueuesShared = db.prepare(
    "SELECT id, ownerId, name, songCount, createdAt, updatedAt FROM saved_queues WHERE ownerId = ? OR ownerId = ? ORDER BY updatedAt DESC",
  );
  const selectSavedQueueById = db.prepare("SELECT * FROM saved_queues WHERE id = ?");
  const deleteSavedQueueById = db.prepare("DELETE FROM saved_queues WHERE id = ?");

  const upsertQueueState = db.prepare(`
    INSERT INTO queue_state (botId, songs, currentIndex, mode, isFmMode, fmPlatform, updatedAt)
    VALUES (@botId, @songs, @currentIndex, @mode, @isFmMode, @fmPlatform, datetime('now'))
    ON CONFLICT(botId) DO UPDATE SET
      songs = excluded.songs,
      currentIndex = excluded.currentIndex,
      mode = excluded.mode,
      isFmMode = excluded.isFmMode,
      fmPlatform = excluded.fmPlatform,
      updatedAt = datetime('now')
  `);
  const selectQueueState = db.prepare("SELECT * FROM queue_state WHERE botId = ?");
  const deleteQueueState = db.prepare("DELETE FROM queue_state WHERE botId = ?");

  return {
    db,

    addPlayHistory(record) {
      insertHistory.run({ ...record, requestedBy: record.requestedBy ?? "" });
    },

    getPlayHistory(botId, limit) {
      return selectHistory.all(botId, limit) as PlayHistoryRecord[];
    },

    saveBotInstance(instance) {
      upsertInstance.run({
        ...instance,
        autoStart: instance.autoStart ? 1 : 0,
        identity: instance.identity ?? null,
      });
    },

    getBotInstances() {
      const rows = selectInstances.all() as Array<
        Omit<BotInstance, "autoStart" | "identity"> & { autoStart: number; identity: string | null }
      >;
      return rows.map((r) => ({
        ...r,
        autoStart: r.autoStart === 1,
        serverProtocol: r.serverProtocol ?? "",
        ts6ApiKey: r.ts6ApiKey ?? "",
        serverPassword: r.serverPassword ?? "",
        channelId: r.channelId ?? "",
        identity: r.identity ?? undefined,
      }));
    },

    deleteBotInstance(id) {
      const result = deleteInstance.run(id);
      return result.changes > 0;
    },

    getProfileConfig(botId) {
      const row = selectProfileConfig.get(botId) as Record<string, number> | undefined;
      if (!row) return { ...DEFAULT_PROFILE_CONFIG };
      return {
        avatarEnabled: row.profile_avatar_enabled === 1,
        descriptionEnabled: row.profile_description_enabled === 1,
        nicknameEnabled: row.profile_nickname_enabled === 1,
        awayStatusEnabled: row.profile_away_enabled === 1,
        channelDescEnabled: row.profile_channel_desc_enabled === 1,
        nowPlayingMsgEnabled: row.profile_now_playing_enabled === 1,
      };
    },

    saveProfileConfig(botId, config) {
      updateProfileConfig.run({
        id: botId,
        avatar: config.avatarEnabled ? 1 : 0,
        description: config.descriptionEnabled ? 1 : 0,
        nickname: config.nicknameEnabled ? 1 : 0,
        away: config.awayStatusEnabled ? 1 : 0,
        channelDesc: config.channelDescEnabled ? 1 : 0,
        nowPlaying: config.nowPlayingMsgEnabled ? 1 : 0,
      });
    },

    getPlayerSettings(botId) {
      const row = selectPlayerSettings.get(botId) as
        | { volume: number | null; play_mode: string | null }
        | undefined;
      if (!row) return { ...DEFAULT_PLAYER_SETTINGS };
      // Coerce/validate: clamp volume to 0-100 and fall back to defaults for any
      // NULL / out-of-range / unknown value (a hand-edited DB must never feed a
      // bad value into AudioPlayer.setVolume / PlayQueue.setMode).
      const rawVol = typeof row.volume === "number" ? row.volume : DEFAULT_PLAYER_SETTINGS.volume;
      const volume = Number.isFinite(rawVol)
        ? Math.max(0, Math.min(100, Math.round(rawVol)))
        : DEFAULT_PLAYER_SETTINGS.volume;
      const playMode =
        typeof row.play_mode === "string" && PLAY_MODES.has(row.play_mode)
          ? row.play_mode
          : DEFAULT_PLAYER_SETTINGS.playMode;
      return { volume, playMode };
    },

    saveVolume(botId, volume) {
      const clamped = Math.max(0, Math.min(100, Math.round(volume)));
      updateVolume.run(clamped, botId);
    },

    savePlayMode(botId, playMode) {
      // Persist only recognized modes so a bad value can never poison the row.
      if (!PLAY_MODES.has(playMode)) return;
      updatePlayMode.run(playMode, botId);
    },

    getCustomAvatarPath(botId) {
      const row = selectCustomAvatar.get(botId) as { custom_avatar_path: string | null } | undefined;
      return row?.custom_avatar_path ?? null;
    },
    setCustomAvatarPath(botId, path) {
      updateCustomAvatar.run(path, botId);
    },

    addFavorite(userId, playlist) {
      insertFavorite.run({ userId, ...playlist });
    },

    removeFavorite(userId, playlistId, platform) {
      const result = deleteFavorite.run(userId, playlistId, platform);
      return result.changes > 0;
    },

    getFavorites(userId) {
      return selectFavorites.all(userId) as FavoritePlaylist[];
    },

    isFavorited(userId, playlistId, platform) {
      const row = checkFavorited.get(userId, playlistId, platform);
      return row !== undefined;
    },

    getUserMusicCookie(userId, platform) {
      const row = selectUserMusicCookie.get(userId, platform) as { cookie: string } | undefined;
      return row?.cookie ?? null;
    },

    setUserMusicCookie(userId, platform, cookie) {
      upsertUserMusicCookie.run(userId, platform, cookie);
    },

    deleteUserMusicCookie(userId, platform) {
      return deleteUserMusicCookieStmt.run(userId, platform).changes > 0;
    },

    getUserMusicPreference(userId, platform) {
      const row = selectUserMusicPref.get(userId, platform) as
        | { preferShared: number }
        | undefined;
      if (!row) return null;
      return { preferShared: Number(row.preferShared) === 1 };
    },

    setUserMusicPreference(userId, platform, preferShared) {
      upsertUserMusicPref.run(userId, platform, preferShared ? 1 : 0);
    },

    listMusicAccounts(platform) {
      const rows = platform
        ? (selectMusicAccountsByPlatform.all(platform) as Record<string, unknown>[])
        : (selectMusicAccountsAll.all() as Record<string, unknown>[]);
      return rows.map(rowToMusicAccount);
    },

    getMusicAccount(id) {
      return getAccountById(id);
    },

    createMusicAccount(input) {
      const id = randomUUID();
      insertMusicAccount.run({
        id,
        platform: input.platform,
        label: input.label,
        cookie: input.cookie,
        ownerId: input.ownerId ?? null,
        // Clamped so a negative capacity can never slip through and make the
        // "exclusive" check behave like "unlimited".
        capacity: Math.max(0, Math.trunc(input.capacity ?? 0)),
        enabled: input.enabled === false ? 0 : 1,
      });
      // No `this` hop: the factory's returned object can be destructured without
      // losing the lookup.
      return getAccountById(id)!;
    },

    updateMusicAccount(id, patch) {
      const current = getAccountById(id);
      if (!current) return false;
      updateMusicAccountStmt.run({
        id,
        // Platform is immutable (see the interface doc): existing grants are
        // keyed by the OLD platform and would be orphaned by a move.
        platform: current.platform,
        label: patch.label ?? current.label,
        cookie: patch.cookie ?? current.cookie,
        capacity:
          patch.capacity === undefined
            ? current.capacity
            : Math.max(0, Math.trunc(patch.capacity)),
        enabled: (patch.enabled ?? current.enabled) ? 1 : 0,
      });
      return true;
    },

    deleteMusicAccount(id) {
      return deleteMusicAccountStmt.run(id).changes > 0;
    },

    countMusicAccountGrants(accountId) {
      const row = countGrantsByAccount.get(accountId) as { c: number } | undefined;
      return row?.c ?? 0;
    },

    listMusicAccountGrants(accountId) {
      return selectGrantsByAccount.all(accountId) as MusicAccountGrant[];
    },

    listAllMusicAccountGrants() {
      return selectGrantsAll.all() as MusicAccountGrant[];
    },

    assignMusicAccount(userId, accountId, grantedBy) {
      return assignMusicAccountTx(userId, accountId, grantedBy);
    },

    deleteMusicAccountGrant(userId, platform) {
      return deleteGrantStmt.run(userId, platform).changes > 0;
    },

    getGrantedMusicAccount(userId, platform) {
      const row = selectGrantedAccount.get(userId, platform) as
        | { accountId: string; label: string; cookie: string }
        | undefined;
      if (!row || !row.cookie.trim()) return null;
      return { accountId: row.accountId, label: row.label, cookie: row.cookie };
    },

    saveQueue(ownerId, name, songs) {
      if (songs.length > MAX_QUEUE_SONGS) {
        throw new Error(`保存失败：歌曲数量超过上限 ${MAX_QUEUE_SONGS}`);
      }
      // Strip any lazily-resolved url before persisting.
      const stripped: StoredSong[] = songs.map((s) => {
        const { url: _url, ...rest } = s as QueuedSong;
        return rest;
      });
      // Enforce the per-owner cap only for a NEW name (an overwrite of an
      // existing saved queue must always be allowed).
      const existing = selectSavedQueueIdByOwnerName.get(ownerId, name) as
        | { id: number }
        | undefined;
      if (!existing) {
        const { c } = countSavedQueues.get(ownerId) as { c: number };
        if (c >= MAX_SAVED_QUEUES) {
          throw new Error(`保存失败：已保存队列数量超过上限 ${MAX_SAVED_QUEUES}`);
        }
      }
      upsertSavedQueue.run({
        ownerId,
        name,
        songs: JSON.stringify(stripped),
        songCount: stripped.length,
      });
      const row = selectSavedQueueByOwnerName.get(ownerId, name) as SavedQueueMeta;
      return { ...rowToSavedMeta(row), songs: stripped };
    },

    listSavedQueues(ownerId, includeShared) {
      const rows = includeShared
        ? (listSavedQueuesShared.all(ownerId, SHARED_QUEUE_OWNER) as SavedQueueMeta[])
        : (listSavedQueuesOwn.all(ownerId) as SavedQueueMeta[]);
      return rows.map(rowToSavedMeta);
    },

    getSavedQueue(id) {
      const row = selectSavedQueueById.get(id) as
        | (SavedQueueMeta & { songs: string })
        | undefined;
      if (!row) return null;
      return { ...rowToSavedMeta(row), songs: parseSongs(row.songs) };
    },

    deleteSavedQueue(id) {
      return deleteSavedQueueById.run(id).changes > 0;
    },

    saveQueueState(state) {
      upsertQueueState.run({
        botId: state.botId,
        songs: JSON.stringify(state.songs),
        currentIndex: state.currentIndex,
        mode: state.mode,
        isFmMode: state.isFmMode ? 1 : 0,
        fmPlatform: state.fmPlatform,
      });
    },

    getQueueState(botId) {
      const r = selectQueueState.get(botId) as
        | { botId: string; songs: string; currentIndex: number; mode: string; isFmMode: number; fmPlatform: string }
        | undefined;
      if (!r) return null;
      return {
        botId: r.botId,
        songs: parseSongs(r.songs),
        currentIndex: r.currentIndex,
        mode: r.mode,
        isFmMode: r.isFmMode === 1,
        fmPlatform: r.fmPlatform,
      };
    },

    clearQueueState(botId) {
      deleteQueueState.run(botId);
    },

    close() {
      db.close();
    },
  };
}
