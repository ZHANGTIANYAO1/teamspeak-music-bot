import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceDuckingController } from "./voice-ducking.js";

function makeHarness(
  enabled = true,
  volumePercent = 30,
  timing = { attackMs: 50, holdMs: 100, releaseMs: 200 },
) {
  let now = 0;
  const setDuckingGain = vi.fn<(gain: number, rampMs?: number) => void>();
  const controller = new VoiceDuckingController(
    { setDuckingGain },
    { enabled, volumePercent },
    { timing, now: () => now },
  );

  const advance = (milliseconds: number) => {
    now += milliseconds;
    vi.advanceTimersByTime(milliseconds);
  };

  return { controller, setDuckingGain, advance };
}

describe("VoiceDuckingController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is inert while disabled", () => {
    vi.useFakeTimers();
    const { controller, setDuckingGain, advance } = makeHarness(false);

    controller.handleVoiceActivity(12);
    advance(1_000);

    expect(setDuckingGain).not.toHaveBeenCalled();
    expect(controller.isDucking()).toBe(false);
    expect(controller.activeSpeakerCount()).toBe(0);
  });

  it("attacks once, refreshes the packet deadline, then releases", () => {
    vi.useFakeTimers();
    const { controller, setDuckingGain, advance } = makeHarness();

    controller.handleVoiceActivity(12);
    expect(setDuckingGain).toHaveBeenCalledWith(0.3, 50);

    advance(60);
    controller.handleVoiceActivity(12);
    expect(setDuckingGain).toHaveBeenCalledTimes(1);

    // The original t=100 sweep observes the refreshed t=160 deadline.
    advance(40);
    expect(controller.isDucking()).toBe(true);
    expect(setDuckingGain).toHaveBeenCalledTimes(1);

    advance(60);
    expect(controller.isDucking()).toBe(false);
    expect(setDuckingGain).toHaveBeenLastCalledWith(1, 200);
  });

  it("stays ducked until the last overlapping speaker expires", () => {
    vi.useFakeTimers();
    const { controller, setDuckingGain, advance } = makeHarness();

    controller.handleVoiceActivity(1);
    advance(50);
    controller.handleVoiceActivity(2);
    advance(50);

    expect(controller.activeSpeakerCount()).toBe(1);
    expect(controller.isDucking()).toBe(true);
    expect(setDuckingGain).toHaveBeenCalledTimes(1);

    advance(50);
    expect(controller.activeSpeakerCount()).toBe(0);
    expect(setDuckingGain).toHaveBeenLastCalledWith(1, 200);
  });

  it("removes a client immediately on leave without disturbing other speakers", () => {
    vi.useFakeTimers();
    const { controller, setDuckingGain } = makeHarness();

    controller.handleVoiceActivity(1);
    controller.handleVoiceActivity(2);
    controller.removeSpeaker(1);
    expect(controller.isDucking()).toBe(true);
    expect(controller.activeSpeakerCount()).toBe(1);

    controller.removeSpeaker(2);
    expect(controller.isDucking()).toBe(false);
    expect(setDuckingGain).toHaveBeenLastCalledWith(1, 200);
  });

  it("retargets a live duck and smoothly restores when disabled", () => {
    vi.useFakeTimers();
    const { controller, setDuckingGain } = makeHarness();

    controller.handleVoiceActivity(7);
    controller.updateSettings({ enabled: true, volumePercent: 45 });
    expect(setDuckingGain).toHaveBeenLastCalledWith(0.45, 50);

    controller.updateSettings({ enabled: false, volumePercent: 45 });
    expect(controller.isDucking()).toBe(false);
    expect(controller.activeSpeakerCount()).toBe(0);
    expect(setDuckingGain).toHaveBeenLastCalledWith(1, 200);
  });

  it("attacks again when speech resumes during the release window", () => {
    vi.useFakeTimers();
    const { controller, setDuckingGain, advance } = makeHarness();

    controller.handleVoiceActivity(7);
    advance(100);
    expect(setDuckingGain).toHaveBeenLastCalledWith(1, 200);

    advance(50);
    controller.handleVoiceActivity(7);
    expect(controller.isDucking()).toBe(true);
    expect(setDuckingGain).toHaveBeenLastCalledWith(0.3, 50);
  });

  it("invalidates an old expiry callback after reset", () => {
    vi.useFakeTimers();
    const { controller, setDuckingGain, advance } = makeHarness();

    controller.handleVoiceActivity(8);
    controller.reset(true);
    const callsAfterReset = setDuckingGain.mock.calls.length;
    advance(1_000);

    expect(setDuckingGain).toHaveBeenCalledTimes(callsAfterReset);
    expect(setDuckingGain).toHaveBeenLastCalledWith(1, 0);
  });

  it("rejects invalid client ids and supports an immediate lifecycle reset", () => {
    vi.useFakeTimers();
    const { controller, setDuckingGain } = makeHarness();

    for (const id of [0, -1, 1.5, Number.NaN]) {
      controller.handleVoiceActivity(id);
    }
    expect(setDuckingGain).not.toHaveBeenCalled();

    controller.handleVoiceActivity(8);
    controller.reset(true);
    expect(controller.isDucking()).toBe(false);
    expect(controller.activeSpeakerCount()).toBe(0);
    expect(setDuckingGain).toHaveBeenLastCalledWith(1, 0);
  });
});
