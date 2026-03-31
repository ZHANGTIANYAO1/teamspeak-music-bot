import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { accessSync, chmodSync, constants } from "node:fs";
import { createOpusEncoder, PCM_FRAME_BYTES, type Encoder } from "./encoder.js";
import type { Logger } from "../logger.js";

// ffmpeg-static is a CJS module that exports the path to the bundled ffmpeg binary.
const require = createRequire(import.meta.url);
const ffmpegPath: string | null = require("ffmpeg-static");

/** Ensure the given binary has execute permission. */
function isExecutable(binPath: string): boolean {
  try {
    accessSync(binPath, constants.X_OK);
    return true;
  } catch {
    try {
      chmodSync(binPath, 0o755);
      accessSync(binPath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/** Resolved once at module load — no repeated fs checks per play(). */
const resolvedFfmpeg: string =
  ffmpegPath && isExecutable(ffmpegPath) ? ffmpegPath : "ffmpeg";

/** Resolve ffmpeg binary: prefer bundled ffmpeg-static, fall back to system PATH. */
function getFfmpegCommand(): string {
  return resolvedFfmpeg;
}

export interface PlayerEvents {
  frame: (opusFrame: Buffer) => void;
  trackEnd: () => void;
  error: (err: Error) => void;
}

export type PlayerState = "idle" | "playing" | "paused";

const FRAME_DURATION_MS = 20;

export class AudioPlayer extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private encoder: Encoder;
  private state: PlayerState = "idle";
  private volume = 75;
  private pcmBuffer: Buffer = Buffer.alloc(0);
  private logger: Logger;
  private frameLoopRunning = false;
  private nextFrameTime = 0;
  private currentUrl = "";
  private seekOffset = 0;
  private framesPlayed = 0; // ground truth: number of 20ms frames sent
  private sessionId = 0;
  private static readonly BUFFER_HIGH_WATER = 960 * 1024; // ~5s of PCM at 48kHz stereo
  private static readonly BUFFER_LOW_WATER = 480 * 1024;  // ~2.5s
  private ffmpegPaused = false;

  constructor(logger: Logger) {
    super();
    this.encoder = createOpusEncoder();
    this.logger = logger;
  }

  play(url: string, seekSeconds = 0): void {
    this.stop();
    this.sessionId++;
    const playSessionId = this.sessionId;
    this.currentUrl = url;
    this.seekOffset = seekSeconds;
    this.framesPlayed = 0;
    this.ffmpegPaused = false;

    this.logger.info({ url: url.slice(0, 80), seek: seekSeconds }, "Starting playback");

    const args: string[] = [];

    // BiliBili CDN requires Referer header for audio playback
    if (url.includes("bilivideo") || url.includes("bilibili")) {
      args.push(
        "-headers",
        "Referer: https://www.bilibili.com\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n"
      );
    }

    args.push(
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
    );
    if (seekSeconds > 0) {
      args.push("-ss", String(seekSeconds));
    }
    args.push(
      "-i", url,
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "-acodec", "pcm_s16le",
      "-",
    );

    const ffmpegBin = getFfmpegCommand();
    this.logger.debug({ ffmpeg: ffmpegBin }, "Using ffmpeg binary");
    this.ffmpeg = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });

    this.ffmpeg.stderr!.on("data", (data: Buffer) => {
      this.logger.debug({ stderr: data.toString().trimEnd() }, "FFmpeg stderr");
    });

    this.ffmpeg.stdout!.on("data", (chunk: Buffer) => {
      this.pcmBuffer = Buffer.concat([this.pcmBuffer, chunk]);
      // Backpressure: pause FFmpeg stdout when buffer is too large
      if (this.pcmBuffer.length > AudioPlayer.BUFFER_HIGH_WATER && !this.ffmpegPaused && this.ffmpeg?.stdout) {
        this.ffmpeg.stdout.pause();
        this.ffmpegPaused = true;
      }
    });

    this.ffmpeg.on("close", () => {
      if (this.sessionId === playSessionId) {
        this.ffmpeg = null; // Signal frame loop that no more data is coming
      }
    });

    this.ffmpeg.on("error", (err) => {
      this.logger.error({ err }, "FFmpeg error");
      if (this.sessionId === playSessionId) {
        this.emit("error", err);
      }
    });

    this.state = "playing";
    this.startFrameLoop();
  }

  private startFrameLoop(): void {
    if (this.frameLoopRunning) return;
    this.frameLoopRunning = true;
    this.nextFrameTime = performance.now();
    this.scheduleNextFrame();
  }

  private scheduleNextFrame(): void {
    if (!this.frameLoopRunning) return;

    const loopSessionId = this.sessionId;

    this.nextFrameTime += FRAME_DURATION_MS;
    const now = performance.now();
    const delay = Math.max(0, this.nextFrameTime - now);

    setTimeout(() => {
      // Discard callback from a stale play session
      if (loopSessionId !== this.sessionId) return;
      if (!this.frameLoopRunning) return;

      if (this.state === "playing") {
        this.sendNextFrame();
      } else if (this.state === "paused") {
        this.nextFrameTime = performance.now();
      }

      if (!this.ffmpeg && this.pcmBuffer.length < PCM_FRAME_BYTES) {
        this.frameLoopRunning = false;
        if (this.state !== "idle") {
          this.state = "idle";
          this.emit("trackEnd");
        }
        return;
      }

      this.scheduleNextFrame();
    }, delay);
  }

  private sendNextFrame(): void {
    if (this.pcmBuffer.length < PCM_FRAME_BYTES) return;

    const pcmFrame = this.pcmBuffer.subarray(0, PCM_FRAME_BYTES);
    this.pcmBuffer = this.pcmBuffer.subarray(PCM_FRAME_BYTES);

    // Backpressure: resume FFmpeg stdout when buffer drains below low-water mark
    if (this.ffmpegPaused && this.pcmBuffer.length < AudioPlayer.BUFFER_LOW_WATER && this.ffmpeg?.stdout) {
      this.ffmpeg.stdout.resume();
      this.ffmpegPaused = false;
    }

    const adjusted = this.applyVolume(pcmFrame);
    const opusFrame = this.encoder.encode(adjusted);
    this.emit("frame", opusFrame);
    this.framesPlayed++;
  }

  private applyVolume(pcm: Buffer): Buffer {
    if (this.volume === 100) return Buffer.from(pcm);
    const factor = this.volume / 100;
    const out = Buffer.alloc(pcm.length);
    for (let i = 0; i < pcm.length; i += 2) {
      let sample = pcm.readInt16LE(i);
      sample = Math.round(sample * factor);
      if (sample > 32767) sample = 32767;
      else if (sample < -32768) sample = -32768;
      out.writeInt16LE(sample, i);
    }
    return out;
  }

  /** Actual elapsed time in seconds (ground truth from frame count) */
  getElapsed(): number {
    return this.seekOffset + (this.framesPlayed * FRAME_DURATION_MS) / 1000;
  }

  seek(seconds: number): void {
    if (!this.currentUrl) return;
    this.logger.info({ seek: seconds }, "Seeking");
    this.play(this.currentUrl, seconds);
  }

  getSeekOffset(): number {
    return this.seekOffset;
  }

  pause(): void {
    if (this.state === "playing") {
      this.state = "paused";
      this.logger.debug("Playback paused");
    }
  }

  resume(): void {
    if (this.state === "paused") {
      this.state = "playing";
      this.nextFrameTime = performance.now();
      this.logger.debug("Playback resumed");
    }
  }

  stop(): void {
    this.sessionId++;
    this.frameLoopRunning = false;
    if (this.ffmpeg) {
      this.ffmpeg.kill("SIGTERM");
      this.ffmpeg = null;
    }
    this.pcmBuffer = Buffer.alloc(0);
    this.ffmpegPaused = false;
    this.state = "idle";
    this.currentUrl = "";
    this.seekOffset = 0;
    this.framesPlayed = 0;
  }

  setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(100, vol));
  }

  getVolume(): number {
    return this.volume;
  }

  getState(): PlayerState {
    return this.state;
  }
}
