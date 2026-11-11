import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Logger } from "../logger.js";
import type { QrCodeResult } from "./provider.js";
import { hasQqRenewalMaterial, parseQqCredential, qqPlaybackCookie, type QqCredential, type QqLoginClient, type QqPollResult } from "./qq-login.js";

interface QqSessionRecord {
  cookie: string;
  credential?: QqCredential;
  reauthRequired?: boolean;
  authorizedAt?: number;
  lastRefreshAt?: number;
}

type QrStatus = QqPollResult["status"];
export type QqRenewalStatus = "cookie_only" | "scheduled" | "retrying" | "reauth_required";
export type QqRenewalResult = "refreshed" | "reauth_required" | "upstream_error" | "rate_limited" | "persist_failed" | "cooldown" | "superseded";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const QR_TTL = 3 * MINUTE;

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15
    ? value : undefined;
}

function expiryTime(credential: QqCredential): number | undefined {
  if (!credential.musickeyCreateTime || !credential.keyExpiresIn) return;
  return timestamp((credential.musickeyCreateTime + credential.keyExpiresIn) * 1000);
}

export function createQqSessionStore(file: string, legacyFile?: string) {
  function loadLegacy(newerThan = -Infinity): QqSessionRecord | undefined {
    if (!legacyFile) return;
    try {
      if (fs.statSync(legacyFile).mtimeMs <= newerThan) return;
      const { cookie } = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
      if (typeof cookie === "string" && cookie) return { cookie };
    } catch { /* The legacy cookie is missing or unreadable. */ }
  }

  return {
    load(): QqSessionRecord | undefined {
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return loadLegacy();
        throw err;
      }
      const data = JSON.parse(raw);
      if (data?.version !== 1 || typeof data.cookie !== "string") throw new Error("Invalid QQ session record");
      // Before the stores were shared, a newer login could be in the legacy file.
      if (data.shared !== true && legacyFile) {
        const legacy = loadLegacy(fs.statSync(file).mtimeMs);
        if (legacy) return legacy;
      }
      const credential = parseQqCredential(data.credential);
      if (data.credential && (!credential || qqPlaybackCookie(credential) !== data.cookie)) {
        throw new Error("Invalid QQ session credential");
      }
      return {
        cookie: data.cookie,
        credential,
        reauthRequired: data.reauthRequired === true,
        authorizedAt: timestamp(data.authorizedAt),
        lastRefreshAt: timestamp(data.lastRefreshAt),
      };
    },
    save(data: QqSessionRecord): void {
      const temp = path.join(path.dirname(file), `.qq-session-${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temp, JSON.stringify({ version: 1, shared: true, ...data }), {
          encoding: "utf8", mode: 0o600, flag: "wx", flush: true,
        });
        fs.renameSync(temp, file);
      } finally {
        try { fs.unlinkSync(temp); } catch { /* Already renamed or unavailable. */ }
      }
    },
  };
}

interface ActiveQr {
  key: string;
  sig: string;
  expiresAt: number;
  terminal?: "confirmed" | "expired";
  poll?: Promise<QrStatus>;
}

export class QQManagedSession {
  private state: QqSessionRecord = { cookie: "" };
  private generation = 0;
  private qrGeneration = 0;
  private qr?: ActiveQr;
  private inFlight?: Promise<QqRenewalResult>;
  private pending?: { record: QqSessionRecord; result: "refreshed" | "reauth_required" };
  private timer?: ReturnType<typeof setTimeout>;
  private retryAt?: number;
  private nextAttempt?: number;
  private failures = 0;
  private stopped = false;

  constructor(
    private readonly client: QqLoginClient,
    private readonly store: ReturnType<typeof createQqSessionStore>,
    private readonly logger: Logger,
  ) {
    try {
      const saved = store.load();
      if (saved) this.state = saved;
    } catch {
      logger.warn("Could not read QQ managed session");
    }
    this.schedule();
  }

  getCookie(): string {
    return this.state.cookie;
  }

  getStatus(): { renewalStatus: QqRenewalStatus; nextRefreshAt: string | null; lastRefreshAt: string | null } {
    const renewalStatus = this.retryAt ? "retrying"
      : this.state.reauthRequired ? "reauth_required"
      : !hasQqRenewalMaterial(this.state.credential) ? "cookie_only"
      : "scheduled";
    const { lastRefreshAt } = this.state;
    return {
      renewalStatus,
      nextRefreshAt: this.nextAttempt === undefined ? null : new Date(this.nextAttempt).toISOString(),
      lastRefreshAt: lastRefreshAt === undefined ? null : new Date(lastRefreshAt).toISOString(),
    };
  }

  setCookie(cookie: string): void {
    this.replace({ cookie });
    this.qrGeneration++;
    this.qr = undefined;
  }

  async getQrCode(): Promise<QrCodeResult> {
    const generation = ++this.qrGeneration;
    this.qr = undefined;
    const { img, sig } = await this.client.getQr();
    if (this.stopped || generation !== this.qrGeneration) throw new Error("QQ QR code superseded");
    const key = randomUUID();
    this.qr = { key, sig, expiresAt: Date.now() + QR_TTL };
    return { key, qrUrl: "", qrImg: img };
  }

  async checkQrCodeStatus(key: string): Promise<QrStatus> {
    const qr = this.qr;
    if (!qr || qr.key !== key || this.stopped || qr.expiresAt <= Date.now()) return "expired";
    if (qr.terminal) return qr.terminal;
    qr.poll ??= this.poll(qr).finally(() => { qr.poll = undefined; });
    return qr.poll;
  }

  private async poll(qr: ActiveQr): Promise<QrStatus> {
    const result = await this.client.pollQr(qr.sig);
    if (this.stopped || this.qr !== qr || qr.expiresAt <= Date.now()) return "expired";
    if (result.status === "confirmed") {
      try {
        this.replace({
          cookie: qqPlaybackCookie(result.credential),
          credential: result.credential,
          authorizedAt: Date.now(),
        });
      } catch {
        this.logger.warn("Could not save QQ login");
        return qr.terminal = "expired";
      }
      qr.terminal = "confirmed";
    }
    if (result.status === "expired") qr.terminal = "expired";
    return result.status;
  }

  private replace(record: QqSessionRecord): void {
    this.store.save(record);
    this.state = record;
    this.generation++;
    this.inFlight = undefined;
    this.pending = undefined;
    this.retryAt = undefined;
    this.failures = 0;
    this.schedule();
  }

  private schedule(earliest = 0): void {
    clearTimeout(this.timer);
    this.nextAttempt = undefined;
    if (this.stopped) return;
    const credential = this.state.credential;
    this.nextAttempt = this.retryAt;
    if (this.nextAttempt === undefined && !this.state.reauthRequired && hasQqRenewalMaterial(credential)) {
      const now = Date.now();
      // Older session records predate local timestamps. Use QQ's key creation
      // time to establish their first due date without inventing a renewal history.
      const keyCreatedAt = credential.musickeyCreateTime
        ? timestamp(credential.musickeyCreateTime * 1000) : undefined;
      const anchor = this.state.lastRefreshAt ?? this.state.authorizedAt ?? keyCreatedAt;
      const dailyAt = anchor === undefined ? now : Math.min(anchor, now) + DAY;
      const expiresAt = expiryTime(credential);
      const leadTime = Math.min(30 * MINUTE, credential.keyExpiresIn * 100);
      const dueAt = expiresAt === undefined ? dailyAt : Math.min(dailyAt, expiresAt - leadTime);
      this.nextAttempt = Math.max(earliest, now, dueAt);
    }
    if (this.nextAttempt === undefined) return;
    this.timer = setTimeout(() => {
      if (this.nextAttempt !== undefined && Date.now() < this.nextAttempt) this.schedule(earliest);
      else void this.refresh();
    }, Math.min(2 ** 31 - 1, this.nextAttempt - Date.now()));
    this.timer.unref();
  }

  refresh(): Promise<QqRenewalResult> {
    if (this.stopped) return Promise.resolve("superseded");
    if (this.inFlight) return this.inFlight;
    if (this.retryAt && Date.now() < this.retryAt) return Promise.resolve("cooldown");
    if (this.pending) return Promise.resolve(this.commitPending());
    const credential = this.state.credential;
    if (!hasQqRenewalMaterial(credential) || this.state.reauthRequired) return Promise.resolve("reauth_required");
    const generation = this.generation;
    this.inFlight = this.renew(credential, generation).finally(() => {
      if (generation === this.generation) this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async renew(credential: QqCredential, generation: number): Promise<QqRenewalResult> {
    const result = await this.client.refresh(credential).catch(() => ({ status: "upstream_error" } as const));
    if (this.stopped || this.generation !== generation) return "superseded";
    if (result.status === "reauth_required") {
      this.pending = { record: { ...this.state, reauthRequired: true }, result: "reauth_required" };
      return this.commitPending();
    }
    if (result.status === "refreshed") {
      const next = result.credential;
      const renewed = next.musickey !== credential.musickey
        || (expiryTime(next) ?? 0) > (expiryTime(credential) ?? 0)
        || (next.refresh_key && next.refresh_key !== credential.refresh_key)
        || (next.refresh_token && next.refresh_token !== credential.refresh_token);
      if (next.musicid === credential.musicid && renewed) {
        this.pending = {
          record: { cookie: qqPlaybackCookie(next), credential: next, reauthRequired: !hasQqRenewalMaterial(next) },
          result: "refreshed",
        };
        return this.commitPending();
      }
    }
    const outcome = result.status === "rate_limited" ? "rate_limited" : "upstream_error";
    this.defer(outcome);
    return outcome;
  }

  private commitPending(): QqRenewalResult {
    const pending = this.pending!;
    const record = pending.result === "refreshed"
      ? { ...pending.record, lastRefreshAt: Date.now() }
      : pending.record;
    try {
      this.store.save(record);
    } catch {
      this.defer("persist_failed");
      return "persist_failed";
    }
    this.state = record;
    this.pending = undefined;
    this.retryAt = undefined;
    this.failures = 0;
    this.schedule(Date.now() + MINUTE);
    this.logger.info({ outcome: pending.result }, "QQ session renewal");
    return pending.result;
  }

  private defer(outcome: "rate_limited" | "upstream_error" | "persist_failed"): void {
    const initialMinutes = outcome === "rate_limited" ? 15 : 5;
    this.retryAt = Date.now() + Math.min(60, initialMinutes * 2 ** this.failures++) * MINUTE;
    this.schedule();
    this.logger.warn({ outcome }, "QQ session renewal deferred");
  }

  stop(): void {
    this.stopped = true;
    this.schedule();
  }
}
