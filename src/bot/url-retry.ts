import { RiskControlError } from "../music/provider.js";
import type { SongUrlResult } from "../music/provider.js";

/**
 * Silent re-resolve of a playable URL.
 *
 * Two different failure modes look identical to the user but need different
 * treatment, so this handles both inside one request:
 *
 *  1. **Transient** — NetEase intermittently answers `url: null` for a song that
 *     resolves fine a moment later. Repeating the SAME request fixes it.
 *  2. **Quality gap** — some tracks have no URL at the configured level while a
 *     different level works. Measured against a real library: a track can be
 *     playable at "higher" (192k) while BOTH "exhigh" (320k) and "standard"
 *     (128k) return null, so a single "drop to the cheapest" step is not enough
 *     — every level below the current one has to be tried.
 *
 * Without either, the user saw 「无法播放（区域/版权限制）」 and had to click play
 * repeatedly until it happened to work.
 *
 * Kept as a standalone function (not a BotInstance method) so the behaviour is
 * testable without booting a bot, and so every caller — web click, chat !play,
 * auto-advance, FM — gets the same budget by construction.
 */

/** Upper bound on retries per quality level, whatever the config says. */
export const MAX_URL_RETRIES = 5;

/** Default delay before retrying the SAME quality; grows linearly (250, 500 …). */
export const DEFAULT_URL_RETRY_BACKOFF_MS = 250;

/**
 * Delay before the first attempt at the next quality level. Much shorter than a
 * same-quality retry: switching level is a different request, not a re-poke of
 * the same one, so it does not need to wait out the same jitter window.
 */
export const QUALITY_SWITCH_BACKOFF_MS = 120;

/**
 * Delay after a -460 (NetEase IP risk control) failure.
 *
 * This is the one failure mode where the delay is NOT cosmetic: the upstream
 * has decided the caller's address looks risky and will keep answering 400 for
 * a few seconds no matter what we ask. Re-poking after 250ms just burns the
 * budget. 800ms × attempt (800, 1600, …) covers roughly the window users
 * reported clicking through by hand, without stalling the queue for long.
 */
export const RISK_CONTROL_BACKOFF_MS = 800;

/**
 * Normalise a config value into a usable retry count.
 * Anything non-numeric (legacy config, `"3"`, `null`) means "no retries", which
 * keeps the pre-existing fail-fast behaviour for callers that pass garbage.
 */
export function normalizeRetryCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(MAX_URL_RETRIES, Math.max(0, Math.trunc(value)));
}

export interface ResolveUrlWithRetryOptions {
  /** Extra attempts per quality level after the first. 0 = one attempt each. */
  retries: unknown;
  /** Resolve one URL. `undefined` means "the provider's configured quality". */
  resolve: (quality?: string) => Promise<SongUrlResult | null>;
  /**
   * Lower quality levels to sweep after the primary budget is spent, best→worst.
   * Typically `provider.getFallbackQualities?.()`.
   */
  fallbacks?: string[];
  /** Checked before every attempt — stop / disconnect aborts the budget. */
  isCancelled?: () => boolean;
  backoffMs?: number;
  /** Called once per failed attempt (logging hook). */
  onAttemptFailed?: (info: {
    attempt: number;
    total: number;
    quality?: string;
    error?: unknown;
  }) => void;
  /**
   * Called once when the budget is spent — never on cancellation, because
   * "the user pressed stop" is not a failure worth reporting.
   *
   * Carries the last attempt's error so the caller can turn it into a message
   * that names the cause (missing membership, delisted, blocked quality) rather
   * than the old catch-all 「区域/版权限制」.
   */
  onExhausted?: (info: { quality?: string; error: unknown }) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Returns the first successful result, or null once every level is exhausted.
 *
 * Request count: `(1 + retries)` at the configured quality, then one per
 * fallback level. With the defaults (2 retries, exhigh, NetEase's two lower
 * levels) that is at most 5 requests and ~1.1s of waiting.
 */
export async function resolveUrlWithRetry(
  opts: ResolveUrlWithRetryOptions,
): Promise<SongUrlResult | null> {
  const retries = normalizeRetryCount(opts.retries);
  const backoffMs = opts.backoffMs ?? DEFAULT_URL_RETRY_BACKOFF_MS;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Phase 1: the configured quality (1 + retries attempts).
  // Phase 2: every lower level, once each, so a discontinuous ladder is covered.
  const plan: Array<{ quality?: string; fallback: boolean }> = [];
  for (let i = 0; i <= retries; i++) plan.push({ quality: undefined, fallback: false });
  for (const quality of opts.fallbacks ?? []) plan.push({ quality, fallback: true });

  let sameQualityAttempt = 0;
  // Set when the previous attempt failed with -460. Risk control ignores the
  // quality we ask for, so a level switch does not get to use its short delay.
  let riskControlled = false;
  // The last failure, kept so the caller can explain the outcome. A `null`
  // result (no throw) counts too — it is the providers that have not adopted
  // SongUrlUnavailable yet.
  let lastError: unknown;
  let lastQuality: string | undefined;

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    if (opts.isCancelled?.()) return null;

    if (i > 0) {
      const wait = riskControlled
        ? RISK_CONTROL_BACKOFF_MS * Math.max(1, sameQualityAttempt)
        : step.fallback
          ? QUALITY_SWITCH_BACKOFF_MS
          : backoffMs * sameQualityAttempt;
      if (wait > 0) await sleep(wait);
      // The user may have stopped or switched tracks while we waited.
      if (opts.isCancelled?.()) return null;
    }

    let error: unknown;
    try {
      const result = await opts.resolve(step.quality);
      if (result?.url) return result;
    } catch (err) {
      error = err;
    }
    riskControlled = error instanceof RiskControlError;
    lastError = error;
    lastQuality = step.quality;
    opts.onAttemptFailed?.({ attempt: i + 1, total: plan.length, quality: step.quality, error });
    // Only same-quality attempts grow the backoff; a level switch resets it.
    sameQualityAttempt = step.fallback ? 0 : sameQualityAttempt + 1;
  }

  opts.onExhausted?.({ quality: lastQuality, error: lastError });
  return null;
}
