import { describe, expect, it, vi } from "vitest";
import { RiskControlError, SongUrlUnavailable, toPlayFailure } from "../music/provider.js";
import type { SongUrlResult } from "../music/provider.js";
import {
  MAX_URL_RETRIES,
  DEFAULT_URL_RETRY_BACKOFF_MS,
  QUALITY_SWITCH_BACKOFF_MS,
  RISK_CONTROL_BACKOFF_MS,
  normalizeRetryCount,
  resolveUrlWithRetry,
} from "./url-retry.js";

const ok = (url = "https://cdn.example/track.mp3"): SongUrlResult => ({ url });

/** Sleep stand-in that records the delays instead of waiting. */
function recordingSleep() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

describe("normalizeRetryCount", () => {
  it("accepts 0..MAX and truncates fractions", () => {
    expect(normalizeRetryCount(0)).toBe(0);
    expect(normalizeRetryCount(2)).toBe(2);
    expect(normalizeRetryCount(2.9)).toBe(2);
  });

  it("clamps out-of-range numbers", () => {
    expect(normalizeRetryCount(-3)).toBe(0);
    expect(normalizeRetryCount(99)).toBe(MAX_URL_RETRIES);
  });

  // Garbage means "old behaviour" (fail fast), not "retry forever".
  it("treats non-numeric values as zero", () => {
    expect(normalizeRetryCount(undefined)).toBe(0);
    expect(normalizeRetryCount(null)).toBe(0);
    expect(normalizeRetryCount("3")).toBe(0);
    expect(normalizeRetryCount(Number.NaN)).toBe(0);
    expect(normalizeRetryCount(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("resolveUrlWithRetry", () => {
  it("makes exactly one attempt when retries is 0", async () => {
    const resolve = vi.fn(async () => null);
    const { sleep } = recordingSleep();
    const result = await resolveUrlWithRetry({ retries: 0, resolve, sleep });
    expect(result).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  // The reported bug: first click fails, third works. A retry inside one
  // request turns that into a normal play.
  it("succeeds on a later attempt and stops retrying", async () => {
    const resolve = vi
      .fn<() => Promise<SongUrlResult | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ok());
    const { sleep } = recordingSleep();

    const result = await resolveUrlWithRetry({ retries: 2, resolve, sleep });

    expect(result).toEqual(ok());
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it("gives up after 1 + retries attempts", async () => {
    const resolve = vi.fn(async () => null);
    const { sleep, delays } = recordingSleep();

    const result = await resolveUrlWithRetry({ retries: 2, resolve, sleep });

    expect(result).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(3);
    // Linear backoff: one wait before attempt 2, two units before attempt 3.
    expect(delays).toEqual([DEFAULT_URL_RETRY_BACKOFF_MS, DEFAULT_URL_RETRY_BACKOFF_MS * 2]);
  });

  // A timeout from the local API sidecar looks identical to the user, so a
  // throw is retried exactly like an empty result.
  it("retries after a thrown error", async () => {
    const resolve = vi
      .fn<() => Promise<SongUrlResult | null>>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(ok("https://cdn.example/retry.mp3"));
    const { sleep } = recordingSleep();

    const result = await resolveUrlWithRetry({ retries: 1, resolve, sleep });

    expect(result?.url).toBe("https://cdn.example/retry.mp3");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("returns null when every attempt throws", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("boom");
    });
    const { sleep } = recordingSleep();

    expect(await resolveUrlWithRetry({ retries: 2, resolve, sleep })).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it("does not start when already cancelled", async () => {
    const resolve = vi.fn(async () => ok());
    const result = await resolveUrlWithRetry({
      retries: 3,
      resolve,
      isCancelled: () => true,
      sleep: async () => {},
    });
    expect(result).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  // Stopping mid-budget must not keep hammering the API for a track nobody
  // wants any more.
  it("aborts after cancellation during the backoff", async () => {
    const resolve = vi.fn(async () => null);
    let cancelled = false;
    const sleep = async () => {
      cancelled = true; // user hit stop while we waited
    };

    const result = await resolveUrlWithRetry({
      retries: 3,
      resolve,
      isCancelled: () => cancelled,
      sleep,
    });

    expect(result).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("reports every failed attempt once, with the error when there was one", async () => {
    const failures: Array<{ attempt: number; total: number; error?: unknown }> = [];
    const boom = new Error("boom");
    const resolve = vi
      .fn<() => Promise<SongUrlResult | null>>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce(null);
    const { sleep } = recordingSleep();

    await resolveUrlWithRetry({
      retries: 2,
      resolve,
      sleep,
      onAttemptFailed: (info) => failures.push(info),
    });

    expect(failures).toHaveLength(3);
    expect(failures[0]).toEqual({ attempt: 1, total: 3, error: undefined });
    expect(failures[1]).toEqual({ attempt: 2, total: 3, error: boom });
    expect(failures[2]).toEqual({ attempt: 3, total: 3, error: undefined });
  });

  it("does not report a failure for the attempt that succeeded", async () => {
    const onAttemptFailed = vi.fn();
    const resolve = vi
      .fn<() => Promise<SongUrlResult | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ok());
    const { sleep } = recordingSleep();

    await resolveUrlWithRetry({ retries: 1, resolve, sleep, onAttemptFailed });

    expect(onAttemptFailed).toHaveBeenCalledTimes(1);
  });

  it("honours a custom backoff", async () => {
    const { sleep, delays } = recordingSleep();
    await resolveUrlWithRetry({
      retries: 2,
      backoffMs: 10,
      resolve: async () => null,
      sleep,
    });
    expect(delays).toEqual([10, 20]);
  });

  // An empty-string URL is as useless as null: the player would fail later.
  it("treats a result without a url as a failure", async () => {
    const resolve = vi
      .fn<() => Promise<SongUrlResult | null>>()
      .mockResolvedValueOnce({ url: "" })
      .mockResolvedValueOnce(ok());
    const { sleep } = recordingSleep();

    const result = await resolveUrlWithRetry({ retries: 1, resolve, sleep });
    expect(result?.url).toBe(ok().url);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Quality fallback
//
// Regression for «点四五次才能播»: NetEase's ladder is discontinuous, so a
// track that plays at 192k can return null at BOTH 320k (the default) and 128k.
// Retrying the same level can never fix that — the level has to change.
// ---------------------------------------------------------------------------
describe("resolveUrlWithRetry — quality fallback", () => {
  it("sweeps the fallback levels after the primary budget is spent", async () => {
    const seen: Array<string | undefined> = [];
    const resolve = vi.fn(async (quality?: string) => {
      seen.push(quality);
      // Only "higher" ever works; the configured level never does.
      return quality === "higher" ? ok("https://cdn.example/192.mp3") : null;
    });
    const { sleep } = recordingSleep();

    const result = await resolveUrlWithRetry({
      retries: 1,
      resolve,
      fallbacks: ["higher", "standard"],
      sleep,
    });

    expect(result?.url).toBe("https://cdn.example/192.mp3");
    // primary, primary retry, then higher — and stops there.
    expect(seen).toEqual([undefined, undefined, "higher"]);
  });

  it("tries every fallback in order when none of them work", async () => {
    const seen: Array<string | undefined> = [];
    const resolve = vi.fn(async (quality?: string) => {
      seen.push(quality);
      return null;
    });
    const { sleep } = recordingSleep();

    const result = await resolveUrlWithRetry({
      retries: 1,
      resolve,
      fallbacks: ["higher", "standard"],
      sleep,
    });

    expect(result).toBeNull();
    expect(seen).toEqual([undefined, undefined, "higher", "standard"]);
  });

  it("does not touch fallbacks when the configured level succeeds", async () => {
    const resolve = vi.fn(async () => ok());
    const { sleep } = recordingSleep();

    await resolveUrlWithRetry({ retries: 3, resolve, fallbacks: ["higher"], sleep });

    expect(resolve).toHaveBeenCalledTimes(1);
  });

  // A level switch is a different request, so it must not wait out a full
  // same-quality backoff — otherwise a broken 320k track stalls for seconds.
  it("uses the short switch delay between levels", async () => {
    const { sleep, delays } = recordingSleep();
    await resolveUrlWithRetry({
      retries: 1,
      resolve: async () => null,
      fallbacks: ["higher", "standard"],
      sleep,
    });
    expect(delays).toEqual([
      DEFAULT_URL_RETRY_BACKOFF_MS, // primary → primary retry
      QUALITY_SWITCH_BACKOFF_MS, // retry → higher
      QUALITY_SWITCH_BACKOFF_MS, // higher → standard
    ]);
  });

  it("reports which quality each failed attempt used", async () => {
    const failures: Array<{ quality?: string }> = [];
    const { sleep } = recordingSleep();

    await resolveUrlWithRetry({
      retries: 0,
      resolve: async () => null,
      fallbacks: ["higher", "standard"],
      sleep,
      onAttemptFailed: (info) => failures.push(info),
    });

    expect(failures.map((f) => f.quality)).toEqual([undefined, "higher", "standard"]);
  });

  it("still works when no fallbacks are supplied", async () => {
    const resolve = vi.fn(async () => null);
    const { sleep } = recordingSleep();
    const result = await resolveUrlWithRetry({ retries: 2, resolve, sleep });
    expect(result).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it("aborts mid-sweep when the caller is cancelled", async () => {
    const resolve = vi.fn(async () => null);
    let cancelled = false;
    const sleep = async () => {
      cancelled = true;
    };

    const result = await resolveUrlWithRetry({
      retries: 0,
      resolve,
      fallbacks: ["higher", "standard"],
      isCancelled: () => cancelled,
      sleep,
    });

    expect(result).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// NetEase risk control (-460)
//
// Measured against a live host: `GET /song/url/v1?id=…&level=exhigh` without
// the account cookie answers 400 `{"code":-460,"message":"检测到您的网络环境存在
// 风险，请稍后再试"}` every single time, while the same call WITH the cookie
// answers 200. Intermittently it also rejects the cookie call — that is the
// "click play five times until it works" report.
//
// Because -460 is a 400, the normal 250ms re-poke lands inside the same risk
// window and the whole budget is wasted. These tests pin the longer wait.
// ---------------------------------------------------------------------------
describe("resolveUrlWithRetry — risk control backoff", () => {
  it("grows the wait from RISK_CONTROL_BACKOFF_MS instead of 250ms", async () => {
    const { sleep, delays } = recordingSleep();
    const result = await resolveUrlWithRetry({
      retries: 2,
      resolve: async () => {
        throw new RiskControlError("网络环境风险 (-460)");
      },
      sleep,
    });

    expect(result).toBeNull();
    expect(delays).toEqual([RISK_CONTROL_BACKOFF_MS, RISK_CONTROL_BACKOFF_MS * 2]);
    // Every one of them is longer than a plain transient retry would have been.
    for (const d of delays) expect(d).toBeGreaterThan(DEFAULT_URL_RETRY_BACKOFF_MS);
  });

  it("does not fall back to the fast level-switch delay while risk controlled", async () => {
    const { sleep, delays } = recordingSleep();
    await resolveUrlWithRetry({
      retries: 0,
      resolve: async () => {
        throw new RiskControlError("网络环境风险 (-460)");
      },
      fallbacks: ["higher", "standard"],
      sleep,
    });

    // -460 ignores which quality we ask for, so 120ms would just burn attempts.
    expect(delays).toEqual([RISK_CONTROL_BACKOFF_MS, RISK_CONTROL_BACKOFF_MS]);
    expect(delays).not.toContain(QUALITY_SWITCH_BACKOFF_MS);
  });

  it("recovers as soon as the window passes, and stops spending", async () => {
    let attempts = 0;
    const { sleep, delays } = recordingSleep();
    const result = await resolveUrlWithRetry({
      retries: 3,
      resolve: async () => {
        attempts += 1;
        if (attempts < 3) throw new RiskControlError("网络环境风险 (-460)");
        return ok("https://cdn.example/after-window.mp3");
      },
      sleep,
    });

    expect(result?.url).toBe("https://cdn.example/after-window.mp3");
    expect(attempts).toBe(3);
    expect(delays).toHaveLength(2);
  });

  it("still uses the short delay for a plain error", async () => {
    const { sleep, delays } = recordingSleep();
    await resolveUrlWithRetry({
      retries: 1,
      resolve: async () => {
        throw new Error("boom");
      },
      sleep,
    });
    expect(delays).toEqual([DEFAULT_URL_RETRY_BACKOFF_MS]);
  });

  it("cancels during a risk-control wait", async () => {
    let cancelled = false;
    const result = await resolveUrlWithRetry({
      retries: 3,
      resolve: async () => {
        throw new RiskControlError("网络环境风险 (-460)");
      },
      isCancelled: () => cancelled,
      sleep: async () => {
        cancelled = true;
      },
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reporting why the budget ran out
//
// The caller needs a cause, not just `null`: the web layer used to print
// 「无法播放（区域/版权限制）」 for every outcome, including a lapsed membership and
// a quality the account cannot stream. `onExhausted` is how the cause survives
// the retry loop.
// ---------------------------------------------------------------------------
describe("resolveUrlWithRetry — reporting the cause", () => {
  function unavailable(code: any, message = "某原因") {
    return new SongUrlUnavailable({ platform: "netease", songId: "1", code, message });
  }

  it("hands back the last error once the budget is spent", async () => {
    const seen: Array<{ quality?: string; error: unknown }> = [];
    const err = unavailable("vip_required");
    const { sleep } = recordingSleep();

    const result = await resolveUrlWithRetry({
      retries: 2,
      resolve: async () => {
        throw err;
      },
      sleep,
      onExhausted: (info) => seen.push(info),
    });

    expect(result).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0].error).toBe(err);
    expect(toPlayFailure("netease", "1", seen[0].error).code).toBe("vip_required");
  });

  it("reports the level it gave up on, not the first one", async () => {
    const seen: Array<{ quality?: string; error: unknown }> = [];
    const { sleep } = recordingSleep();

    await resolveUrlWithRetry({
      retries: 0,
      resolve: async (quality) => {
        if (quality === "standard") throw unavailable("quality_denied");
        return null;
      },
      fallbacks: ["higher", "standard"],
      sleep,
      onExhausted: (info) => seen.push(info),
    });

    expect(seen[0].quality).toBe("standard");
  });

  it("stays silent when a level finally works", async () => {
    const seen: unknown[] = [];
    const { sleep } = recordingSleep();

    const result = await resolveUrlWithRetry({
      retries: 1,
      resolve: async (quality) => {
        if (quality === "higher") return ok();
        throw unavailable("quality_denied");
      },
      fallbacks: ["higher"],
      sleep,
      onExhausted: (info) => seen.push(info),
    });

    expect(result?.url).toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  // Pressing stop is not a failure. Reporting one would flash an error toast at
  // a user who just changed their mind.
  it("stays silent when the caller cancels", async () => {
    const seen: unknown[] = [];
    let cancelled = false;

    await resolveUrlWithRetry({
      retries: 3,
      resolve: async () => {
        throw unavailable("risk_control");
      },
      isCancelled: () => cancelled,
      sleep: async () => {
        cancelled = true;
      },
      onExhausted: (info) => seen.push(info),
    });

    expect(seen).toHaveLength(0);
  });

  // Providers that have not adopted SongUrlUnavailable still return null.
  it("still reports for a provider that returns null without throwing", async () => {
    const seen: Array<{ quality?: string; error: unknown }> = [];
    const { sleep } = recordingSleep();

    await resolveUrlWithRetry({
      retries: 0,
      resolve: async () => null,
      sleep,
      onExhausted: (info) => seen.push(info),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].error).toBeUndefined();
  });
});
