import { describe, expect, it, vi } from "vitest";
import { collectArtistSongs } from "./player.js";
import type { ArtistSongPage, Song } from "../../music/provider.js";
import express from "express";
import request from "supertest";
import { createPlayerRouter } from "./player.js";
import { BotInstance } from "../../bot/instance.js";
import { PlayQueue } from "../../audio/queue.js";
import type { BotDatabase } from "../../data/database.js";

function song(id: string): Song {
  return {
    id,
    name: `song-${id}`,
    artist: "Adele",
    album: "25",
    duration: 200,
    coverUrl: "c",
    platform: "netease",
  };
}

function page(ids: string[], total: number, hasMore: boolean): ArtistSongPage {
  return { songs: ids.map(song), total, hasMore };
}

describe("collectArtistSongs (play-artist all:true)", () => {
  it("walks every page until hasMore is false and de-duplicates ids", async () => {
    const pages: Record<number, ArtistSongPage> = {
      0: page(["1", "2"], 4, true),
      100: page(["2", "3"], 4, true),
      200: page(["4"], 4, false),
    };
    const fetchPage = vi.fn(async (_id: string, offset = 0, _limit = 100) => pages[offset] ?? page([], 4, false));

    const songs = await collectArtistSongs(fetchPage as any, "artist-1");

    expect(songs.map((s) => s.id)).toEqual(["1", "2", "3", "4"]);
    expect(fetchPage.mock.calls.map((c) => c[1])).toEqual([0, 100, 200]);
    expect(fetchPage.mock.calls[0][2]).toBe(100);
  });

  it("stops at the 500-track safety cap", async () => {
    let n = 0;
    const fetchPage = vi.fn(async () => ({
      songs: Array.from({ length: 100 }, () => song(String(n++))),
      total: 100000,
      hasMore: true,
    }));

    const songs = await collectArtistSongs(fetchPage as any, "a");

    expect(songs).toHaveLength(500);
    expect(fetchPage).toHaveBeenCalledTimes(5);
  });

  it("enforces the song cap even when an upstream page exceeds the requested limit", async () => {
    const fetchPage = vi.fn(async () => page(Array.from({ length: 600 }, (_, i) => String(i)), 600, false));
    expect(await collectArtistSongs(fetchPage, "a")).toHaveLength(500);
  });

  it("stops on an empty page even when hasMore claims otherwise", async () => {
    const fetchPage = vi.fn(async () => page([], 9, true));

    expect(await collectArtistSongs(fetchPage as any, "a")).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("returns the first page unchanged when it is already complete", async () => {
    const fetchPage = vi.fn(async () => page(["1"], 1, false));

    const songs = await collectArtistSongs(fetchPage as any, "a");

    expect(songs.map((s) => s.id)).toEqual(["1"]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

describe("collection playback serialization", () => {
  it.each(["artist", "album", "playlist"])("serializes %s playback and single-song playback", async kind => {
    const queue = new PlayQueue();
    let audible: string | null = null;
    let releaseArtist!: () => void;
    let notifyArtistStarted!: () => void;
    let notifySingleArrived!: () => void;
    const artistStarted = new Promise<void>((resolve) => { notifyArtistStarted = resolve; });
    const artistHold = new Promise<void>((resolve) => { releaseArtist = resolve; });
    const singleArrived = new Promise<void>((resolve) => { notifySingleArrived = resolve; });
    const bot: any = {
      playGate: Promise.resolve(),
      getProviderFor: () => ({
        platform: "netease",
        getAlbumSongs: async () => [song("A")],
        getPlaylistSongs: async () => [song("A")],
        getArtistSongs: async () => [song("A")],
        getArtistAllSongs: async () => page(["A"], 1, false),
      }),
      emit: vi.fn(),
      getPlayer: () => ({ stop: () => { audible = null; }, resetFailures: () => {} }),
      getQueueManager: () => queue,
      resolveAndPlay: async (track: Song) => {
        notifyArtistStarted();
        await artistHold;
        audible = track.id;
        return true;
      },
      playSingleSong: async (track: Song) => {
        queue.clear();
        queue.add(track);
        queue.play();
        audible = track.id;
        return true;
      },
    };
    bot.runExclusive = (fn: () => Promise<unknown>) => BotInstance.prototype.runExclusive.call(bot, fn);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).user = { role: "admin" }; next(); });
    app.use("/api/player/b/play-song", (_req, _res, next) => { notifySingleArrived(); next(); });
    app.use("/api/player", createPlayerRouter({ getBot: () => bot } as any, { error: vi.fn() } as any));
    const collectionRequest = request(app).post(`/api/player/b/play-${kind}`)
      .send({ [`${kind}Id`]: "collection", platform: "netease" }).then((res) => res);
    await artistStarted;
    const singleRequest = request(app).post("/api/player/b/play-song").send({ song: song("B") }).then((res) => res);
    // Let the overlapping HTTP request enter the real route while A's URL is pending.
    await singleArrived;
    await Promise.resolve();
    await Promise.resolve();
    const whileArtistPending = queue.current()?.id;
    releaseArtist();
    const [collectionResponse, singleResponse] = await Promise.all([collectionRequest, singleRequest]);
    expect(collectionResponse.status).toBe(200);
    expect(singleResponse.status).toBe(200);
    expect(whileArtistPending).toBe("A");
    expect(queue.current()?.id).toBe("B");
    expect(audible).toBe("B");
  });
});

describe("collection preflight", () => {
  it.each(["playlist", "album", "artist"])("checks QQ %s availability using the room's playback account", async kind => {
    const queue = new PlayQueue();
    const personalTracks = [{ ...song("personal-library-track"), platform: "qq" }];
    const readLibrary = vi.fn(async () => personalTracks);
    const personal = {
      platform: "qq",
      getPlaylistSongs: readLibrary,
      getAlbumSongs: readLibrary,
      getArtistSongs: readLibrary,
      getPlayableSongIds: vi.fn(async () => new Set<string>()),
    };
    const shared = {
      platform: "qq",
      withCookie: vi.fn(() => personal),
      getPlayableSongIds: vi.fn(async () => new Set(["personal-library-track"])),
    };
    const bot = {
      getProviderFor: () => shared,
      getQueueManager: () => queue,
      getPlayer: () => ({ stop: vi.fn(), resetFailures: vi.fn() }),
      runExclusive: (work: () => Promise<unknown>) => work(),
      resolveAndPlay: vi.fn(async () => true),
      emit: vi.fn(),
    };
    const db = {
      getUserMusicPreference: () => null,
      getUserMusicCookie: () => null,
      getGrantedMusicAccount: () => ({ cookie: "private-test-cookie", label: "Member's account", accountId: "account" }),
    } as unknown as BotDatabase;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { user?: unknown }).user = { id: "member", role: "member", bots: new Set(["b"]), capabilities: new Set(["player.control"]) };
      next();
    });
    app.use("/api/player", createPlayerRouter({ getBot: () => bot } as any, { error: vi.fn() } as any,
      db, undefined, undefined, undefined, { perUserMusicAccounts: true }));

    const response = await request(app).post(`/api/player/b/play-${kind}`)
      .send({ [`${kind}Id`]: "id", platform: "qq" }).expect(200);

    expect(response.body).toMatchObject({ ok: true });
    expect(response.text).not.toContain("private-test-cookie");
    expect(readLibrary).toHaveBeenCalledOnce();
    expect(personal.getPlayableSongIds).not.toHaveBeenCalled();
    expect(shared.getPlayableSongIds).toHaveBeenCalledWith(["personal-library-track"]);
    expect(queue.current()?.id).toBe("personal-library-track");
  });

  it.each([
    ["playlist", "empty", 200],
    ["playlist", "unavailable", 200],
    ["album", "empty", 200],
    ["album", "error", 500],
  ])("preserves current playback if the %s is %s", async (kind, result, status) => {
    const queue = new PlayQueue();
    queue.add(song("playing"));
    queue.play();
    const player = { stop: vi.fn(), resetFailures: vi.fn() };
    const loadSongs = async () => {
      if (result === "error") throw new Error("Upstream failed");
      return result === "empty" ? [] : [song("next")];
    };
    const bot = {
      getProviderFor: () => ({
        platform: "qq",
        getPlaylistSongs: loadSongs,
        getAlbumSongs: loadSongs,
        getPlayableSongIds: async () => new Set<string>(),
      }),
      getQueueManager: () => queue,
      getPlayer: () => player,
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).user = { role: "admin" }; next(); });
    app.use("/api/player", createPlayerRouter({ getBot: () => bot } as any, { error: vi.fn() } as any));

    const response = await request(app).post(`/api/player/b/play-${kind}`).send({ [`${kind}Id`]: "id", platform: "qq" });

    expect(response.status).toBe(status);
    if (status === 200) expect(response.body).toMatchObject({ ok: false });
    expect(player.stop).not.toHaveBeenCalled();
    expect(player.resetFailures).not.toHaveBeenCalled();
    expect(queue.current()?.id).toBe("playing");
  });
});

describe("play a queue position", () => {
  function fixture() {
    const queue = new PlayQueue();
    queue.add(song("playing"));
    queue.add(song("unavailable"));
    queue.play();
    const player = { stop: vi.fn(), resetFailures: vi.fn(), getPlaybackSessionId: () => 1 };
    const bot = {
      getQueueManager: () => queue,
      getPlayer: () => player,
      runExclusive: (work: () => Promise<unknown>) => work(),
      resolveAndPlay: vi.fn(async (_song: Song, onFailure?: (failure: { message: string }) => void) => {
        onFailure?.({ message: "Source returned no stream" });
        return false;
      }),
      emit: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).user = { role: "admin" }; next(); });
    app.use("/api/player", createPlayerRouter({ getBot: () => bot } as any, { error: vi.fn() } as any));
    return { app, bot, player, queue };
  }

  it("rejects fractional positions without stopping the playing track", async () => {
    const { app, player, queue } = fixture();
    expect((await request(app).post("/api/player/b/play-at").send({ index: 0.5 })).status).toBe(400);
    expect(player.stop).not.toHaveBeenCalled();
    expect(queue.current()?.id).toBe("playing");
  });

  it("returns the URL failure and publishes the selected stopped track", async () => {
    const { app, bot, queue } = fixture();
    const response = await request(app).post("/api/player/b/play-at").send({ index: 1 });
    expect(response.body).toEqual({ ok: false, message: expect.stringContaining("Source returned no stream") });
    expect(bot.emit).toHaveBeenCalledWith("stateChange");
    expect(queue.current()?.id).toBe("unavailable");
  });
});

it("reports a failed restart while the existing track is still playing", async () => {
  const bot = {
    runExclusive: (work: () => Promise<unknown>) => work(),
    async playSingleSong(_song: Song, _requester: string, failure: (error: { message: string }, continues: boolean) => void) {
      failure({ message: "No URL" }, true);
      return false;
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { role: "admin" }; next(); });
  app.use("/api/player", createPlayerRouter({ getBot: () => bot } as any, { error: vi.fn() } as any));

  const response = await request(app).post("/api/player/b/play-song").send({ song: song("playing") });
  expect(response.body).toEqual({ ok: false, message: expect.stringContaining("当前曲目继续播放") });
});

it("tries the newly appended track when idle and reports a failed URL lookup", async () => {
  const queue = new PlayQueue();
  queue.add(song("already-queued"));
  const bot = {
    getQueueManager: () => queue,
    getPlayer: () => ({ getState: () => "idle", resetFailures: vi.fn() }),
    runExclusive: (work: () => Promise<unknown>) => work(),
    resolveAndPlay: vi.fn(async (_track: Song, onFailure?: (failure: { message: string }) => void) => {
      onFailure?.({ message: "No URL" });
      return false;
    }),
    emit: vi.fn(),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { role: "admin" }; next(); });
  app.use("/api/player", createPlayerRouter({ getBot: () => bot } as any, { error: vi.fn() } as any));

  const response = await request(app).post("/api/player/b/add-song").send({ song: song("newly-added") });
  expect(bot.resolveAndPlay.mock.calls.map(([track]) => track.id)).toEqual(["newly-added"]);
  expect(queue.list().map(track => track.id)).toEqual(["already-queued", "newly-added"]);
  expect(response.body).toEqual({ ok: false, message: expect.stringContaining("No URL") });
});
