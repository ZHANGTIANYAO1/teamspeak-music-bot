export interface VoiceDuckingSettings {
  enabled: boolean;
  volumePercent: number;
}

export interface VoiceDuckingGainTarget {
  setDuckingGain(gain: number, rampMs?: number): void;
}

export interface VoiceDuckingTiming {
  attackMs: number;
  holdMs: number;
  releaseMs: number;
}

export const DEFAULT_VOICE_DUCKING_TIMING: Readonly<VoiceDuckingTiming> = {
  attackMs: 50,
  holdMs: 700,
  releaseMs: 500,
};

interface VoiceDuckingControllerOptions {
  timing?: Partial<VoiceDuckingTiming>;
  now?: () => number;
}

function nonNegativeFinite(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : fallback;
}

function normalizeSettings(settings: VoiceDuckingSettings): VoiceDuckingSettings {
  return {
    enabled: settings.enabled === true,
    volumePercent:
      typeof settings.volumePercent === "number" && Number.isFinite(settings.volumePercent)
        ? Math.max(0, Math.min(100, settings.volumePercent))
        : 30,
  };
}

/**
 * Converts the stream of incoming TeamSpeak voice packets into a stable
 * ducking envelope. TeamSpeak's full-client protocol exposes voice packets,
 * but not an explicit "stopped talking" event, so a speaker remains active
 * for a short hold period after their most recent packet.
 *
 * Only one timeout is live at a time. Repeated ~20 ms voice packets update a
 * deadline in the map instead of constantly destroying/recreating timers.
 */
export class VoiceDuckingController {
  private settings: VoiceDuckingSettings;
  private readonly timing: VoiceDuckingTiming;
  private readonly now: () => number;
  private readonly activeUntil = new Map<number, number>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private timerDueAt = Number.POSITIVE_INFINITY;
  private timerGeneration = 0;
  private ducking = false;

  constructor(
    private readonly target: VoiceDuckingGainTarget,
    initialSettings: VoiceDuckingSettings,
    options: VoiceDuckingControllerOptions = {},
  ) {
    this.settings = normalizeSettings(initialSettings);
    this.timing = {
      attackMs: nonNegativeFinite(options.timing?.attackMs, DEFAULT_VOICE_DUCKING_TIMING.attackMs),
      holdMs: nonNegativeFinite(options.timing?.holdMs, DEFAULT_VOICE_DUCKING_TIMING.holdMs),
      releaseMs: nonNegativeFinite(options.timing?.releaseMs, DEFAULT_VOICE_DUCKING_TIMING.releaseMs),
    };
    this.now = options.now ?? (() => performance.now());
  }

  handleVoiceActivity(clientId: number): void {
    if (!this.settings.enabled || !Number.isInteger(clientId) || clientId <= 0) return;

    const now = this.now();
    this.activeUntil.set(clientId, now + this.timing.holdMs);

    if (!this.ducking) {
      this.ducking = true;
      this.target.setDuckingGain(this.settings.volumePercent / 100, this.timing.attackMs);
    }

    this.scheduleNextSweep(now);
  }

  removeSpeaker(clientId: number): void {
    if (!this.activeUntil.delete(clientId)) return;
    if (this.activeUntil.size === 0) {
      this.cancelTimer();
      this.release();
    }
  }

  updateSettings(settings: VoiceDuckingSettings): void {
    const previous = this.settings;
    this.settings = normalizeSettings(settings);

    if (!this.settings.enabled) {
      this.activeUntil.clear();
      this.cancelTimer();
      this.release();
      return;
    }

    if (
      previous.volumePercent !== this.settings.volumePercent &&
      this.ducking
    ) {
      this.target.setDuckingGain(this.settings.volumePercent / 100, this.timing.attackMs);
    }
  }

  /** Clear all activity. Disconnects use an immediate reset; disabling the
   * feature uses updateSettings(), which returns smoothly over releaseMs. */
  reset(immediate = true): void {
    this.activeUntil.clear();
    this.cancelTimer();
    this.ducking = false;
    this.target.setDuckingGain(1, immediate ? 0 : this.timing.releaseMs);
  }

  isDucking(): boolean {
    return this.ducking;
  }

  activeSpeakerCount(): number {
    return this.activeUntil.size;
  }

  private scheduleNextSweep(now = this.now()): void {
    if (this.activeUntil.size === 0) return;

    let nextDueAt = Number.POSITIVE_INFINITY;
    for (const deadline of this.activeUntil.values()) {
      if (deadline < nextDueAt) nextDueAt = deadline;
    }

    // Keeping an earlier timer is intentional. When it fires it will observe
    // the refreshed deadline and schedule the remaining delay, avoiding timer
    // churn on every incoming packet.
    if (this.expiryTimer && this.timerDueAt <= nextDueAt) return;

    this.cancelTimer();
    const generation = ++this.timerGeneration;
    this.timerDueAt = nextDueAt;
    this.expiryTimer = setTimeout(() => {
      if (generation !== this.timerGeneration) return;
      this.expiryTimer = null;
      this.timerDueAt = Number.POSITIVE_INFINITY;
      this.sweepExpiredSpeakers();
    }, Math.max(0, nextDueAt - now));
  }

  private sweepExpiredSpeakers(): void {
    const now = this.now();
    for (const [clientId, deadline] of this.activeUntil) {
      if (deadline <= now) this.activeUntil.delete(clientId);
    }

    if (this.activeUntil.size > 0) {
      this.scheduleNextSweep(now);
    } else {
      this.release();
    }
  }

  private release(): void {
    if (!this.ducking) return;
    this.ducking = false;
    this.target.setDuckingGain(1, this.timing.releaseMs);
  }

  private cancelTimer(): void {
    this.timerGeneration++;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.timerDueAt = Number.POSITIVE_INFINITY;
  }
}
