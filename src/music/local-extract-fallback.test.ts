import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// unlinkSync/rmdirSync are NOT mocked below, so the test's own fixture
// teardown is unaffected by the simulated lock on *.mp4.
import { mkdtempSync, statSync, existsSync, readFileSync, unlinkSync, readdirSync, rmdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #149: when the audio track is extracted successfully but the source video
 * cannot be deleted (Windows keeps files locked briefly — rmSync with
 * force:true still throws EBUSY/EPERM), the record must fall back to the
 * ORIGINAL container completely: both the path AND the recorded size.
 *
 * Committing the size before the delete succeeded would leave the record
 * claiming the small extracted size while still holding the whole video, so
 * totalBytes() under-counts and the upload directory grows past its quota.
 *
 * This lives in its own file because it partially mocks node:fs, which would
 * otherwise leak into every other test in local.test.ts.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    rmSync: (path: string, opts?: object) => {
      // Simulate the lock on the source video only; every other delete
      // (the discarded .mka, temp dirs, the reject path) behaves normally.
      if (typeof path === "string" && path.endsWith(".mp4")) {
        const err = new Error("EBUSY: resource busy or locked") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      return actual.rmSync(path, opts as never);
    },
  };
});

const { LocalMusicProvider } = await import("./local.js");

const ffmpeg: string | null = (() => {
  try {
    return createRequire(import.meta.url)("ffmpeg-static") as string;
  } catch {
    return null;
  }
})();
const have = !!ffmpeg && spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "local-extract-fallback-")); });
afterEach(() => {
  // Recursive teardown without rmSync (mocked above for *.mp4).
  for (const f of readdirSync(dir)) {
    try { unlinkSync(join(dir, f)); } catch { /* best effort */ }
  }
  try { rmdirSync(dir); } catch { /* best effort */ }
});

describe("LocalMusicProvider: source video cannot be deleted after extraction (#149)", () => {
  it.runIf(have)("keeps the original container AND its real size, not the extracted size", async () => {
    const src = join(dir, "fixture.mp4");
    const r = spawnSync(ffmpeg!, [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=s=320x240:r=25:d=3",
      "-f", "lavfi", "-i", "sine=f=440:d=3",
      "-c:v", "libx264", "-b:v", "800k", "-c:a", "aac", "-shortest", src,
    ], { stdio: "ignore" });
    expect(r.status).toBe(0);

    const bytes = readFileSync(src);
    unlinkSync(src); // uploadAudio writes its own copy under a uuid name

    const p = new LocalMusicProvider(dir);
    const song = await p.uploadAudio({
      buffer: bytes, originalName: "fixture.mp4", mimeType: "video/mp4",
    });

    const resolved = await p.getSongUrl(song.id);
    expect(resolved).not.toBeNull();

    // Fell back to the original container — the extract was discarded.
    expect(resolved!.url.endsWith(".mp4")).toBe(true);
    expect(existsSync(resolved!.url)).toBe(true);
    expect(existsSync(resolved!.url.replace(/\.mp4$/, ".m4a"))).toBe(false);
    expect(existsSync(resolved!.url.replace(/\.mp4$/, ".mka"))).toBe(false);

    const onDisk = statSync(resolved!.url).size;
    expect(onDisk).toBe(bytes.length);

    // The RECORDED size drives the quota (totalBytes()), so it must describe
    // the file actually retained. It is not exposed through search()/toSong,
    // but it is persisted to index.json — read it back from there.
    const record = (JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as Array<{
      id: string; size: number; filePath: string;
    }>).find((r) => r.id === song.id);
    expect(record).toBeDefined();
    expect(record!.filePath.endsWith(".mp4")).toBe(true);
    // Before the fix this was the (much smaller) .mka size while the whole
    // .mp4 stayed on disk, so the quota under-counted the retained bytes.
    expect(record!.size).toBe(bytes.length);

    // Sanity: the extract really is much smaller, so a wrong commit order
    // would have been clearly observable rather than a rounding error.
    expect(onDisk).toBeGreaterThan(50_000);
  }, 60000);
});
