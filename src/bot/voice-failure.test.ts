import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import pino from "pino";
import { BotInstance } from "./instance.js";
import { AudioPlayer } from "../audio/player.js";
import { PlayQueue } from "../audio/queue.js";
import { PCM_FRAME_BYTES } from "../audio/encoder.js";
import { TS3Client } from "../ts-protocol/client.js";

function makeHarness(platform: "bilibili" | "spotify" = "bilibili") {
  const logger = pino({ level: "silent" });
  const player = new AudioPlayer(logger);
  const queue = new PlayQueue();
  queue.add({ id: "offline-fixture", name: "67-minute fixture", artist: "fixture", album: "", coverUrl: "", platform, duration: 4020 });
  queue.play();
  Object.assign(player, { state: "playing", framesPlayed: 111000 });
  const tsClient = new TS3Client({ host: "localhost", port: 9987, queryPort: 10011, nickname: "OfflineFixture" }, logger);
  let sidecarPauses = 0;
  const bot = Object.assign(new EventEmitter(), {
    logger, player, queue, tsClient, connected: true, autoPaused: true,
    streamRecovery: null, lifecycleGeneration: 0,
    spotifyController: Object.assign(new EventEmitter(), { pause: async () => { sidecarPauses++; } }),
  });
  const methods = BotInstance.prototype as unknown as {
    setupTsEvents(this: typeof bot): void;
    cmdPause(this: typeof bot): string;
  };
  Object.assign(bot, { cmdPause: methods.cmdPause });
  methods.setupTsEvents.call(bot);
  return { bot, player, queue, tsClient, sidecarPauses: () => sidecarPauses };
}

afterEach(() => { vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("BotInstance persistent voice send failure", () => {
  it.each(["bilibili", "spotify"] as const)("pauses %s while retaining the song and playback position", platform => {
    const h = makeHarness(platform);
    const song = h.queue.current();
    let changes = 0;
    h.bot.on("stateChange", () => changes++);
    try {
      h.tsClient.emit("voiceSendFailed", { code: "ERR_SOCKET_DGRAM_NOT_RUNNING", consecutiveFailures: 100, durationMs: 2000 });
      expect(h.player.getState()).toBe("paused");
      expect(h.player.getElapsed()).toBe(2220);
      expect(h.queue.current()).toBe(song);
      expect(h.queue.size()).toBe(1);
      expect(h.bot.autoPaused).toBe(false);
      expect(changes).toBe(1);
      expect(h.sidecarPauses()).toBe(platform === "spotify" ? 1 : 0);
      h.tsClient.emit("voiceSendFailed", { consecutiveFailures: 200, durationMs: 4000 });
      expect(changes).toBe(1);
    } finally { h.player.stop(); }
  });

  it("stops the actual audio scheduler from advancing elapsed after terminal transmission failure", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const h = makeHarness();
    const internal = h.player as unknown as { startFrameLoop(): void };
    let frames = 0;
    h.player.on("frame", () => frames++);
    Object.assign(h.player, { framesPlayed: 0, ffmpeg: { pid: undefined }, pcmBuffer: Buffer.alloc(PCM_FRAME_BYTES * 250), currentSongDuration: 4020 });
    try {
      internal.startFrameLoop();
      vi.advanceTimersByTime(1000);
      expect(frames).toBe(50);
      h.tsClient.emit("voiceSendFailed", { consecutiveFailures: 100, durationMs: 2000 });
      vi.advanceTimersByTime(3000);
      // Pausing emits a short de-click fade tail (pauseFrames) so the last
      // audible frames ramp down instead of cutting off (a0f0b49). What this
      // test guards is what happens AFTER that: the scheduler must go quiet
      // and elapsed must stop advancing.
      expect(h.player.getState()).toBe("paused");
      const framesAfterFade = frames;
      const elapsedAfterFade = h.player.getElapsed();
      expect(framesAfterFade).toBeLessThan(50 + 20);
      vi.advanceTimersByTime(3000);
      expect(frames).toBe(framesAfterFade);
      expect(h.player.getElapsed()).toBe(elapsedAfterFade);
    } finally { h.player.stop(); }
  });

  it("lets transient failure recover without pausing and does not auto-resume a user pause", () => {
    const h = makeHarness();
    try {
      h.tsClient.emit("voiceSendFailure", { consecutiveFailures: 1, durationMs: 0 });
      h.tsClient.emit("voiceSendRecovered", { consecutiveFailures: 1, durationMs: 20 });
      expect(h.player.getState()).toBe("playing");
      h.player.pause();
      h.tsClient.emit("voiceSendRecovered", { consecutiveFailures: 1, durationMs: 20 });
      expect(h.player.getState()).toBe("paused");
    } finally { h.player.stop(); }
  });

  it("preserves pause intent when terminal failure occurs during a pending fresh URL lookup", async () => {
    const h = makeHarness();
    Object.assign(h.player, { state: "idle" });
    let resolve!: (result: { url: string }) => void;
    const lookup = new Promise<{ url: string }>(done => { resolve = done; });
    Object.assign(h.bot, { getProviderFor: () => ({ getSongUrl: () => lookup }) });
    // Isolate only process creation; the actual stop, seek, state, session,
    // recovery method and pause method remain in use.
    vi.spyOn(h.player, "play").mockImplementation((_url, seek, duration) => {
      h.player.stop();
      Object.assign(h.player, { state: "playing", seekOffset: seek, currentSongDuration: duration });
    });
    const resume = (BotInstance.prototype as unknown as { resumeInterruptedStream(this: typeof h.bot): Promise<boolean> }).resumeInterruptedStream;
    const recovery = resume.call(h.bot);
    try {
      h.tsClient.emit("voiceSendFailed", { code: "EPIPE", consecutiveFailures: 100, durationMs: 2000 });
      resolve({ url: "https://offline.invalid/fresh.m4s" });
      expect(await recovery).toBe(true);
      expect(h.player.getState()).toBe("paused");
      expect(h.player.getElapsed()).toBe(2220);
      expect(h.queue.current()?.id).toBe("offline-fixture");
    } finally { h.player.stop(); }
  });

  it("pauses again if manual resume encounters the same persistent voice fault", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    const h = makeHarness();
    let accepted = 0;
    Object.assign(h.tsClient, { client: { sendVoice() {
      if (accepted++ > 0) throw Object.assign(new Error("offline fixture"), { code: "EPIPE" });
    } } });
    const setupPlayerEvents = (BotInstance.prototype as unknown as { setupPlayerEvents(this: typeof h.bot): void }).setupPlayerEvents;
    setupPlayerEvents.call(h.bot);
    Object.assign(h.player, { framesPlayed: 0, ffmpeg: { pid: undefined }, pcmBuffer: Buffer.alloc(PCM_FRAME_BYTES * 250), currentSongDuration: 4020 });
    try {
      (h.player as unknown as { startFrameLoop(): void }).startFrameLoop();
      vi.advanceTimersByTime(2100);
      expect(h.player.getState()).toBe("paused");
      const pausedAt = h.player.getElapsed();
      h.player.resume();
      vi.advanceTimersByTime(40);
      expect(h.player.getState()).toBe("paused");
      expect(h.player.getElapsed()).toBeLessThanOrEqual(pausedAt + 0.02);
      expect(h.queue.current()?.id).toBe("offline-fixture");
    } finally { h.player.stop(); }
  });

  it("ignores terminal notifications when disconnected or already idle", () => {
    const h = makeHarness();
    try {
      h.bot.connected = false;
      h.tsClient.emit("voiceSendFailed", { consecutiveFailures: 100, durationMs: 2000 });
      expect(h.player.getState()).toBe("playing");
      h.bot.connected = true;
      h.player.stop();
      h.tsClient.emit("voiceSendFailed", { consecutiveFailures: 100, durationMs: 2000 });
      expect(h.player.getState()).toBe("idle");
    } finally { h.player.stop(); }
  });
});
