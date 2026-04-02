import Database from "better-sqlite3";

export interface PlayHistoryEntry {
  botId: string;
  songId: string;
  songName: string;
  artist: string;
  album: string;
  platform: "netease" | "qq" | "bilibili";
  coverUrl: string;
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
  channelPassword: string;
  serverPassword: string;
  autoStart: boolean;
}

export interface BotDatabase {
  db: Database.Database;
  addPlayHistory(entry: PlayHistoryEntry): void;
  getPlayHistory(botId: string, limit: number): PlayHistoryRecord[];
  saveBotInstance(instance: BotInstance): void;
  getBotInstances(): BotInstance[];
  deleteBotInstance(id: string): boolean;
  close(): void;
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
      playedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bot_instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      serverAddress TEXT NOT NULL,
      serverPort INTEGER NOT NULL,
      nickname TEXT NOT NULL,
      defaultChannel TEXT NOT NULL,
      channelPassword TEXT NOT NULL,
      serverPassword TEXT NOT NULL DEFAULT '',
      autoStart INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Migration: add serverPassword column for existing databases
  const columns = db.pragma("table_info(bot_instances)") as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "serverPassword")) {
    db.exec(`ALTER TABLE bot_instances ADD COLUMN serverPassword TEXT NOT NULL DEFAULT ''`);
  }
}

export function createDatabase(dbPath: string): BotDatabase {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  initTables(db);

  const insertHistory = db.prepare(`
    INSERT INTO play_history (botId, songId, songName, artist, album, platform, coverUrl)
    VALUES (@botId, @songId, @songName, @artist, @album, @platform, @coverUrl)
  `);

  const selectHistory = db.prepare(`
    SELECT * FROM play_history WHERE botId = ? ORDER BY id DESC LIMIT ?
  `);

  const upsertInstance = db.prepare(`
    INSERT INTO bot_instances (id, name, serverAddress, serverPort, nickname, defaultChannel, channelPassword, serverPassword, autoStart)
    VALUES (@id, @name, @serverAddress, @serverPort, @nickname, @defaultChannel, @channelPassword, @serverPassword, @autoStart)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      serverAddress = excluded.serverAddress,
      serverPort = excluded.serverPort,
      nickname = excluded.nickname,
      defaultChannel = excluded.defaultChannel,
      channelPassword = excluded.channelPassword,
      serverPassword = excluded.serverPassword,
      autoStart = excluded.autoStart
  `);

  const selectInstances = db.prepare(`SELECT * FROM bot_instances`);

  const deleteInstance = db.prepare(`DELETE FROM bot_instances WHERE id = ?`);

  return {
    db,

    addPlayHistory(record) {
      insertHistory.run(record);
    },

    getPlayHistory(botId, limit) {
      return selectHistory.all(botId, limit) as PlayHistoryRecord[];
    },

    saveBotInstance(instance) {
      upsertInstance.run({
        ...instance,
        autoStart: instance.autoStart ? 1 : 0,
      });
    },

    getBotInstances() {
      const rows = selectInstances.all() as Array<
        Omit<BotInstance, "autoStart"> & { autoStart: number }
      >;
      return rows.map((r) => ({ ...r, autoStart: r.autoStart === 1 }));
    },

    deleteBotInstance(id) {
      const result = deleteInstance.run(id);
      return result.changes > 0;
    },

    close() {
      db.close();
    },
  };
}
