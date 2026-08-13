import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { buildFfmpegArgs } from "../audio/player.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMusicProvider, parseMediaProbe } from "./local.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "local-audio-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Seed real files + an index.json so we can exercise the cleanup lifecycle
// without invoking the ffmpeg duration probe that uploadAudio runs.
function makeRecord(id: string, bytes = 16) {
  const filePath = join(dir, `${id}.mp3`);
  writeFileSync(filePath, Buffer.alloc(bytes, 1));
  return {
    id,
    name: id,
    artist: "本地上传",
    album: "本地音乐",
    duration: 0,
    coverUrl: "",
    platform: "local" as const,
    filePath,
    originalName: `${id}.mp3`,
    uploadedAt: "1970-01-01T00:00:00.000Z",
    size: bytes,
    mimeType: "audio/mpeg",
  };
}

function seed(records: ReturnType<typeof makeRecord>[]) {
  writeFileSync(join(dir, "index.json"), JSON.stringify(records), "utf8");
}

describe("LocalMusicProvider cleanup lifecycle", () => {
  it("sweep keeps referenced and never-played files, deletes only played+unreferenced", async () => {
    const a = makeRecord("a");
    const b = makeRecord("b");
    const c = makeRecord("c");
    seed([a, b, c]);
    const p = new LocalMusicProvider(dir);
    const refs = new Set<string>(["a"]); // "a" still sits in a queue somewhere
    p.setInUseResolver(() => refs);

    await p.getSongUrl("a"); // played, but referenced
    await p.getSongUrl("b"); // played and unreferenced
    // "c" was never played (e.g. uploaded but not queued)

    const deleted = p.sweepUnreferenced();

    expect(deleted).toEqual(["b"]);
    expect(existsSync(a.filePath)).toBe(true); // referenced → kept
    expect(existsSync(b.filePath)).toBe(false); // played + unreferenced → deleted
    expect(existsSync(c.filePath)).toBe(true); // never played → kept
  });

  it("a played song still in the queue survives the sweep and stays replayable (loop / prev)", async () => {
    const a = makeRecord("a");
    seed([a]);
    const p = new LocalMusicProvider(dir);
    const refs = new Set<string>(["a"]); // loop queue still references it
    p.setInUseResolver(() => refs);

    await p.getSongUrl("a"); // first pass plays it
    p.sweepUnreferenced(); // "playback_finished" sweep

    expect(existsSync(a.filePath)).toBe(true);
    expect((await p.getSongUrl("a"))?.url).toBe(a.filePath); // next loop pass works
  });

  it("re-playing a queued local song does not delete it (play-song order)", async () => {
    const a = makeRecord("a");
    seed([a]);
    const p = new LocalMusicProvider(dir);
    // Mirror the fixed endpoint order: the song is (re)added to the queue
    // BEFORE the sweep runs, so it is referenced when we sweep.
    const refs = new Set<string>(["a"]);
    p.setInUseResolver(() => refs);

    await p.getSongUrl("a"); // played once
    p.sweepUnreferenced(); // sweep fired after the replay re-queued it
    expect(existsSync(a.filePath)).toBe(true);
    expect(await p.getSongUrl("a")).not.toBeNull();
  });

  it("deletes a played file once it leaves every queue", async () => {
    const a = makeRecord("a");
    seed([a]);
    const p = new LocalMusicProvider(dir);
    let refs = new Set<string>(["a"]);
    p.setInUseResolver(() => refs);

    await p.getSongUrl("a");
    p.sweepUnreferenced();
    expect(existsSync(a.filePath)).toBe(true); // still queued

    refs = new Set<string>(); // queue cleared
    p.sweepUnreferenced();
    expect(existsSync(a.filePath)).toBe(false); // now removed
    expect(await p.getSongUrl("a")).toBeNull();
  });

  it("never deletes anything when the reference resolver throws", async () => {
    const a = makeRecord("a");
    seed([a]);
    const p = new LocalMusicProvider(dir);
    p.setInUseResolver(() => {
      throw new Error("manager unavailable");
    });
    await p.getSongUrl("a");
    expect(p.sweepUnreferenced()).toEqual([]);
    expect(existsSync(a.filePath)).toBe(true);
  });
});

describe("LocalMusicProvider upload validation", () => {
  it("rejects a spoofed Content-Type with a non-audio extension", async () => {
    const p = new LocalMusicProvider(dir);
    await expect(
      p.uploadAudio({
        buffer: Buffer.from("malicious"),
        originalName: "evil.exe",
        mimeType: "application/octet-stream",
      }),
    ).rejects.toThrow();
  });

  it("rejects an unknown extension even when the mime claims audio", async () => {
    const p = new LocalMusicProvider(dir);
    await expect(
      p.uploadAudio({
        buffer: Buffer.from("x"),
        originalName: "evil.html",
        mimeType: "audio/mpeg",
      }),
    ).rejects.toThrow();
  });

  it("rejects an empty file", async () => {
    const p = new LocalMusicProvider(dir);
    await expect(
      p.uploadAudio({ buffer: Buffer.alloc(0), originalName: "a.mp3" }),
    ).rejects.toThrow();
  });

  // #149: video containers are accepted; only their audio track is kept.
  it("still rejects a non-media extension after video was allowed", async () => {
    const p = new LocalMusicProvider(dir);
    for (const name of ["evil.exe", "evil.html", "evil.mp4.txt", "notes.pdf"]) {
      await expect(
        p.uploadAudio({ buffer: Buffer.from("x"), originalName: name, mimeType: "video/mp4" }),
      ).rejects.toThrow();
    }
  });

  it("accepts every supported video extension at the extension gate", async () => {
    const p = new LocalMusicProvider(dir);
    // Junk content: ffmpeg cannot open it, so it is "unrecognised" rather than
    // "no audio track" and must be accepted exactly like a truncated .mp3
    // always has been. The extension allowlist is what is under test here.
    // .m4v is excluded on purpose — see the next test.
    for (const ext of [".mp4", ".mov", ".avi", ".mkv", ".flv", ".wmv", ".mpg", ".mpeg", ".3gp", ".ts", ".m2ts", ".ogv"]) {
      const song = await p.uploadAudio({
        buffer: Buffer.from("not really a video"),
        originalName: `clip${ext}`,
        mimeType: "video/mp4",
      });
      expect(song.platform).toBe("local");
      expect(song.name).toBe("clip");
    }
  });

  it("refuses a .m4v raw video elementary stream, which by definition has no audio", async () => {
    // .m4v is not a container — ffmpeg's rawvideo demuxer opens arbitrary
    // bytes as an MPEG-4 video elementary stream, so it IS recognised and
    // genuinely carries no audio track. Refusing it is the correct outcome,
    // and it is the one case that distinguishes `recognized` from `probed`.
    const p = new LocalMusicProvider(dir);
    await expect(
      p.uploadAudio({
        buffer: Buffer.from("not really a video"),
        originalName: "clip.m4v",
        mimeType: "video/x-m4v",
      }),
    ).rejects.toThrow(/音轨/);
  });

  it("the error message names both audio and video formats", async () => {
    const p = new LocalMusicProvider(dir);
    await expect(
      p.uploadAudio({ buffer: Buffer.from("x"), originalName: "a.exe" }),
    ).rejects.toThrow(/视频/);
  });
});

describe("parseMediaProbe (#149)", () => {
  const mp4Banner = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':
  Duration: 00:03:27.15, start: 0.000000, bitrate: 1105 kb/s
  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1280x720, 30 fps
  Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo, fltp, 192 kb/s`;

  it("reads duration and detects the audio stream in a video container", () => {
    const r = parseMediaProbe(mp4Banner);
    expect(r.durationSeconds).toBe(3 * 60 + 27);
    expect(r.hasAudio).toBe(true);
  });

  it("reports hasAudio false for a video with only a video stream", () => {
    const silent = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'silent.mp4':
  Duration: 00:00:02.00, start: 0.000000, bitrate: 29 kb/s
  Stream #0:0[0x1](und): Video: h264 (High 4:4:4 Predictive), yuv444p, 160x120, 10 fps`;
    const r = parseMediaProbe(silent);
    expect(r.durationSeconds).toBe(2);
    expect(r.hasAudio).toBe(false);
  });

  it("detects a plain audio file", () => {
    const r = parseMediaProbe(`Input #0, mp3, from 'a.mp3':
  Duration: 00:00:30.02, start: 0.000000, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s`);
    expect(r.durationSeconds).toBe(30);
    expect(r.hasAudio).toBe(true);
  });

  it("does not mistake an attached cover image for an audio stream", () => {
    const r = parseMediaProbe(`Input #0, mp3, from 'cover.mp3':
  Duration: 00:00:10.00, start: 0.000000, bitrate: 130 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc), 100x100 [attached pic]`);
    expect(r.hasAudio).toBe(true);
  });

  it("returns zeros on unparseable output rather than throwing", () => {
    const r = parseMediaProbe("ffmpeg: command exploded");
    expect(r.durationSeconds).toBe(0);
    expect(r.hasAudio).toBe(false);
    expect(r.recognized).toBe(false);
  });

  // The distinction that decides whether an upload is refused: ffmpeg opened
  // the file and found no audio (refuse) vs ffmpeg could not open it at all
  // (accept, as it always has for truncated audio).
  it("marks a readable container recognized and unreadable bytes not", () => {
    expect(parseMediaProbe(mp4Banner).recognized).toBe(true);
    expect(parseMediaProbe(`[mov,mp4,m4a,3gp,3g2,mj2 @ 0x1] moov atom not found
[in#0 @ 0x2] Error opening input: Invalid data found when processing input
Error opening input file junk.mp4.`).recognized).toBe(false);
  });

  it("rounds fractional durations", () => {
    expect(parseMediaProbe("Duration: 00:00:03.60,").durationSeconds).toBe(4);
    expect(parseMediaProbe("Duration: 01:02:03.10,").durationSeconds).toBe(3723);
  });
});

describe("LocalMusicProvider quota", () => {
  it("evicts oldest unreferenced uploads beyond maxFiles", async () => {
    const a = makeRecord("a");
    const b = makeRecord("b");
    seed([b, a]); // newest-first: b newer than a
    const p = new LocalMusicProvider(dir, { maxFiles: 2 });
    p.setInUseResolver(() => new Set<string>());

    // Upload a third valid file → over the 2-file cap → evict the oldest ("a").
    await p.uploadAudio({
      buffer: Buffer.alloc(16, 7),
      originalName: "c.mp3",
      mimeType: "audio/mpeg",
    });

    expect(existsSync(a.filePath)).toBe(false); // oldest evicted
    expect(existsSync(b.filePath)).toBe(true);
    const result = await p.search("");
    expect(result.songs.map((s) => s.id).sort()).not.toContain("a");
  });

  it("does not evict a referenced upload even when over the cap", async () => {
    const a = makeRecord("a");
    const b = makeRecord("b");
    seed([b, a]);
    const p = new LocalMusicProvider(dir, { maxFiles: 1 });
    p.setInUseResolver(() => new Set<string>(["a"])); // "a" is queued

    await p.uploadAudio({
      buffer: Buffer.alloc(16, 7),
      originalName: "c.mp3",
      mimeType: "audio/mpeg",
    });

    expect(existsSync(a.filePath)).toBe(true); // protected: still queued
  });

  it("never evicts the just-uploaded file, even when every older file is referenced", async () => {
    const a = makeRecord("a");
    seed([a]);
    const p = new LocalMusicProvider(dir, { maxFiles: 1 });
    p.setInUseResolver(() => new Set<string>(["a"])); // the only older file is queued

    const song = await p.uploadAudio({
      buffer: Buffer.alloc(16, 7),
      originalName: "c.mp3",
      mimeType: "audio/mpeg",
    });

    // The returned song must actually exist and be playable — not a phantom.
    expect(await p.getSongUrl(song.id)).not.toBeNull();
  });
});

describe("LocalMusicProvider search pagination", () => {
  it("slices [offset, offset+limit) instead of the first page", async () => {
    const recs = ["a", "b", "c", "d"].map((id) => makeRecord(id));
    seed(recs); // newest-first order preserved: a, b, c, d
    const p = new LocalMusicProvider(dir);

    const page1 = await p.search("", 2); // offset defaults to 0
    expect(page1.songs.map((s) => s.id)).toEqual(["a", "b"]);

    const page2 = await p.search("", 2, 2);
    expect(page2.songs.map((s) => s.id)).toEqual(["c", "d"]);
  });
});

describe("LocalMusicProvider filename handling", () => {
  it("accepts a long filename without dropping its extension", async () => {
    const p = new LocalMusicProvider(dir);
    const longName = "x".repeat(300) + ".mp3";
    // Must not throw the "unsupported format" error — the extension survives.
    const song = await p.uploadAudio({
      buffer: Buffer.alloc(16, 1),
      originalName: longName,
      mimeType: "audio/mpeg",
    });
    expect(song.id).toBeTruthy();
    expect(await p.getSongUrl(song.id)).not.toBeNull();
  });
});

// #149 end-to-end: build real containers with the bundled ffmpeg and push
// them through the actual upload path. Skipped automatically if the binary is
// unavailable, so the suite still runs on a machine without it.
describe("LocalMusicProvider video upload, end to end (#149)", () => {
  const ffmpeg: string | null = (() => {
    try {
      return createRequire(import.meta.url)("ffmpeg-static") as string;
    } catch {
      return null;
    }
  })();

  const have = !!ffmpeg && spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0;

  /** Render a real container into the temp dir and return its bytes. */
  function render(name: string, args: string[]): Buffer {
    const out = join(dir, name);
    const r = spawnSync(ffmpeg!, ["-y", "-hide_banner", "-loglevel", "error", ...args, out], {
      stdio: "ignore",
    });
    if (r.status !== 0) throw new Error(`fixture render failed: ${name}`);
    const buf = readFileSync(out);
    rmSync(out, { force: true }); // upload writes its own copy
    return buf;
  }

  const withAudio = (dur: number, vcodec: string, acodec: string) => [
    "-f", "lavfi", "-i", `testsrc=s=160x120:r=10:d=${dur}`,
    "-f", "lavfi", "-i", `sine=f=440:d=${dur}`,
    "-c:v", vcodec, "-c:a", acodec, "-shortest",
  ];

  it.runIf(have)("accepts an mp4, reads its duration, and keeps only the audio", async () => {
    const p = new LocalMusicProvider(dir);
    const mp4 = render("src.mp4", withAudio(3, "libx264", "aac"));
    const song = await p.uploadAudio({
      buffer: mp4, originalName: "My Clip.mp4", mimeType: "video/mp4",
    });

    expect(song.name).toBe("My Clip");
    expect(song.platform).toBe("local");
    expect(song.duration).toBe(3);

    const resolved = await p.getSongUrl(song.id);
    expect(resolved).not.toBeNull();
    // The video container is gone; what remains is the extracted audio track.
    // AAC (what libx264+aac mp4s carry) goes to .m4a so the encoder-priming
    // edit list survives — see extractedAudioExt.
    expect(resolved!.url.endsWith(".m4a")).toBe(true);
    expect(existsSync(join(dir, `${song.id}.mp4`))).toBe(false);
    expect(existsSync(resolved!.url)).toBe(true);
    expect(statSync(resolved!.url).size).toBeGreaterThan(0);
    expect(statSync(resolved!.url).size).toBeLessThan(mp4.length);
  }, 60000);

  it.runIf(have)("extracted audio is still decodable by the player's ffmpeg args", async () => {
    const p = new LocalMusicProvider(dir);
    const song = await p.uploadAudio({
      buffer: render("src2.mp4", withAudio(2, "libx264", "aac")),
      originalName: "clip.mp4",
      mimeType: "video/mp4",
    });
    const url = (await p.getSongUrl(song.id))!.url;

    const decoded = spawnSync(
      ffmpeg!,
      [...buildFfmpegArgs(url, 0).slice(0, -1), "-"],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    expect(decoded.status).toBe(0);
    // 2s of 48 kHz stereo s16le ≈ 384000 bytes; allow codec priming slack.
    expect(decoded.stdout.length).toBeGreaterThan(300000);
  }, 60000);

  it.runIf(have)("aac extraction decodes bit-for-bit identically to the audio inside the video", async () => {
    // The strongest statement of "lossless": decode the audio track straight
    // out of the source mp4, decode the stored extract, compare the PCM.
    // A Matroska remux would NOT pass this — it loses the MP4 edit list that
    // discards AAC encoder priming, so it decodes ~23 ms longer.
    const p = new LocalMusicProvider(dir);
    const bytes = render("bitexact.mp4", withAudio(4, "libx264", "aac"));
    const sourceCopy = join(dir, "source-kept.mp4");
    writeFileSync(sourceCopy, bytes);

    const song = await p.uploadAudio({
      buffer: bytes, originalName: "bitexact.mp4", mimeType: "video/mp4",
    });
    const url = (await p.getSongUrl(song.id))!.url;

    const toPcm = (input: string, pre: string[] = []) => spawnSync(
      ffmpeg!,
      ["-hide_banner", "-loglevel", "error", "-i", input, ...pre,
       "-f", "s16le", "-ar", "48000", "-ac", "2", "-acodec", "pcm_s16le", "-"],
      { maxBuffer: 128 * 1024 * 1024 },
    );

    const fromVideo = toPcm(sourceCopy, ["-vn", "-map", "0:a:0"]);
    const fromExtract = toPcm(url);
    expect(fromVideo.status).toBe(0);
    expect(fromExtract.status).toBe(0);
    expect(fromExtract.stdout.length).toBe(fromVideo.stdout.length);
    expect(fromExtract.stdout.equals(fromVideo.stdout)).toBe(true);
  }, 90000);

  it.runIf(have)("refuses a video that genuinely has no audio track", async () => {
    const p = new LocalMusicProvider(dir);
    const silent = render("silent.mp4", [
      "-f", "lavfi", "-i", "testsrc=s=160x120:r=10:d=2", "-an",
    ]);
    await expect(
      p.uploadAudio({ buffer: silent, originalName: "silent.mp4", mimeType: "video/mp4" }),
    ).rejects.toThrow(/音轨/);
    // The rejected upload must not leave its bytes behind.
    expect(readdirSync(dir).filter((f) => f.endsWith(".mp4"))).toEqual([]);
  }, 60000);

  it.runIf(have)("extracts losslessly from avi/mkv/flv too, not just mp4", async () => {
    const p = new LocalMusicProvider(dir);
    const cases: Array<[string, string[]]> = [
      ["a.avi", withAudio(2, "mpeg4", "libmp3lame")],
      ["a.mkv", withAudio(2, "libx264", "libopus")],
      ["a.flv", withAudio(2, "flv", "libmp3lame")],
    ];
    for (const [name, args] of cases) {
      const song = await p.uploadAudio({
        buffer: render(`src-${name}`, args), originalName: name, mimeType: "video/x-msvideo",
      });
      const url = (await p.getSongUrl(song.id))!.url;
      expect(url.endsWith(".mka")).toBe(true);
      expect(statSync(url).size).toBeGreaterThan(0);
    }
  }, 120000);

  it.runIf(have)("a plain audio upload is untouched — no extraction, original extension kept", async () => {
    const p = new LocalMusicProvider(dir);
    const mp3 = render("src.mp3", ["-f", "lavfi", "-i", "sine=f=440:d=2", "-c:a", "libmp3lame"]);
    const song = await p.uploadAudio({ buffer: mp3, originalName: "tune.mp3", mimeType: "audio/mpeg" });
    const url = (await p.getSongUrl(song.id))!.url;
    expect(url.endsWith(".mp3")).toBe(true);
    expect(statSync(url).size).toBe(mp3.length); // byte-identical, not remuxed
  }, 60000);
});
