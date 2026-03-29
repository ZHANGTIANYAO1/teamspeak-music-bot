import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createOpusEncoder, PCM_FRAME_BYTES, type Encoder } from "./encoder.js";
import type pino from "pino";

export type PlayerState = "idle" | "playing" | "paused";

export class AudioPlayer extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private encoder: Encoder;
  private state: PlayerState = "idle";
  private volume = 75; // 0-100
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private pcmBuffer: Buffer = Buffer.alloc(0);
  private logger: pino.Logger;

  constructor(logger: pino.Logger) {
    super();
    this.encoder = createOpusEncoder();
    this.logger = logger;
  }

  play(url: string): void {
    this.stop();

    this.logger.info({ url }, "Starting playback");

    this.ffmpeg = spawn(
      "ffmpeg",
      [
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-i", url,
        "-f", "s16le",
        "-ar", "48000",
        "-ac", "2",
        "-af", `volume=${this.volume / 100}`,
        "-",
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );

    this.ffmpeg.stdout!.on("data", (chunk: Buffer) => {
      this.pcmBuffer = Buffer.concat([this.pcmBuffer, chunk]);
    });

    this.ffmpeg.on("close", (code) => {
      this.logger.debug({ code }, "FFmpeg process closed");
      if (this.state === "playing") {
        this.flushRemainingFrames();
        this.state = "idle";
        this.emit("trackEnd");
      }
    });

    this.ffmpeg.on("error", (err) => {
      this.logger.error({ err }, "FFmpeg error");
      this.emit("error", err);
    });

    this.state = "playing";

    this.frameTimer = setInterval(() => {
      if (this.state !== "playing") return;
      this.sendNextFrame();
    }, 20);
  }

  private sendNextFrame(): void {
    if (this.pcmBuffer.length < PCM_FRAME_BYTES) return;

    const pcmFrame = this.pcmBuffer.subarray(0, PCM_FRAME_BYTES);
    this.pcmBuffer = this.pcmBuffer.subarray(PCM_FRAME_BYTES);

    const opusFrame = this.encoder.encode(Buffer.from(pcmFrame));
    this.emit("frame", opusFrame);
  }

  private flushRemainingFrames(): void {
    while (this.pcmBuffer.length >= PCM_FRAME_BYTES) {
      this.sendNextFrame();
    }
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
      this.logger.debug("Playback resumed");
    }
  }

  stop(): void {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    if (this.ffmpeg) {
      this.ffmpeg.kill("SIGTERM");
      this.ffmpeg = null;
    }
    this.pcmBuffer = Buffer.alloc(0);
    this.state = "idle";
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
