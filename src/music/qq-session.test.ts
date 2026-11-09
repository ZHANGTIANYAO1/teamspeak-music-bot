import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qqPlaybackCookie, type QqCredential, type QqLoginClient, type QqRefreshResult } from "./qq-login.js";
import { createQqSessionStore, QQManagedSession } from "./qq-session.js";

const NOW = new Date("2026-11-09T00:00:00.000Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const first: QqCredential = {
  musicid: 123456, musickey: "first-key", refresh_key: "first-refresh",
  openid: "test-openid", access_token: "test-access", refresh_token: "test-refresh",
  expired_at: 123, musickeyCreateTime: NOW.valueOf() / 1000, keyExpiresIn: 3 * DAY / 1000,
};
const second = { ...first, musickey: "second-key", refresh_key: "second-refresh" };

describe("managed QQ session", () => {
  let dir: string;
  let file: string;
  let store: ReturnType<typeof createQqSessionStore>;
  let client: QqLoginClient;
  let session: QQManagedSession;
  const logger = pino({ level: "silent" });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsbot-qq-"));
    file = path.join(dir, "qq-session.json");
    store = createQqSessionStore(file);
    client = {
      getQr: vi.fn().mockResolvedValue({ img: "test-image", sig: "private-qr-sig" }),
      pollQr: vi.fn().mockResolvedValue({ status: "confirmed", credential: first }),
      refresh: vi.fn().mockResolvedValue({ status: "refreshed", credential: second }),
    };
    session = new QQManagedSession(client, store, logger, "uin=123; qm_keyst=legacy");
  });

  afterEach(() => {
    session.stop();
    vi.useRealTimers();
    fs.rmSync(file, { force: true });
    fs.rmdirSync(dir);
  });

  async function scan() {
    const qr = await session.getQrCode();
    expect(qr.key).not.toContain("private-qr-sig");
    expect(await Promise.all([
      session.checkQrCodeStatus(qr.key),
      session.checkQrCodeStatus(qr.key),
    ])).toEqual(["confirmed", "confirmed"]);
    expect(client.pollQr).toHaveBeenCalledTimes(1);
  }

  it("persists the scan, refreshes after 24 hours and keeps the next due date across restarts", async () => {
    await scan();
    expect(store.load()?.credential).toEqual(first);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(session.getStatus()).toEqual({
      renewalStatus: "scheduled",
      nextRefreshAt: new Date(NOW.valueOf() + DAY).toISOString(),
      lastRefreshAt: null,
    });
    await vi.advanceTimersByTimeAsync(DAY / 2);
    session.stop();
    session = new QQManagedSession(client, store, logger, "");
    await vi.advanceTimersByTimeAsync(DAY / 2 - 1);
    expect(client.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.refresh).toHaveBeenCalledWith(first);
    expect(store.load()?.credential).toEqual(second);
    expect(session.getCookie()).toContain("qm_keyst=second-key");
    expect(store.load()?.lastRefreshAt).toBe(NOW.valueOf() + DAY);

    await vi.advanceTimersByTimeAsync(DAY / 2);
    session.stop();
    session = new QQManagedSession(client, store, logger, "");
    expect(session.getStatus()).toEqual({
      renewalStatus: "scheduled",
      nextRefreshAt: new Date(NOW.valueOf() + 2 * DAY).toISOString(),
      lastRefreshAt: new Date(NOW.valueOf() + DAY).toISOString(),
    });
  });

  it("renews before expiry when a QQ key lasts less than one day", async () => {
    const shortLived = { ...first, keyExpiresIn: 3600 };
    vi.mocked(client.pollQr).mockResolvedValueOnce({ status: "confirmed", credential: shortLived });
    await scan();
    await vi.advanceTimersByTimeAsync(54 * MINUTE - 1);
    expect(client.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.refresh).toHaveBeenCalledWith(shortLived);
  });

  it("schedules older saved sessions using QQ's issue time without inventing a last renewal", () => {
    const older = { ...first, musickeyCreateTime: (NOW.valueOf() - DAY / 2) / 1000 };
    store.save({ cookie: qqPlaybackCookie(older), credential: older });
    session.stop();
    session = new QQManagedSession(client, store, logger, "");
    expect(session.getStatus()).toEqual({
      renewalStatus: "scheduled",
      nextRefreshAt: new Date(NOW.valueOf() + DAY / 2).toISOString(),
      lastRefreshAt: null,
    });
  });

  it("shares an in-flight refresh and uses the rotated credential after restart", async () => {
    await scan();
    const a = session.refresh();
    expect(session.refresh()).toBe(a);
    expect(await a).toBe("refreshed");
    expect(client.refresh).toHaveBeenCalledTimes(1);
    session.stop();
    session = new QQManagedSession(client, store, logger, "");
    vi.mocked(client.refresh).mockResolvedValueOnce({
      status: "refreshed", credential: { ...second, musickey: "third-key" },
    });
    expect(await session.refresh()).toBe("refreshed");
    expect(client.refresh).toHaveBeenLastCalledWith(second);
    expect(session.getCookie()).toContain("qm_keyst=third-key");
  });

  it("refreshes a web login with OAuth authorization even when QQ omits refresh_key", async () => {
    const webCredential = { ...first, refresh_key: "" };
    vi.mocked(client.pollQr).mockResolvedValueOnce({ status: "confirmed", credential: webCredential });
    await scan();
    expect(session.getStatus().renewalStatus).toBe("scheduled");
    expect(await session.refresh()).toBe("refreshed");
    expect(client.refresh).toHaveBeenCalledWith(webCredential);
  });

  it("keeps the current cookie on rate limiting and retries after the backoff", async () => {
    await scan();
    vi.mocked(client.refresh).mockResolvedValueOnce({ status: "rate_limited" });
    expect(await session.refresh()).toBe("rate_limited");
    expect(session.getStatus()).toMatchObject({ renewalStatus: "retrying" });
    expect(await session.refresh()).toBe("cooldown");
    expect(store.load()?.credential).toEqual(first);
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(client.refresh).toHaveBeenCalledTimes(2);
    expect(store.load()?.credential).toEqual(second);
  });

  it("retries only the disk write when QQ has already rotated the credential", async () => {
    await scan();
    vi.spyOn(store, "save").mockImplementationOnce(() => { throw new Error("test write failed"); });
    expect(await session.refresh()).toBe("persist_failed");
    expect(session.getCookie()).toContain("qm_keyst=first-key");
    expect(session.getStatus().lastRefreshAt).toBeNull();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(client.refresh).toHaveBeenCalledTimes(1);
    expect(store.load()?.credential).toEqual(second);
    expect(session.getCookie()).toContain("qm_keyst=second-key");
    expect(session.getStatus().lastRefreshAt).toBe(new Date(NOW.valueOf() + 5 * MINUTE).toISOString());
  });

  it("discards a late response when an operator imports another account", async () => {
    await scan();
    let resolve!: (response: QqRefreshResult) => void;
    vi.mocked(client.refresh).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const refresh = session.refresh();
    session.setCookie("uin=999; qm_keyst=manual");
    resolve({ status: "refreshed", credential: second });
    expect(await refresh).toBe("superseded");
    expect(store.load()).toMatchObject({ cookie: "uin=999; qm_keyst=manual" });
    expect(store.load()?.credential).toBeUndefined();
    expect(await session.refresh()).toBe("reauth_required");
  });

  it("does not accept another account from the upstream refresh endpoint", async () => {
    await scan();
    vi.mocked(client.refresh).mockResolvedValueOnce({
      status: "refreshed", credential: { ...second, musicid: 999 },
    });
    expect(await session.refresh()).toBe("upstream_error");
    expect(store.load()?.credential).toEqual(first);
  });

  it("persists a suspension when QQ explicitly rejects renewal", async () => {
    await scan();
    vi.mocked(client.refresh).mockResolvedValueOnce({ status: "reauth_required" });
    expect(await session.refresh()).toBe("reauth_required");
    session.stop();
    session = new QQManagedSession(client, store, logger, "");
    expect(session.getStatus()).toEqual({ renewalStatus: "reauth_required", nextRefreshAt: null, lastRefreshAt: null });
    expect(await session.refresh()).toBe("reauth_required");
    expect(client.refresh).toHaveBeenCalledTimes(1);
    expect(session.getCookie()).toContain("qm_keyst=first-key");
  });

  it("preserves a legacy cookie and renews daily even when QQ omits the key expiration", async () => {
    expect(session.getCookie()).toContain("qm_keyst=legacy");
    expect(session.getStatus()).toEqual({ renewalStatus: "cookie_only", nextRefreshAt: null, lastRefreshAt: null });
    expect(store.load()).toBeUndefined();
    vi.mocked(client.pollQr).mockResolvedValueOnce({
      status: "confirmed", credential: { ...first, musickeyCreateTime: 0, keyExpiresIn: 0 },
    });
    await scan();
    expect(session.getStatus()).toMatchObject({
      renewalStatus: "scheduled",
      nextRefreshAt: new Date(NOW.valueOf() + DAY).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(DAY);
    expect(client.refresh).toHaveBeenCalledTimes(1);
  });
});
