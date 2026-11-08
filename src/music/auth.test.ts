import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCookieStore } from "./auth.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cookie-store-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The blob a live deployment actually had on disk (abridged). */
const BLOB =
  "MUSIC_A_T=1456043741268; Max-Age=2147483647; Expires=Thu, 25 Nov 2094 21:48:40 GMT; Path=/api/clientlog;" +
  ";MUSIC_R_T=1456043923317; Max-Age=2147483647; Expires=Thu, 25 Nov 2094 21:48:40 GMT; Path=/eapi/feedback;" +
  ";MUSIC_U=00ABCDEF0123456789abcdef; Max-Age=1296000; Path=/";

describe("cookie store", () => {
  it("normalises on save, so a pasted header never reaches the file", () => {
    const store = createCookieStore(dir);
    store.save("netease", BLOB);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "netease.json"), "utf-8"));
    expect(onDisk.cookie).toBe("MUSIC_A_T=1456043741268; MUSIC_R_T=1456043923317; MUSIC_U=00ABCDEF0123456789abcdef");
    expect(onDisk.cookie).not.toContain("Max-Age");
  });

  it("repairs a file that was already written by an older build", () => {
    const file = path.join(dir, "netease.json");
    fs.writeFileSync(file, JSON.stringify({ cookie: BLOB }), "utf-8");

    const store = createCookieStore(dir);
    expect(store.load("netease")).toBe(
      "MUSIC_A_T=1456043741268; MUSIC_R_T=1456043923317; MUSIC_U=00ABCDEF0123456789abcdef",
    );
    // Written back, so the next start does not have to repair it again.
    const onDisk = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(onDisk.cookie).not.toContain("Path=");
  });

  it("keeps a valid cookie byte-for-byte and does not rewrite the file", () => {
    const file = path.join(dir, "netease.json");
    const valid = "MUSIC_U=abc; __csrf=def";
    fs.writeFileSync(file, JSON.stringify({ cookie: valid, updatedAt: "2026-01-01T00:00:00.000Z" }), "utf-8");
    const before = fs.readFileSync(file, "utf-8");

    expect(createCookieStore(dir).load("netease")).toBe(valid);
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
  });

  // jellyfin stores JSON (token / userId / deviceId), not a cookie header.
  // Normalising it would shred every '=' and comma in the payload.
  it("leaves the jellyfin credential blob untouched", () => {
    const blob = JSON.stringify({ accessToken: "a=b", userId: "u1", deviceId: "d1" });
    const store = createCookieStore(dir);
    store.save("jellyfin", blob);
    expect(store.load("jellyfin")).toBe(blob);
  });

  it("returns an empty string for a missing or corrupt file", () => {
    const store = createCookieStore(dir);
    expect(store.load("qq")).toBe("");
    fs.writeFileSync(path.join(dir, "qq.json"), "{not json", "utf-8");
    expect(store.load("qq")).toBe("");
  });
});
