import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import axios from "axios";
import { interpolateElapsed, usePlayerStore, type Song, type TimingState } from "./player.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function timing(partial: Partial<TimingState>): TimingState {
  return { serverElapsed: 0, serverSyncTime: 0, wasPlaying: false, ...partial };
}

describe("interpolateElapsed", () => {
  it("returns serverElapsed before playback has a sync anchor", () => {
    expect(interpolateElapsed(timing({ serverElapsed: 12, wasPlaying: false }), false, Infinity)).toBe(12);
    // wasPlaying but no sync time yet
    expect(interpolateElapsed(timing({ serverElapsed: 5, wasPlaying: true, serverSyncTime: 0 }), false, Infinity)).toBe(5);
  });

  it("advances with wall-clock time while playing (regression: must not be frozen)", () => {
    const spy = vi.spyOn(Date, "now");
    const t = timing({ serverElapsed: 30, serverSyncTime: 10_000, wasPlaying: true });

    spy.mockReturnValue(10_000);
    expect(interpolateElapsed(t, false, Infinity)).toBeCloseTo(30, 5);

    spy.mockReturnValue(11_000); // +1s
    expect(interpolateElapsed(t, false, Infinity)).toBeCloseTo(31, 5);

    spy.mockReturnValue(13_500); // +3.5s — distinct from the 1s reading
    expect(interpolateElapsed(t, false, Infinity)).toBeCloseTo(33.5, 5);
  });

  it("freezes at serverElapsed while paused", () => {
    vi.spyOn(Date, "now").mockReturnValue(99_000);
    const t = timing({ serverElapsed: 42, serverSyncTime: 10_000, wasPlaying: true });
    expect(interpolateElapsed(t, true, Infinity)).toBe(42);
  });

  it("clamps to maxDuration", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const t = timing({ serverElapsed: 100, serverSyncTime: 1_000, wasPlaying: true });
    expect(interpolateElapsed(t, false, 180)).toBe(180);
  });
});

const track: Song = { id: "song", name: "song", artist: "", album: "", coverUrl: "", duration: 180, platform: "netease" };

describe("playback request timing", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.useFakeTimers();
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["playSong", "playPlaylist", "playAlbum", "playArtist", "next", "playAtIndex", "startFm"] as const)(
    "keeps the current clock when %s fails",
    async (action) => {
      const store = usePlayerStore();
      store.activeBotId = "a";
      const current = timing({ serverElapsed: 63, serverSyncTime: 10_000, wasPlaying: true });
      store.timings.a = current;
      vi.spyOn(axios, "post").mockResolvedValue({ data: { ok: false, message: "播放失败" } });

      if (action === "playSong") await store.playSong(track);
      else if (action === "startFm") await store.startFm();
      else if (action === "next") await store.next();
      else if (action === "playAtIndex") await store.playAtIndex(1);
      else await store[action]("collection");

      expect(store.timings.a).toEqual(current);
      expect(store.notification?.type).toBe("error");
    },
  );

  it("keeps an in-flight elapsed response attached to its original bot", async () => {
    const store = usePlayerStore();
    const status = {
      name: "bot", connected: true, playing: true, paused: false, currentSong: track,
      queueSize: 1, volume: 50, playMode: "sequential",
    };
    store.bots = [{ ...status, id: "a" }, { ...status, id: "b" }];
    store.activeBotId = "a";
    store.timings.b = timing({ serverElapsed: 10 });
    let sendElapsed!: (response: { data: { elapsed: number } }) => void;
    const response = new Promise<{ data: { elapsed: number } }>(resolve => { sendElapsed = resolve; });
    vi.spyOn(axios, "get").mockReturnValue(response);

    const syncing = store.syncElapsed();
    store.activeBotId = "b";
    sendElapsed({ data: { elapsed: 58 } });
    await syncing;

    expect(store.timings.a?.serverElapsed).toBe(58);
    expect(store.timings.b?.serverElapsed).toBe(10);
  });

  it("freezes steady elapsed samples and interpolates again when audio advances", async () => {
    const store = usePlayerStore();
    store.activeBotId = "a";
    store.bots = [{
      id: "a", name: "bot", connected: true, playing: true, paused: false, currentSong: track,
      queueSize: 1, volume: 50, playMode: "sequential",
    }];
    const poll = vi.spyOn(axios, "get").mockResolvedValue({ data: { elapsed: 60 } });
    vi.setSystemTime(10000);
    await store.syncElapsed();
    vi.setSystemTime(13000);
    await store.syncElapsed();
    vi.setSystemTime(14000);
    expect(store.liveElapsed()).toBe(60);

    poll.mockResolvedValue({ data: { elapsed: 61 } });
    await store.syncElapsed();
    vi.setSystemTime(15000);
    expect(store.liveElapsed()).toBe(62);
  });
});
