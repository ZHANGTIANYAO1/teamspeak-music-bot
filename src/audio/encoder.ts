import { OpusEncoder } from "@discordjs/opus";

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const FRAME_DURATION_MS = 20;
export const FRAME_SIZE = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960 samples
export const PCM_FRAME_BYTES = FRAME_SIZE * CHANNELS * 2; // 3840 bytes (16-bit stereo)

export interface Encoder {
  encode(pcm: Buffer): Buffer;
  decode(opus: Buffer): Buffer;
}

export function createOpusEncoder(): Encoder {
  const opus = new OpusEncoder(SAMPLE_RATE, CHANNELS);

  return {
    encode(pcm: Buffer): Buffer {
      return opus.encode(pcm);
    },
    decode(opusData: Buffer): Buffer {
      return opus.decode(opusData);
    },
  };
}
