import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buildFfmpegArgs, shouldUsePowerShellDownload, cleanupTempDir, shouldEndOnStall, volumeToFactor, AudioPlayer } from "./player.js";
import type { Logger } from "../logger.js";

function getHeadersArg(args: string[]): string {
  const idx = args.indexOf("-headers");
  if (idx === -1) return "";
  return args[idx + 1] ?? "";
}

describe("buildFfmpegArgs", () => {
  it("includes browser User-Agent and Referer for Netease CDN URLs", () => {
    const url = "http://m701.music.126.net/some/path/song.mp3?vuutv=abc";
    const args = buildFfmpegArgs(url, 0);
    const headers = getHeadersArg(args);
    expect(headers).toContain("User-Agent:");
    expect(headers).toContain("Mozilla/5.0");
    expect(headers).toContain("Referer: https://music.163.com/");
  });

  it("keeps Bilibili Referer + UA for bilibili URLs", () => {
    const url = "https://upos-sz-mirrorcoso1.bilivideo.com/foo/bar.mp3";
    const args = buildFfmpegArgs(url, 0);
    const headers = getHeadersArg(args);
    expect(headers).toContain("Referer: https://www.bilibili.com");
    expect(headers).toContain("User-Agent: Mozilla/5.0");
  });

  it("does not set custom headers for unknown URLs", () => {
    const url = "https://example.com/song.mp3";
    const args = buildFfmpegArgs(url, 0);
    expect(args).not.toContain("-headers");
  });

  it("includes resilient reconnect flags for all URLs", () => {
    const args = buildFfmpegArgs("https://example.com/song.mp3", 0);
    expect(args).toContain("-reconnect");
    expect(args).toContain("-reconnect_streamed");
    expect(args).toContain("-reconnect_delay_max");
    expect(args).toContain("-reconnect_on_network_error");
    expect(args).toContain("-reconnect_on_http_error");
    const idx = args.indexOf("-reconnect_delay_max");
    expect(Number(args[idx + 1])).toBeGreaterThanOrEqual(30);
  });

  it("sets -reconnect_at_eof 1 (before -i) so long B站 streams resume after premature EOF (#89)", () => {
    const args = buildFfmpegArgs("https://x.bilivideo.com/audio.m4s", 0);
    const idx = args.indexOf("-reconnect_at_eof");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("1");
    expect(idx).toBeLessThan(args.indexOf("-i")); // input options must precede -i
  });

  it("inserts -ss before -i when seekSeconds > 0", () => {
    const args = buildFfmpegArgs("https://example.com/song.mp3", 42);
    const ssIdx = args.indexOf("-ss");
    const iIdx = args.indexOf("-i");
    expect(ssIdx).toBeGreaterThan(-1);
    expect(args[ssIdx + 1]).toBe("42");
    expect(ssIdx).toBeLessThan(iIdx);
  });

  it("does not insert -ss when seekSeconds is 0", () => {
    const args = buildFfmpegArgs("https://example.com/song.mp3", 0);
    expect(args).not.toContain("-ss");
  });

  it("omits HTTP-only flags when input is a local file path", () => {
    const args = buildFfmpegArgs("C:/temp/song.mp3", 0);
    expect(args).not.toContain("-reconnect");
    expect(args).not.toContain("-reconnect_at_eof");
    expect(args).not.toContain("-reconnect_on_network_error");
    expect(args).not.toContain("-reconnect_on_http_error");
    expect(args).not.toContain("-headers");
    expect(args).toContain("-i");
    expect(args[args.indexOf("-i") + 1]).toBe("C:/temp/song.mp3");
  });

  it("ends args with the input URL and PCM output spec", () => {
    const url = "https://example.com/song.mp3";
    const args = buildFfmpegArgs(url, 0);
    const iIdx = args.indexOf("-i");
    expect(args[iIdx + 1]).toBe(url);
    expect(args).toContain("-f");
    expect(args).toContain("s16le");
    expect(args[args.length - 1]).toBe("-");
  });
});

describe("volumeToFactor (#84 smooth volume curve)", () => {
  it("is 0 at vol 0 and exactly 1.0 at vol 100 (full loudness still reserved at 100)", () => {
    expect(volumeToFactor(0)).toBe(0);
    expect(volumeToFactor(100)).toBe(1);
  });

  it("clamps out-of-range input", () => {
    expect(volumeToFactor(-20)).toBe(0);
    expect(volumeToFactor(150)).toBe(1);
  });

  it("is strictly monotonic across the whole range (no dead zone)", () => {
    for (let v = 0; v < 100; v++) {
      expect(volumeToFactor(v + 1)).toBeGreaterThan(volumeToFactor(v));
    }
  });

  it("removes the old flat 80-99 dead zone", () => {
    // Old mapping moved only 0.16 -> 0.198 across 80..99; new curve climbs clearly.
    expect(volumeToFactor(99) - volumeToFactor(80)).toBeGreaterThan(0.3);
  });

  it("removes the discontinuity at 100 (old jump was ~0.8)", () => {
    expect(volumeToFactor(100) - volumeToFactor(99)).toBeLessThan(0.1);
  });

  it("keeps the low range gentle", () => {
    expect(volumeToFactor(50)).toBeLessThan(0.12);
  });
});

describe("shouldUsePowerShellDownload", () => {
  const jdymusicUrl =
    "http://m801.music.126.net/20260507/abc/jdymusic/obj/xyz/song.mp3?vuutv=tok";
  const newCdnUrl =
    "http://m801.music.126.net/20260507/abc/jd-musicrep-ts/obj/xyz/song.mp3?vuutv=tok";
  const ymusicUrl =
    "http://m801.music.126.net/20260507/abc/ymusic/obj/xyz/song.mp3?vuutv=tok";

  it("returns true for /jdymusic/ URL on win32", () => {
    expect(shouldUsePowerShellDownload(jdymusicUrl, "win32")).toBe(true);
  });

  it("returns false for /jdymusic/ URL on linux", () => {
    expect(shouldUsePowerShellDownload(jdymusicUrl, "linux")).toBe(false);
  });

  it("returns false for /jdymusic/ URL on darwin", () => {
    expect(shouldUsePowerShellDownload(jdymusicUrl, "darwin")).toBe(false);
  });

  it("returns false for new-format /jd-musicrep-ts/ URL on win32", () => {
    expect(shouldUsePowerShellDownload(newCdnUrl, "win32")).toBe(false);
  });

  it("returns false for /ymusic/ URL on win32", () => {
    expect(shouldUsePowerShellDownload(ymusicUrl, "win32")).toBe(false);
  });

  it("returns false for unrelated URLs", () => {
    expect(shouldUsePowerShellDownload("https://example.com/x.mp3", "win32")).toBe(false);
  });
});

describe("cleanupTempDir", () => {
  it("removes a directory and its contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsbot-test-"));
    writeFileSync(join(dir, "song.mp3"), "fake-bytes");
    expect(existsSync(dir)).toBe(true);
    cleanupTempDir(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("does not throw when directory does not exist", () => {
    const missing = join(tmpdir(), "tsbot-test-does-not-exist-xyz");
    expect(() => cleanupTempDir(missing)).not.toThrow();
  });

  it("does not throw when called twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "tsbot-test-"));
    cleanupTempDir(dir);
    expect(() => cleanupTempDir(dir)).not.toThrow();
  });
});

describe("shouldEndOnStall (#89 mid-track stall watchdog)", () => {
  const MAX_EMPTY = 250; // ~5s near-end threshold
  const MAX_STALL = 3000; // ~60s far-from-end watchdog

  it("ends quickly near the end once the empty threshold is reached (normal EOF)", () => {
    expect(shouldEndOnStall(MAX_EMPTY, true, MAX_EMPTY, MAX_STALL)).toBe(true);
    expect(shouldEndOnStall(MAX_EMPTY - 1, true, MAX_EMPTY, MAX_STALL)).toBe(false);
  });

  it("does NOT end far from the end at the near-end threshold (avoids false skips on transient underruns)", () => {
    // This is the core regression: a brief underrun mid-song must not end the track.
    expect(shouldEndOnStall(MAX_EMPTY, false, MAX_EMPTY, MAX_STALL)).toBe(false);
    expect(shouldEndOnStall(MAX_STALL - 1, false, MAX_EMPTY, MAX_STALL)).toBe(false);
  });

  it("eventually ends far from the end once the long stall watchdog trips (dead stream recovers)", () => {
    // The pre-fix bug: far-from-end stalls grew unbounded and never ended -> permanent silence.
    expect(shouldEndOnStall(MAX_STALL, false, MAX_EMPTY, MAX_STALL)).toBe(true);
    expect(shouldEndOnStall(MAX_STALL + 500, false, MAX_EMPTY, MAX_STALL)).toBe(true);
  });

  it("never ends before any threshold", () => {
    expect(shouldEndOnStall(0, true, MAX_EMPTY, MAX_STALL)).toBe(false);
    expect(shouldEndOnStall(10, false, MAX_EMPTY, MAX_STALL)).toBe(false);
  });
});

// Minimal stub: AudioPlayer only calls debug/info/warn/error; child() returns self.
const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  trace() {},
  child() {
    return silentLogger;
  },
} as unknown as Logger;

function applyPlayerVolume(player: AudioPlayer, pcm: Buffer): Buffer {
  return (
    player as unknown as { applyVolume(input: Buffer): Buffer }
  ).applyVolume(pcm);
}

function stereoPcm(sample: number, frames = 2): Buffer {
  const pcm = Buffer.alloc(frames * 4);
  for (let offset = 0; offset < pcm.length; offset += 2) {
    pcm.writeInt16LE(sample, offset);
  }
  return pcm;
}

describe("AudioPlayer transient ducking gain", () => {
  it("layers ducking on the PCM path without changing the user's base volume", () => {
    const player = new AudioPlayer(silentLogger);
    player.setVolume(100);
    player.setDuckingGain(0.3);

    const adjusted = applyPlayerVolume(player, stereoPcm(10_000));

    expect(adjusted.readInt16LE(0)).toBe(3_000);
    expect(adjusted.readInt16LE(2)).toBe(3_000);
    expect(player.getVolume()).toBe(100);
    expect(player.getDuckingGain()).toBe(0.3);
  });

  it("multiplies the transient gain by the existing base-volume curve", () => {
    const player = new AudioPlayer(silentLogger);
    player.setVolume(50);
    player.setDuckingGain(0.5);

    const adjusted = applyPlayerVolume(player, stereoPcm(10_000));
    expect(adjusted.readInt16LE(0)).toBe(
      Math.round(10_000 * volumeToFactor(50) * 0.5),
    );
  });

  it("interpolates ramps smoothly across each stereo PCM frame", () => {
    let now = 100;
    const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const player = new AudioPlayer(silentLogger);
      player.setVolume(100);
      player.setDuckingGain(0.2, 100);

      now = 150;
      expect(player.getDuckingGain()).toBeCloseTo(0.6, 8);
      const adjusted = applyPlayerVolume(player, stereoPcm(10_000));

      // At t=150 the ramp is 0.6; at the end of this 20 ms frame it is 0.44.
      expect(adjusted.readInt16LE(0)).toBe(6_000);
      expect(adjusted.readInt16LE(2)).toBe(6_000);
      expect(adjusted.readInt16LE(4)).toBe(4_400);
      expect(adjusted.readInt16LE(6)).toBe(4_400);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("clamps transient gain and ignores a non-finite update", () => {
    const player = new AudioPlayer(silentLogger);
    player.setDuckingGain(-1);
    expect(player.getDuckingGain()).toBe(0);
    player.setDuckingGain(2);
    expect(player.getDuckingGain()).toBe(1);
    player.setDuckingGain(Number.NaN);
    expect(player.getDuckingGain()).toBe(1);
  });
});

// A readable we fully control: no underlying source; we push PCM manually and
// keep it open (never push(null)) to model the long-lived go-librespot sidecar.
function openPcmReadable(): Readable {
  return new Readable({ read() {} });
}

const wait = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
const FRAME_BYTES = 3840; // PCM_FRAME_BYTES: 960 samples * 2ch * 2 bytes @48k s16le

describe("AudioPlayer external-PCM mode (playPcmStream)", () => {
  it("emits Opus 'frame' events from the external PCM stream without spawning ffmpeg", async () => {
    const player = new AudioPlayer(silentLogger);
    const frames: Buffer[] = [];
    player.on("frame", (f) => frames.push(f));

    const stream = openPcmReadable();
    player.playPcmStream(stream, {});
    stream.push(Buffer.alloc(FRAME_BYTES * 10)); // ~10 frames of PCM

    await wait(150); // ~7 frame ticks at 20ms

    expect(player.getState()).toBe("playing");
    expect(frames.length).toBeGreaterThan(0);
    expect(Buffer.isBuffer(frames[0])).toBe(true);
    player.stop();
  });

  it("does NOT emit 'trackEnd' on underrun while external (stream stays open)", async () => {
    const player = new AudioPlayer(silentLogger);
    let ended = 0;
    const frames: Buffer[] = [];
    player.on("trackEnd", () => ended++);
    player.on("frame", (f) => frames.push(f));

    const stream = openPcmReadable();
    player.playPcmStream(stream, {});
    stream.push(Buffer.alloc(FRAME_BYTES * 2)); // only 2 frames, then underrun

    await wait(200); // long after those 2 frames have drained

    // In the url path, ffmpeg===null + empty buffer would fire trackEnd; here it must not.
    expect(ended).toBe(0);
    // Silence frames keep the 20ms timeline alive -> more than the 2 fed frames emitted.
    expect(frames.length).toBeGreaterThan(2);
    expect(player.getState()).toBe("playing");
    player.stop();
  });

  // CORRECTION C2 (c): stop() DETACHES the shared readable — it must NOT be destroyed
  // (destroying the sidecar's long-lived ffmpeg stdout would kill it for every future
  // track). The sessionId bump + listener removal fence stale PCM out of pcmBuffer.
  it("stop() detaches external mode without destroying the readable, and fences via sessionId", async () => {
    const player = new AudioPlayer(silentLogger);
    const frames: Buffer[] = [];
    player.on("frame", (f) => frames.push(f));

    const stream = openPcmReadable();
    player.playPcmStream(stream, {});
    expect(stream.listenerCount("data")).toBe(1);
    stream.push(Buffer.alloc(FRAME_BYTES * 5));
    await wait(80);

    player.stop();
    expect(player.getState()).toBe("idle");
    // C2: the shared sidecar stream must NOT be destroyed by teardown.
    expect(stream.destroyed).toBe(false);
    // Player's listeners are removed on detach (data/end/error).
    expect(stream.listenerCount("data")).toBe(0);
    expect(stream.listenerCount("end")).toBe(0);
    expect(stream.listenerCount("error")).toBe(0);

    const countAtStop = frames.length;
    // sessionId fence + detached listeners: PCM pushed after stop must not
    // resurrect the timeline or re-feed pcmBuffer.
    stream.push(Buffer.alloc(FRAME_BYTES * 5));
    await wait(80);
    expect(frames.length).toBe(countAtStop);
  });

  // CORRECTION C2 (a): a gapless track change is driven by the sidecar pushing LATER
  // PCM over the SAME already-attached stream. The player must NOT detach/re-attach
  // (no second playPcmStream) — one persistent data listener serves every track.
  it("(C2-a) feeds a later chunk over the SAME single attachment — gapless track change, no re-attach", async () => {
    const player = new AudioPlayer(silentLogger);
    const frames: Buffer[] = [];
    player.on("frame", (f) => frames.push(f));

    const stream = openPcmReadable();
    player.playPcmStream(stream, {});
    expect(stream.listenerCount("data")).toBe(1); // attached exactly once

    stream.push(Buffer.alloc(FRAME_BYTES * 4)); // "track 1" PCM
    await wait(120);
    const afterFirst = frames.length;
    expect(afterFirst).toBeGreaterThan(0);

    stream.push(Buffer.alloc(FRAME_BYTES * 4)); // sidecar seamlessly rolls into "track 2"
    await wait(120);
    expect(frames.length).toBeGreaterThan(afterFirst);

    // Still exactly ONE listener — no detach/re-attach across the handoff.
    expect(stream.listenerCount("data")).toBe(1);
    expect(player.getState()).toBe("playing");
    player.stop();
  });

  // CORRECTION C2 (b): a second playPcmStream detaches the first (NOT destroyed, and it
  // stops feeding pcmBuffer) and attaches the second.
  it("(C2-b) a second playPcmStream detaches the first (not destroyed, stops feeding) and attaches the second", async () => {
    const player = new AudioPlayer(silentLogger);
    const frames: Buffer[] = [];
    player.on("frame", (f) => frames.push(f));

    const first = openPcmReadable();
    player.playPcmStream(first, {});
    first.push(Buffer.alloc(FRAME_BYTES * 4));
    await wait(120);
    expect(frames.length).toBeGreaterThan(0);
    expect(first.listenerCount("data")).toBe(1);

    const second = openPcmReadable();
    player.playPcmStream(second, {}); // fences + detaches `first`, attaches `second`

    // C2: `first` is DETACHED, not destroyed.
    expect(first.destroyed).toBe(false);
    // `first` no longer feeds pcmBuffer — its data listener was removed.
    expect(first.listenerCount("data")).toBe(0);
    // `second` is now the attached source.
    expect(second.listenerCount("data")).toBe(1);
    expect(player.getState()).toBe("playing");
    player.stop();
  });

  it("fires onExternalEnd when the readable ends (drives controller-based advance)", async () => {
    const player = new AudioPlayer(silentLogger);
    let endedCb = 0;

    const stream = openPcmReadable();
    player.playPcmStream(stream, { onExternalEnd: () => endedCb++ });
    stream.push(Buffer.alloc(FRAME_BYTES));
    await wait(40);
    stream.push(null); // end-of-stream
    await wait(40);

    expect(endedCb).toBe(1);
    player.stop();
  });

  it("seek() is a local no-op in external mode (never respawns ffmpeg on a spotify sentinel)", async () => {
    const player = new AudioPlayer(silentLogger);
    const stream = openPcmReadable();
    player.playPcmStream(stream, {});
    stream.push(Buffer.alloc(FRAME_BYTES * 3));
    await wait(40);

    expect(() => player.seek(30)).not.toThrow();
    // Still external, still playing — no url-ffmpeg respawn, state unchanged.
    expect(player.getState()).toBe("playing");
    player.stop();
  });

  it("isExternalActive() is false initially, true after playPcmStream, false after stop()", () => {
    const player = new AudioPlayer(silentLogger);
    // Idle: never attached.
    expect(player.isExternalActive()).toBe(false);

    const stream = openPcmReadable();
    player.playPcmStream(stream, {});
    // Attached to the external sidecar stream.
    expect(player.isExternalActive()).toBe(true);

    player.stop();
    // Detached again — the orchestrator uses this to know it must re-attach.
    expect(player.isExternalActive()).toBe(false);
  });

  it("pause()/resume() still gate local emission in external mode (unchanged semantics)", async () => {
    const player = new AudioPlayer(silentLogger);
    const stream = openPcmReadable();
    player.playPcmStream(stream, {});
    stream.push(Buffer.alloc(FRAME_BYTES * 3));
    await wait(40);

    player.pause();
    expect(player.getState()).toBe("paused");
    player.resume();
    expect(player.getState()).toBe("playing");
    player.stop();
  });

  // CORRECTION C1 (whole-branch): mixed queue [spotifyA, neteaseB, spotifyC].
  // Advancing A -> B (a NON-spotify track) calls stop(), whose detachExternalStream()
  // PAUSES the backend's long-lived SHARED readable (state.flowing = false). When the
  // LATER spotify track C reuses the SAME backend, the orchestrator re-attaches that
  // SAME readable via playPcmStream(). Node's Readable.on('data') only auto-resumes
  // when flowing !== false, so without an explicit resume() the shared stream stays
  // paused, onData never fires, pcmBuffer stays empty, and C plays only silence frames.
  // Regression: after re-attach the shared stream MUST be flowing again and real PCM
  // MUST reach the player.
  it("(C1) resumes a re-attached, previously-paused SHARED stream so a later Spotify track isn't silent", async () => {
    const player = new AudioPlayer(silentLogger);
    const frames: Buffer[] = [];
    player.on("frame", (f) => frames.push(f));

    // The backend's long-lived, SHARED readable, reused across every track.
    const shared = openPcmReadable();

    // --- Spotify track A: first attach (auto-resumes, flowing was null !== false).
    player.playPcmStream(shared, {});
    shared.push(Buffer.alloc(FRAME_BYTES * 4));
    await wait(120);
    expect(frames.length).toBeGreaterThan(0);

    // --- Advance to a NON-spotify track (neteaseB): play(url) begins with stop(),
    // which detaches AND pauses the shared stream (state.flowing = false).
    player.stop();
    expect(shared.isPaused()).toBe(true); // shared stream is now paused
    expect(player.getState()).toBe("idle");

    // --- Spotify track C reuses the SAME backend: isExternalActive() is false so the
    // orchestrator re-attaches the SAME (paused) shared readable.
    expect(player.isExternalActive()).toBe(false);

    // Spy on the shared stream to observe whether real PCM actually flows to the
    // player. Adding a 'data' listener while flowing===false does NOT resume it
    // (Node semantics), so this spy cannot mask the bug — pre-fix it stays at 0.
    let spyBytes = 0;
    shared.on("data", (c: Buffer) => {
      spyBytes += c.length;
    });

    player.playPcmStream(shared, {}); // re-attach the SAME shared readable

    // The re-attached stream must be flowing again, or track C is silent.
    expect(shared.isPaused()).toBe(false);

    shared.push(Buffer.alloc(FRAME_BYTES * 4)); // "track C" PCM
    await wait(120);

    // onData must have run (real PCM reached the player), not just silence frames.
    expect(spyBytes).toBeGreaterThan(0);
    expect(player.getState()).toBe("playing");
    player.stop();
  });
});

// R3-4: the 20ms frame loop keeps running while paused (so a live-but-silent
// stream can refill on resume). But the stall/EOF end-detection branches MUST
// only run while state==="playing" — otherwise pausing a stalled or
// unknown-duration stream still accumulates emptyFrameAttempts and auto-emits
// trackEnd (~5s later), making the controller skip the paused track.
//
// These tests drive the real url-path frame loop (this.ffmpeg !== null, NOT
// external mode), which cannot be exercised via playPcmStream (that sets
// externalMode and suppresses both branches). We inject a fake live ffmpeg +
// an empty pcmBuffer (a stream that stays alive but never yields a full PCM
// frame) and run the actual startFrameLoop() under fake timers. `performance`
// is faked in lockstep with the timer clock so each tick advances a real 20ms,
// letting us cheaply cross MAX_EMPTY_ATTEMPTS (250 ticks ≈ 5s) deterministically.
describe("AudioPlayer stall/EOF end-detection is gated on playing state (R3-4)", () => {
  // Fake `performance` in lockstep with the timer clock so each advanced 20ms is
  // a real frame tick (the loop computes its delay from performance.now()).
  const FAKE_TIMER_OPTS: Parameters<typeof vi.useFakeTimers>[0] = {
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
  };

  // A player primed as "playing" with a LIVE ffmpeg that never produces a full
  // PCM frame (unknown duration -> isNearEnd forced true). startFrameLoop() runs
  // the genuine loop; no real process is spawned (fake ffmpeg has no pid, so the
  // end path never touches forceCleanup/process.kill).
  function makeStalledPlaying(): AudioPlayer {
    const player = new AudioPlayer(silentLogger);
    const p = player as unknown as {
      ffmpeg: unknown;
      currentSongDuration: number;
      pcmBuffer: Buffer;
      emptyFrameAttempts: number;
      framesPlayed: number;
      state: string;
      startFrameLoop(): void;
    };
    p.ffmpeg = { pid: undefined }; // live ffmpeg, but delivers no PCM
    p.currentSongDuration = 0; // unknown duration -> isNearEnd === true
    p.pcmBuffer = Buffer.alloc(0); // always < one PCM frame
    p.emptyFrameAttempts = 0;
    p.framesPlayed = 0;
    p.state = "playing";
    p.startFrameLoop();
    return player;
  }

  it("does NOT emit trackEnd (and stays paused) when a stalled unknown-duration stream is paused past the stall threshold", () => {
    vi.useFakeTimers(FAKE_TIMER_OPTS);
    try {
      const player = makeStalledPlaying();
      let ended = 0;
      player.on("trackEnd", () => ended++);

      player.pause();
      expect(player.getState()).toBe("paused");

      // Advance well past MAX_EMPTY_ATTEMPTS (250 ticks ≈ 5s): ~300 ticks.
      vi.advanceTimersByTime(20 * 300);

      expect(ended).toBe(0);
      expect(player.getState()).toBe("paused");
      player.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("STILL emits trackEnd when the SAME stalled unknown-duration stream is left playing (dead-stream recovery #89 preserved)", () => {
    vi.useFakeTimers(FAKE_TIMER_OPTS);
    try {
      const player = makeStalledPlaying(); // stays "playing"
      let ended = 0;
      player.on("trackEnd", () => ended++);

      vi.advanceTimersByTime(20 * 300); // cross the 250-tick stall threshold

      expect(ended).toBe(1);
      expect(player.getState()).toBe("idle");
      player.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not spuriously end after a brief pause+resume on a healthy stream", () => {
    vi.useFakeTimers(FAKE_TIMER_OPTS);
    try {
      const player = new AudioPlayer(silentLogger);
      const p = player as unknown as {
        ffmpeg: unknown;
        currentSongDuration: number;
        pcmBuffer: Buffer;
        emptyFrameAttempts: number;
        framesPlayed: number;
        state: string;
        startFrameLoop(): void;
      };
      // Healthy: a live ffmpeg with a large buffered runway that never drains
      // empty across the ticks below, so no underrun is ever seen.
      p.ffmpeg = { pid: undefined };
      p.currentSongDuration = 0;
      p.pcmBuffer = Buffer.alloc(FRAME_BYTES * 400);
      p.emptyFrameAttempts = 0;
      p.framesPlayed = 0;
      p.state = "playing";
      p.startFrameLoop();

      let ended = 0;
      player.on("trackEnd", () => ended++);

      vi.advanceTimersByTime(20 * 5); // play a few frames
      player.pause();
      vi.advanceTimersByTime(20 * 100); // brief pause (buffer NOT drained while paused)
      player.resume();
      expect(player.getState()).toBe("playing");
      vi.advanceTimersByTime(20 * 100); // resume; still plenty of runway

      expect(ended).toBe(0);
      expect(player.getState()).toBe("playing");
      player.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
