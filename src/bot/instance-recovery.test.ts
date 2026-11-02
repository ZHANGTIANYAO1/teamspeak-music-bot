import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { BotInstance } from "./instance.js";
import { AudioPlayer } from "../audio/player.js";
import { PlayQueue } from "../audio/queue.js";
import { ManagedVoiceClientRegistry } from "./managed-voice-clients.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function makeBot() {
  const queue = new PlayQueue();
  queue.add({ id: "BV1example", name: "Long", artist: "A", album: "", coverUrl: "", platform: "bilibili", duration: 10_000, url: "old" });
  queue.playAt(0);
  const player = new EventEmitter() as any;
  player.state = "idle";
  player.sessionId = 1;
  player.elapsed = 1000;
  player.getState = AudioPlayer.prototype.getState;
  player.getPlaybackSessionId = AudioPlayer.prototype.getPlaybackSessionId;
  player.getElapsed = () => player.elapsed;
  player.getVolume = () => 50;
  player.pause = AudioPlayer.prototype.pause;
  player.resume = AudioPlayer.prototype.resume;
  // The real pause()/resume() drive the de-click transport ramp
  // (a0f0b49..6f165b5). A stub player must expose it too, or the prototype
  // methods throw "setTransportRamp is not a function".
  player.setTransportRamp = vi.fn();
  player.play = vi.fn((_url: string, position: number) => { player.sessionId++; player.elapsed = position; player.state = "playing"; });
  player.stop = vi.fn(() => { player.sessionId++; player.state = "idle"; });
  const provider = { getSongUrl: vi.fn(async (): Promise<{ url: string } | null> => ({ url: "fresh" })) };
  const tsClient = new EventEmitter() as any;
  tsClient.getClientsInChannel = vi.fn(async () => [{ id: 1 }, { id: 2 }]);
  tsClient.getClientId = () => 1;
  tsClient.sendVoiceData = vi.fn();
  tsClient.connect = vi.fn(async () => { tsClient.emit("connected"); });
  tsClient.disconnect = vi.fn(() => { tsClient.emit("disconnected"); });
  tsClient.getResolvedVoiceEndpoint = () => null;
  const spotifyController = new EventEmitter() as any;
  spotifyController.stop = vi.fn();
  const bot = Object.assign(Object.create(BotInstance.prototype), {
    id: "bot", name: "Bot", queue, player, tsClient, provider, spotifyController,
    connected: true, disconnectEmitted: false, effectiveDuration: 10_000,
    streamRecovery: null, lifecycleGeneration: 0, occupancyRequest: 0,
    config: { autoPauseOnEmpty: true, idleTimeoutMinutes: 1 }, autoPaused: false,
    idleTimer: null, snapshotTimer: null, currentSourceIsSpotify: false,
    localProvider: {}, voiceDucking: { reset: vi.fn(), removeSpeaker: vi.fn() },
    managedVoiceClients: new ManagedVoiceClientRegistry(),
    configuredVoiceServerScope: { host: "localhost", voicePort: 9987 },
    profileManager: { onConnect: vi.fn(), onChannelMoved: vi.fn(async () => {}) },
    unregisterManagedVoiceClient: vi.fn(), registerManagedVoiceClient: vi.fn(),
    restoreQueueFromSnapshot: vi.fn(async () => {}), _startJellyfinReportPoller: vi.fn(),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    emit: vi.fn(), getProviderFor: () => provider,
    playNext: vi.fn(async () => { const next = queue.next(); if (!next) queue.clear(); return !!next; }),
  }) as any;
  bot.setupPlayerEvents();
  bot.setupTsEvents();
  return bot;
}

function cancel(bot: any, action: string) {
  if (action === "disconnect") bot.disconnect();
  else if (action === "stop") { bot.queue.clear(); bot.player.stop(); }
  else if (action === "skip") { if (!bot.queue.next()) bot.queue.clear(); bot.player.stop(); }
  else if (action === "replace") {
    bot.queue.clear();
    bot.queue.add({ id: "other", name: "Other", artist: "A", album: "", coverUrl: "", platform: "bilibili", duration: 10_000 });
    bot.queue.playAt(0);
    bot.player.play("replacement", 0);
  } else { bot.player.sessionId++; bot.player.state = "idle"; }
}

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("Bilibili recovery retries transient URL failures", () => {
  it("keeps the same queue and seek through a null lookup, then resumes after one second", async () => {
    const bot = makeBot();
    const song = bot.queue.current();
    bot.provider.getSongUrl.mockResolvedValueOnce(null).mockResolvedValue({ url: "fresh" });
    bot.player.emit("trackEnd");
    await flush();
    expect(bot.queue.current()).toBe(song);
    expect(bot.playNext).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(bot.player.play).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.player.play).toHaveBeenCalledWith("fresh", 1000, 10_000);
    expect(bot.queue.current()).toBe(song);
    expect(bot.provider.getSongUrl.mock.calls.map((args: unknown[]) => args[0])).toEqual(["BV1example", "BV1example"]);
    expect(bot.streamRecovery.attempts).toBe(1);
  });

  it("retries a throw and null at one and two seconds without logging the sensitive exception", async () => {
    const bot = makeBot();
    const secret = "SYNTHETIC_SIGNED_URL_AND_COOKIE";
    bot.provider.getSongUrl.mockRejectedValueOnce(new Error(`https://cdn.invalid/?token=${secret}`))
      .mockResolvedValueOnce(null).mockResolvedValue({ url: "fresh" });
    bot.player.emit("trackEnd");
    await flush();
    expect(bot.playNext).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(bot.player.play).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1999);
    expect(bot.provider.getSongUrl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.player.play).toHaveBeenCalledWith("fresh", 1000, 10_000);
    const logs = JSON.stringify(bot.logger.warn.mock.calls, (_key, value) => value instanceof Error ? { message: value.message, stack: value.stack } : value);
    expect(logs).not.toContain(secret);
    expect(bot.logger.warn.mock.calls.map((args: any[]) => args[0])).toContainEqual(expect.objectContaining({
      platform: "bilibili", sessionId: 1, lookupAttempt: 1, reason: "lookup-error",
    }));
    expect(bot.playNext).not.toHaveBeenCalled();
  });

  it.each(["null", "throw"])("advances only after three exhausted %s lookups", async failure => {
    const bot = makeBot();
    if (failure === "null") bot.provider.getSongUrl.mockResolvedValue(null);
    else bot.provider.getSongUrl.mockRejectedValue(new Error("temporary"));
    bot.player.emit("trackEnd");
    await flush();
    expect(bot.playNext).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2999);
    expect(bot.playNext).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(bot.provider.getSongUrl).toHaveBeenCalledTimes(3);
    expect(bot.player.play).not.toHaveBeenCalled();
    expect(bot.playNext).toHaveBeenCalledTimes(1);
    expect(bot.queue.current()).toBeNull();
  });

  it.each(["skip", "stop", "replace", "restart", "disconnect"])("does not retry or advance after %s during backoff", async action => {
    const bot = makeBot();
    bot.provider.getSongUrl.mockResolvedValueOnce(null).mockResolvedValue({ url: "fresh" });
    bot.player.emit("trackEnd");
    await flush();
    cancel(bot, action);
    bot.player.play.mockClear();
    await vi.advanceTimersByTimeAsync(3000);
    expect(bot.provider.getSongUrl).toHaveBeenCalledTimes(1);
    expect(bot.player.play).not.toHaveBeenCalled();
    expect(bot.playNext).not.toHaveBeenCalled();
  });

  it.each(["skip", "stop", "replace", "restart", "disconnect"])("does not write a late retry result after %s", async action => {
    const bot = makeBot();
    const retry = deferred<{ url: string }>();
    bot.provider.getSongUrl.mockResolvedValueOnce(null).mockReturnValueOnce(retry.promise);
    bot.player.emit("trackEnd");
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(bot.provider.getSongUrl).toHaveBeenCalledTimes(2);
    cancel(bot, action);
    bot.player.play.mockClear();
    retry.resolve({ url: "stale" });
    await flush();
    expect(bot.player.play).not.toHaveBeenCalled();
    expect(bot.playNext).not.toHaveBeenCalled();
  });

  it("cancels a backoff when a new connection lifecycle begins", async () => {
    const bot = makeBot();
    bot.provider.getSongUrl.mockResolvedValueOnce(null).mockResolvedValue({ url: "stale" });
    bot.player.emit("trackEnd");
    await flush();
    await bot.connect();
    await vi.advanceTimersByTimeAsync(3000);
    expect(bot.provider.getSongUrl).toHaveBeenCalledTimes(1);
    expect(bot.player.play).not.toHaveBeenCalled();
    expect(bot.playNext).not.toHaveBeenCalled();
  });

  it("shows pause intent in the snapshot during backoff and pauses the recovered stream", async () => {
    const bot = makeBot();
    bot.provider.getSongUrl.mockResolvedValueOnce(null).mockResolvedValue({ url: "fresh" });
    bot.player.emit("trackEnd");
    await flush();
    bot.cmdPause();
    expect(bot.getStatus().paused).toBe(true);
    expect(bot.player.getState()).toBe("idle");
    await vi.advanceTimersByTimeAsync(1000);
    expect(bot.player.getState()).toBe("paused");
    expect(bot.playNext).not.toHaveBeenCalled();
    bot.cmdResume();
    expect(bot.getStatus().paused).toBe(false);
    expect(bot.player.getState()).toBe("playing");
    expect(bot.player.play).toHaveBeenCalledTimes(1);
  });

  it("retains a paused exhausted recovery until explicit resume retries", async () => {
    const bot = makeBot();
    bot.provider.getSongUrl.mockResolvedValue(null);
    bot.player.emit("trackEnd");
    bot.cmdPause();
    await vi.advanceTimersByTimeAsync(3000);
    expect(bot.playNext).not.toHaveBeenCalled();
    expect(bot.getStatus().paused).toBe(true);
    bot.provider.getSongUrl.mockResolvedValue({ url: "fresh" });
    bot.cmdResume();
    await flush();
    expect(bot.player.getState()).toBe("playing");
    expect(bot.player.play).toHaveBeenCalledWith("fresh", 1000, 10_000);
    expect(bot.playNext).not.toHaveBeenCalled();
  });

  it("coalesces duplicate ends throughout a lookup and its backoff", async () => {
    const bot = makeBot();
    const lookup = deferred<{ url: string } | null>();
    bot.provider.getSongUrl.mockReturnValueOnce(lookup.promise).mockResolvedValue({ url: "fresh" });
    bot.player.emit("trackEnd");
    bot.player.emit("trackEnd");
    lookup.resolve(null);
    await flush();
    bot.player.emit("trackEnd");
    await vi.advanceTimersByTimeAsync(1000);
    expect(bot.provider.getSongUrl).toHaveBeenCalledTimes(2);
    expect(bot.player.play).toHaveBeenCalledTimes(1);
    expect(bot.streamRecovery.attempts).toBe(1);
    expect(bot.playNext).not.toHaveBeenCalled();
  });

  it("an exhausted end cannot advance over an explicit paused-recovery retry already started", async () => {
    const bot = makeBot();
    const song = bot.queue.current();
    const retry = deferred<{ url: string }>();
    bot.provider.getSongUrl.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null).mockReturnValueOnce(retry.promise);
    const recover = bot.resumeInterruptedStream.bind(bot);
    let first = true;
    bot.resumeInterruptedStream = () => {
      const result = recover();
      if (first) { first = false; result.then(() => bot.cmdResume()); }
      return result;
    };
    bot.player.emit("trackEnd");
    bot.cmdPause();
    await vi.advanceTimersByTimeAsync(3000);
    expect(bot.provider.getSongUrl).toHaveBeenCalledTimes(4);
    expect(bot.queue.current()).toBe(song);
    expect(bot.playNext).not.toHaveBeenCalled();
    retry.resolve({ url: "fresh" });
    await flush();
    expect(bot.player.getState()).toBe("playing");
  });

  it("lookup retries do not consume the three actual decoder resume attempts", async () => {
    const bot = makeBot();
    for (let attempt = 0; attempt < 3; attempt++) {
      bot.provider.getSongUrl.mockResolvedValueOnce(null).mockResolvedValueOnce({ url: `fresh-${attempt}` });
      bot.player.state = "idle";
      bot.player.emit("trackEnd");
      await vi.advanceTimersByTimeAsync(1000);
      expect(bot.queue.current()?.id).toBe("BV1example");
    }
    bot.player.state = "idle";
    bot.player.emit("trackEnd");
    await flush();
    expect(bot.player.play).toHaveBeenCalledTimes(3);
    expect(bot.provider.getSongUrl).toHaveBeenCalledTimes(6);
    expect(bot.playNext).toHaveBeenCalledTimes(1);
  });
});

describe("occupancy responses belong to the current request and connection", () => {
  it("ignores an older alone response after a newer occupied response", async () => {
    const bot = makeBot();
    bot.player.state = "playing";
    const older = deferred<any[]>(), newer = deferred<any[]>();
    bot.tsClient.getClientsInChannel.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = bot.refreshOccupancy(), second = bot.refreshOccupancy();
    newer.resolve([{ id: 1 }, { id: 2 }]);
    await second;
    older.resolve([{ id: 1 }]);
    await first;
    expect(bot.player.getState()).toBe("playing");
    expect(bot.autoPaused).toBe(false);
    expect(bot.idleTimer).toBeNull();
  });

  it.each(["clientEnter", "clientLeave", "clientMoved"])("a newer %s event invalidates a pending response even if its new query fails", async event => {
    const bot = makeBot();
    bot.player.state = "playing";
    const older = deferred<any[]>();
    bot.tsClient.getClientsInChannel.mockReturnValueOnce(older.promise).mockResolvedValueOnce([]);
    const first = bot.refreshOccupancy();
    bot.tsClient.emit(event, { id: 2, targetChannelID: 3n });
    await flush();
    older.resolve([{ id: 1 }]);
    await first;
    expect(bot.player.getState()).toBe("playing");
    expect(bot.autoPaused).toBe(false);
    expect(bot.idleTimer).toBeNull();
  });

  it("a listener's return cannot be undone by an earlier alone response", async () => {
    const bot = makeBot();
    bot.player.state = "paused";
    bot.autoPaused = true;
    const older = deferred<any[]>(), newer = deferred<any[]>();
    bot.tsClient.getClientsInChannel.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const first = bot.refreshOccupancy();
    bot.tsClient.emit("clientEnter");
    expect(bot.player.getState()).toBe("playing");
    older.resolve([{ id: 1 }]);
    await first;
    expect(bot.player.getState()).toBe("playing");
    expect(bot.autoPaused).toBe(false);
    newer.resolve([]);
    await flush();
  });

  it.each([false, true])("ignores a response from before disconnect (reconnected=%s)", async reconnect => {
    const bot = makeBot();
    const older = deferred<any[]>();
    bot.tsClient.getClientsInChannel.mockReturnValueOnce(older.promise);
    const first = bot.refreshOccupancy();
    bot.disconnect();
    if (reconnect) { await bot.connect(); bot.player.state = "playing"; }
    older.resolve([{ id: 1 }]);
    await first;
    expect(bot.idleTimer).toBeNull();
    expect(bot.autoPaused).toBe(false);
    expect(bot.player.getState()).toBe(reconnect ? "playing" : "idle");
  });

  it("does not let an old lifecycle's poll timer query after reconnect", async () => {
    const bot = makeBot();
    bot._startIdlePoller();
    bot.disconnect();
    await bot.connect();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(bot.tsClient.getClientsInChannel).toHaveBeenCalledTimes(1);
  });

  it("does not apply or reschedule an old pending poll after reconnect", async () => {
    const bot = makeBot();
    const oldPoll = deferred<any[]>();
    bot.tsClient.getClientsInChannel.mockReturnValueOnce(oldPoll.promise);
    bot._startIdlePoller();
    await vi.advanceTimersByTimeAsync(30_000);
    bot.disconnect();
    await bot.connect();
    bot.player.state = "playing";
    oldPoll.resolve([{ id: 1 }]);
    await flush();
    expect(bot.player.getState()).toBe("playing");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(bot.tsClient.getClientsInChannel).toHaveBeenCalledTimes(2);
  });

  it("does not disconnect a new connection when an old idle deadline expires", async () => {
    const bot = makeBot();
    bot.player.state = "playing";
    bot.tsClient.getClientsInChannel.mockResolvedValueOnce([{ id: 1 }]).mockResolvedValue([]);
    await bot.refreshOccupancy();
    bot.tsClient.emit("disconnected");
    await bot.connect();
    bot.player.state = "playing";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bot.connected).toBe(true);
    expect(bot.tsClient.disconnect).not.toHaveBeenCalled();
  });

  it("cancels an old idle deadline before awaiting a new handshake", async () => {
    const bot = makeBot();
    const handshake = deferred<void>();
    bot.tsClient.getClientsInChannel.mockResolvedValue([{ id: 1 }]);
    await bot.refreshOccupancy();
    bot.tsClient.connect.mockReturnValue(handshake.promise);
    const connecting = bot.connect();
    await vi.advanceTimersByTimeAsync(60_000);
    handshake.resolve(undefined);
    await expect(connecting).resolves.toBeUndefined();
    expect(bot.connected).toBe(true);
    expect(bot.tsClient.disconnect).not.toHaveBeenCalled();
  });

  it("still pauses for a fresh authoritative alone response and ignores unknown occupancy", async () => {
    const bot = makeBot();
    bot.player.state = "playing";
    bot.tsClient.getClientsInChannel.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 1 }]);
    await bot.refreshOccupancy();
    expect(bot.player.getState()).toBe("playing");
    await bot.refreshOccupancy();
    expect(bot.player.getState()).toBe("paused");
    expect(bot.autoPaused).toBe(true);
    expect(bot.idleTimer).not.toBeNull();
  });
});
