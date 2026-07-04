import Database from "better-sqlite3";
import { CAPABILITIES, BOTS_ALL } from "./permissions.js";
import { GUEST_USER_ID, GUEST_USERNAME } from "./users.js";

export interface PlayHistoryEntry {
  botId: string;
  songId: string;
  songName: string;
  artist: string;
  album: string;
  platform: "netease" | "qq" | "bilibili" | "youtube" | "local" | "kugou" | "spotify";
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

export interface BotDatabase {
  db: Database.Database;
  addPlayHistory(entry: PlayHistoryEntry): void;
  getPlayHistory(botId: string, limit: number): PlayHistoryRecord[];
  saveBotInstance(instance: BotInstance): void;
  getBotInstances(): BotInstance[];
  deleteBotInstance(id: string): boolean;
  getProfileConfig(botId: string): ProfileConfig;
  saveProfileConfig(botId: string, config: ProfileConfig): void;
  getCustomAvatarPath(botId: string): string | null;
  setCustomAvatarPath(botId: string, path: string | null): void;
  addFavorite(userId: string, playlist: { platform: string; playlistId: string; name: string; coverUrl: string; songCount: number }): void;
  removeFavorite(userId: string, playlistId: string, platform: string): boolean;
  getFavorites(userId: string): FavoritePlaylist[];
  isFavorited(userId: string, playlistId: string, platform: string): boolean;
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

  const userColumns = db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  const userColNames = userColumns.map((c) => c.name);
  if (!userColNames.includes("role")) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
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

    close() {
      db.close();
    },
  };
}
