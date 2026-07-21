import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { BotInstance, COMMAND_DENIED_MESSAGE, spotifyPortsForBotId } from "./instance.js";
import type { BotInstanceOptions } from "./instance.js";
import { PlayQueue, PlayMode } from "../audio/queue.js";
import { createDatabase, SHARED_QUEUE_OWNER } from "../data/database.js";
import { parseCommand } from "./commands.js";
import type { TS3TextMessage } from "../ts-protocol/client.js";
import type { SpotifyController } from "../music/spotify/controller.js";
import type { SpotifyOAuth } from "../music/spotify/spotify-oauth.js";
import type { MusicProvider } from "../music/provider.js";
import type { BotDatabase } from "../data/database.js";
import type { AvatarStore } from "../data/avatars.js";
import type { BotConfig } from "../data/config.js";
import { ManagedVoiceClientRegistry } from "./managed-voice-clients.js";

// Constructing a real BotInstance is heavy (spawns a TS3Client, AudioPlayer,
// reads avatars, etc.), and runExclusive only touches a single private field
// (`playGate`). So we exercise the ACTUAL shipped method via its prototype,
// bound to a minimal object carrying just that field. This proves the real
// serializer logic without standing up a full bot.
type Gate = { playGate: Promise<unknown> };
const runExclusive = BotInstance.prototype.runExclusive as <T>(
  this: Gate,
  fn: () => Promise<T>,
) => Promise<T>;

function makeGate(): Gate {
  return { playGate: Promise.resolve() };
}

/** An explicit, timer-free deferred so ordering is deterministic. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("BotInstance.runExclusive — serialization", () => {
  it("does not start fnB until fnA settles", async () => {
    const gate = makeGate();
    const order: string[] = [];
    const gateA = deferred();

    const pA = runExclusive.call(gate, async () => {
      order.push("A-start");
      await gateA.promise; // suspend A until we explicitly release it
      order.push("A-end");
    });

    const pB = runExclusive.call(gate, async () => {
      order.push("B-start");
      order.push("B-end");
    });

    // Give the microtask queue a chance: B must NOT have started while A is
    // still suspended on gateA.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["A-start"]);

    gateA.resolve();
    await pA;
    await pB;

    expect(order).toEqual(["A-start", "A-end", "B-start", "B-end"]);
  });

  it("runs fnB even if fnA rejects (chain survives rejection)", async () => {
    const gate = makeGate();
    const order: string[] = [];
    const gateA = deferred();

    const pA = runExclusive.call(gate, async () => {
      order.push("A-start");
      await gateA.promise;
      throw new Error("A blew up");
    });

    const pB = runExclusive.call(gate, async () => {
      order.push("B-start");
      order.push("B-end");
      return "B-result";
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["A-start"]);

    gateA.reject(new Error("A blew up"));
    await expect(pA).rejects.toThrow("A blew up");

    // B still runs, only after A has fully settled.
    await expect(pB).resolves.toBe("B-result");
    expect(order).toEqual(["A-start", "B-start", "B-end"]);
  });

  it("preserves call order across three serialized tasks", async () => {
    const gate = makeGate();
    const order: string[] = [];
    const tasks = ["X", "Y", "Z"];
    const promises = tasks.map((t) =>
      runExclusive.call(gate, async () => {
        order.push(`${t}-start`);
        await Promise.resolve();
        order.push(`${t}-end`);
      }),
    );

    await Promise.all(promises);

    expect(order).toEqual([
      "X-start",
      "X-end",
      "Y-start",
      "Y-end",
      "Z-start",
      "Z-end",
    ]);
  });
});

describe("BotInstance voice-ducking lifecycle integration", () => {
  const connect = BotInstance.prototype.connect as unknown as (
    this: Record<string, any>,
  ) => Promise<void>;

  function makeConnectContext(connectPromise: Promise<void>) {
    return {
      disconnectEmitted: false,
      connected: false,
      tsClient: {
        connect: vi.fn(() => connectPromise),
        getResolvedVoiceEndpoint: vi.fn(() => ({ host: "203.0.113.20", port: 12000 })),
      },
      configuredVoiceServerScope: {
        host: "voice-alias.example.com",
        voicePort: 9987,
      },
      voiceServerScope: { host: "voice-alias.example.com", voicePort: 9987 },
      voiceDucking: { reset: vi.fn() },
      registerManagedVoiceClient: vi.fn(),
      profileManager: { onConnect: vi.fn() },
      emit: vi.fn(),
      restoreQueueFromSnapshot: vi.fn(async () => {}),
    };
  }

  it("registers its managed client only after a successful outer connect", async () => {
    const ctx = makeConnectContext(Promise.resolve());

    await connect.call(ctx);

    expect(ctx.connected).toBe(true);
    expect(ctx.voiceServerScope).toEqual({ host: "203.0.113.20", voicePort: 12000 });
    expect(ctx.voiceDucking.reset).toHaveBeenCalledWith(true);
    expect(ctx.registerManagedVoiceClient).toHaveBeenCalledOnce();
    expect(ctx.profileManager.onConnect).toHaveBeenCalledOnce();
  });

  it("does not register a late handshake after disconnect aborted it", async () => {
    const handshake = deferred();
    const ctx = makeConnectContext(handshake.promise);

    const result = connect.call(ctx);
    ctx.disconnectEmitted = true;
    handshake.resolve();

    await expect(result).rejects.toThrow("Connect aborted by concurrent disconnect");
    expect(ctx.connected).toBe(false);
    expect(ctx.registerManagedVoiceClient).not.toHaveBeenCalled();
    expect(ctx.voiceDucking.reset).not.toHaveBeenCalled();
  });

  it("falls back to the configured endpoint when identity discovery is unavailable", async () => {
    const ctx = makeConnectContext(Promise.resolve());
    ctx.tsClient.getResolvedVoiceEndpoint.mockReturnValue(null as any);

    await connect.call(ctx);

    expect(ctx.voiceServerScope).toEqual({
      host: "voice-alias.example.com",
      voicePort: 9987,
    });
  });

  it("routes human voice activity but filters another managed bot", () => {
    const tsClient = new EventEmitter() as EventEmitter & {
      getClientId(): number;
    };
    tsClient.getClientId = () => 10;
    const managedVoiceClients = new ManagedVoiceClientRegistry();
    const voiceServerScope = { host: "voice.example.com", voicePort: 9987 };
    managedVoiceClients.register(
      { host: "192.168.1.10", voicePort: 20_000 },
      20,
      {},
      "managed-bot-uid=",
    );
    managedVoiceClients.register(voiceServerScope, 22, {}, "fallback-bot-uid=");
    const handleVoiceActivity = vi.fn();
    const ctx = {
      tsClient,
      connected: true,
      managedVoiceClients,
      voiceServerScope,
      voiceDucking: {
        handleVoiceActivity,
        removeSpeaker: vi.fn(),
        reset: vi.fn(),
      },
    } as Record<string, any>;

    (BotInstance.prototype as any).setupTsEvents.call(ctx);
    tsClient.emit("voiceActivity", {
      clientId: 20,
      codec: 5,
      clientUid: "managed-bot-uid=",
    });
    // If a UID is momentarily unavailable, the scoped client-id registry is
    // retained as a fallback for the common same-endpoint case.
    tsClient.emit("voiceActivity", { clientId: 22, codec: 5 });
    tsClient.emit("voiceActivity", {
      clientId: 21,
      codec: 5,
      clientUid: "human-uid=",
    });

    expect(handleVoiceActivity).toHaveBeenCalledOnce();
    expect(handleVoiceActivity).toHaveBeenCalledWith(21);
  });

  it("keeps a disconnecting bot registered during the in-flight packet grace", () => {
    vi.useFakeTimers();
    try {
      const managedVoiceClients = new ManagedVoiceClientRegistry();
      const voiceServerScope = { host: "voice.example.com", voicePort: 9987 };
      const owner = {};
      managedVoiceClients.register(
        voiceServerScope,
        20,
        owner,
        "managed-bot-uid=",
      );
      const ctx = {
        managedVoiceClients,
        voiceServerScope,
        registeredVoiceClientId: 20,
        registeredVoiceClientOwner: owner,
        registeredVoiceClientScope: voiceServerScope,
        registeredVoiceClientUid: "managed-bot-uid=",
      };

      (BotInstance.prototype as any).unregisterManagedVoiceClient.call(ctx, 1_000);
      // A reconnect may resolve to a new endpoint before the grace expires;
      // cleanup must still target the scope that owned the old client id.
      ctx.voiceServerScope = { host: "other.example.com", voicePort: 9987 };
      expect(managedVoiceClients.has(voiceServerScope, 20)).toBe(true);
      expect(managedVoiceClients.hasClientUid("managed-bot-uid=")).toBe(true);

      vi.advanceTimersByTime(999);
      expect(managedVoiceClients.has(voiceServerScope, 20)).toBe(true);
      vi.advanceTimersByTime(1);
      expect(managedVoiceClients.has(voiceServerScope, 20)).toBe(false);
      expect(managedVoiceClients.hasClientUid("managed-bot-uid=")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Minimal `this` carrying only what handleTextMessage's gate path touches.
 *  The gate methods live on the prototype and are attached here so calls like
 *  `this.isCommandAllowed(...)` resolve against this same object. */
function makeGateCtx(opts: {
  adminGroups?: number[];
  lookupGroups?: string[];
  lookupThrows?: boolean;
}) {
  const ctx: any = {
    config: { commandPrefix: "!", commandAliases: {}, adminGroups: opts.adminGroups ?? [] },
    logger: { info: vi.fn(), error: vi.fn() },
    tsClient: {
      sendTextMessage: vi.fn(async () => {}),
      getClientServerGroups: vi.fn(async () => {
        if (opts.lookupThrows) throw new Error("query failed");
        return opts.lookupGroups ?? [];
      }),
    },
    executeCommand: vi.fn(async () => null),
    isCommandAllowed: (BotInstance.prototype as any).isCommandAllowed,
    lookupInvokerGroups: (BotInstance.prototype as any).lookupInvokerGroups,
  };
  return ctx;
}

function makeMsg(message: string, invokerGroups: string[] = [], invokerId = "5"): TS3TextMessage {
  return { invokerName: "Tester", invokerId, invokerUid: "uid", message, targetMode: 2, invokerGroups };
}

const handleTextMessage = (BotInstance.prototype as any).handleTextMessage as (
  this: unknown,
  msg: TS3TextMessage,
) => Promise<void>;

describe("BotInstance.handleTextMessage — command permission gate", () => {
  it("runs a public command with no group lookup, even under enforcement", async () => {
    const ctx = makeGateCtx({ adminGroups: [6] });
    await handleTextMessage.call(ctx, makeMsg("!play 晴天", ["6"]));
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
    expect(ctx.tsClient.getClientServerGroups).not.toHaveBeenCalled();
    expect(ctx.tsClient.sendTextMessage).not.toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });

  it("runs an admin command with no lookup when enforcement is off", async () => {
    const ctx = makeGateCtx({ adminGroups: [] });
    await handleTextMessage.call(ctx, makeMsg("!stop"));
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
    expect(ctx.tsClient.getClientServerGroups).not.toHaveBeenCalled();
  });

  it("allows an enforced admin command when the live lookup returns a matching group", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], lookupGroups: ["6"] });
    await handleTextMessage.call(ctx, makeMsg("!stop"));
    expect(ctx.tsClient.getClientServerGroups).toHaveBeenCalledTimes(1);
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("denies an enforced admin command when the live lookup has no matching group", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], lookupGroups: ["8"] });
    await handleTextMessage.call(ctx, makeMsg("!stop"));
    expect(ctx.executeCommand).not.toHaveBeenCalled();
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });

  it("fails closed when the live lookup returns no groups", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], lookupGroups: [] });
    await handleTextMessage.call(ctx, makeMsg("!stop"));
    expect(ctx.executeCommand).not.toHaveBeenCalled();
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });

  it("fails closed when the live lookup throws", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], lookupThrows: true });
    await handleTextMessage.call(ctx, makeMsg("!stop"));
    expect(ctx.executeCommand).not.toHaveBeenCalled();
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });

  it("ignores stale event groups: a demoted sender (cached match) is denied by the live lookup", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], lookupGroups: ["8"] });
    await handleTextMessage.call(ctx, makeMsg("!stop", ["6"]));
    expect(ctx.executeCommand).not.toHaveBeenCalled();
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledWith(COMMAND_DENIED_MESSAGE);
  });

  it("uses live groups, not stale event groups: a freshly-promoted sender is allowed", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], lookupGroups: ["6"] });
    await handleTextMessage.call(ctx, makeMsg("!stop", ["8"]));
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("resolves out-of-channel senders server-wide: empty event groups but a matching live group → allowed", async () => {
    const ctx = makeGateCtx({ adminGroups: [6], lookupGroups: ["6"] });
    await handleTextMessage.call(ctx, makeMsg("!stop", [], "5"));
    expect(ctx.tsClient.getClientServerGroups).toHaveBeenCalledTimes(1);
    expect(ctx.executeCommand).toHaveBeenCalledTimes(1);
  });
});

describe("BotInstance.getProviderFor — spotify routing", () => {
  it("getProviderFor routes 'spotify' to the injected spotify provider", () => {
    const spotify = { platform: "spotify" } as any;
    const ctx = { spotifyProvider: spotify, neteaseProvider: { platform: "netease" } } as any;
    expect(BotInstance.prototype.getProviderFor.call(ctx, "spotify" as any)).toBe(spotify);
  });
});

// --- Spotify orchestration (Task 7 + Correction C4) ------------------------
// These drive the REAL prototype methods on a hand-built ctx (the file's
// established `.call(ctx)` style) and assert the routing DECISIONS. Live audio
// is not testable here. C4 supersedes the brief where they conflict: switching
// a URL track -> spotify does NOT call player.stop() (playPcmStream fences the
// prior ffmpeg internally), and a spotify -> spotify handoff does NOT re-attach
// the persistent PCM stream (playPcmStream is called ONCE across both tracks).

const resolveAndPlay = BotInstance.prototype.resolveAndPlay as (
  this: unknown,
  song: any,
) => Promise<boolean>;
const setupPlayerEvents = (BotInstance.prototype as any).setupPlayerEvents as (
  this: unknown,
) => void;
const cmdPause = (BotInstance.prototype as any).cmdPause as (this: unknown) => string;
const cmdResume = (BotInstance.prototype as any).cmdResume as (this: unknown) => string;
const cmdStop = (BotInstance.prototype as any).cmdStop as (this: unknown) => string;
const handleOccupancy = (BotInstance.prototype as any).handleOccupancy as (
  this: unknown,
  userCount: number,
) => void;
const seek = (BotInstance.prototype as any).seek as (this: unknown, seconds: number) => void;
const playNext = (BotInstance.prototype as any).playNext as (
  this: unknown,
  maxRetries?: number,
) => Promise<boolean>;
const cmdRemove = (BotInstance.prototype as any).cmdRemove as (
  this: unknown,
  cmd: any,
) => Promise<string> | string;

function makeController() {
  return {
    ensureStarted: vi.fn(async () => true),
    playTrack: vi.fn(async () => true),
    getPcmStream: vi.fn(() => ({ kind: "pcm" } as any)),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    seek: vi.fn(async () => {}),
    stop: vi.fn(() => {}),
    on: vi.fn(),
  };
}
function makePlayer() {
  // `externalActive` mirrors the real AudioPlayer: playPcmStream attaches the
  // external stream (true), and both stop() and play() detach it (false). The
  // re-attach guard reads isExternalActive(), so this must track that state.
  // `state` mirrors the real player's PlayerState transitions so tests can
  // observe paused→playing (R3-3): playPcmStream/play → "playing", stop →
  // "idle", pause → "paused" (only from playing), resume → "playing" (only
  // from paused). Existing tests never read state, so tracking it is inert
  // for them.
  let externalActive = false;
  let state: "idle" | "playing" | "paused" = "idle";
  return {
    play: vi.fn((..._args: any[]) => { externalActive = false; state = "playing"; }),
    stop: vi.fn(() => { externalActive = false; state = "idle"; }),
    playPcmStream: vi.fn((..._args: any[]) => { externalActive = true; state = "playing"; }),
    pause: vi.fn(() => { if (state === "playing") state = "paused"; }),
    resume: vi.fn(() => { if (state === "paused") state = "playing"; }),
    seek: vi.fn(),
    isExternalActive: vi.fn(() => externalActive),
    getState: vi.fn(() => state),
  };
}
function makeResolveCtx(opts: {
  controller: ReturnType<typeof makeController>;
  player: ReturnType<typeof makePlayer>;
  url: string;
  currentSourceIsSpotify?: boolean;
}) {
  return {
    connected: true,
    config: {},
    id: "bot1",
    voteSkipUsers: new Set<string>(),
    autoPaused: false,
    currentSourceIsSpotify: opts.currentSourceIsSpotify ?? false,
    effectiveDuration: undefined,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tsClient: { sendTextMessage: vi.fn(async () => {}) },
    database: { addPlayHistory: vi.fn() },
    spotifyController: opts.controller,
    player: opts.player,
    getProviderFor: vi.fn(() => ({ getSongUrl: async () => ({ url: opts.url }) })),
    syncProfileToSong: vi.fn(async () => {}),
    emit: vi.fn(),
  } as any;
}
function spotifySong() {
  return {
    id: "abc",
    name: "Song",
    artist: "Artist",
    album: "Album",
    platform: "spotify",
    coverUrl: "c",
    duration: 200,
    url: "",
  };
}

describe("BotInstance.resolveAndPlay — Spotify routing (C4)", () => {
  it("routes a spotify song to controller.playTrack + player.playPcmStream, not player.play", async () => {
    const controller = makeController();
    const player = makePlayer();
    const ctx = makeResolveCtx({ controller, player, url: "spotify:track:abc" });

    const ok = await resolveAndPlay.call(ctx, spotifySong());

    expect(ok).toBe(true);
    expect(controller.ensureStarted).toHaveBeenCalledTimes(1);
    expect(controller.playTrack).toHaveBeenCalledWith("spotify:track:abc");
    expect(player.playPcmStream).toHaveBeenCalledTimes(1);
    expect(player.playPcmStream.mock.calls[0][0]).toEqual({ kind: "pcm" });
    expect(player.play).not.toHaveBeenCalled();
    // C4: playPcmStream fences the prior url-ffmpeg internally — no player.stop().
    expect(player.stop).not.toHaveBeenCalled();
    expect(ctx.currentSourceIsSpotify).toBe(true);
    expect(ctx.database.addPlayHistory).toHaveBeenCalledTimes(1);
    expect(ctx.emit).toHaveBeenCalledWith("stateChange");
  });

  it("returns false + sends the Stage-1 fallback when the backend is unavailable", async () => {
    const controller = makeController();
    controller.ensureStarted = vi.fn(async () => false);
    const player = makePlayer();
    const ctx = makeResolveCtx({ controller, player, url: "spotify:track:abc" });

    const ok = await resolveAndPlay.call(ctx, spotifySong());

    expect(ok).toBe(false);
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(controller.playTrack).not.toHaveBeenCalled();
    expect(player.playPcmStream).not.toHaveBeenCalled();
    expect(player.play).not.toHaveBeenCalled();
  });

  it("attaches the PCM stream once (no player.stop) when switching URL -> spotify", async () => {
    const controller = makeController();
    const player = makePlayer();
    const ctx = makeResolveCtx({
      controller, player, url: "spotify:track:abc", currentSourceIsSpotify: false,
    });

    await resolveAndPlay.call(ctx, spotifySong());

    // C4: NO player.stop() on the URL -> spotify transition.
    expect(player.stop).not.toHaveBeenCalled();
    expect(player.playPcmStream).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-attach the stream on a spotify -> spotify handoff (playPcmStream called once across two tracks)", async () => {
    const controller = makeController();
    const player = makePlayer();
    const ctx = makeResolveCtx({
      controller, player, url: "spotify:track:abc", currentSourceIsSpotify: false,
    });

    // First spotify track: coming from a URL/idle source -> attach.
    await resolveAndPlay.call(ctx, spotifySong());
    expect(ctx.currentSourceIsSpotify).toBe(true);
    // Second spotify track: go-librespot changes tracks into the SAME FIFO.
    await resolveAndPlay.call(ctx, spotifySong());

    expect(player.playPcmStream).toHaveBeenCalledTimes(1); // NOT re-attached
    expect(controller.playTrack).toHaveBeenCalledTimes(2); // both tracks played
    expect(player.stop).not.toHaveBeenCalled();
  });

  it("RE-attaches on a spotify -> (command player.stop) -> spotify sequence (does not stay silent)", async () => {
    // Regression: command paths (cmdPlay/cmdPlaylist/cmdAlbum/cmdFm) call
    // player.stop() — which DETACHES the external stream — WITHOUT clearing the
    // currentSourceIsSpotify flag. Gating re-attach on the stale flag skipped
    // playPcmStream, silencing the next spotify track. We now gate on the
    // player's actual external state, so the re-attach happens.
    const controller = makeController();
    const player = makePlayer();
    const ctx = makeResolveCtx({
      controller, player, url: "spotify:track:abc", currentSourceIsSpotify: false,
    });

    // First spotify track attaches the persistent PCM stream.
    await resolveAndPlay.call(ctx, spotifySong());
    expect(player.playPcmStream).toHaveBeenCalledTimes(1);
    expect(player.isExternalActive()).toBe(true);

    // A command path stops the player (detaches the stream) but leaves the
    // spotify flag stale-true — exactly the state that used to cause silence.
    player.stop();
    expect(player.isExternalActive()).toBe(false);
    expect(ctx.currentSourceIsSpotify).toBe(true); // flag NOT cleared by stop()

    // Next spotify track MUST re-attach (gate on player external state, not flag).
    await resolveAndPlay.call(ctx, spotifySong());
    expect(player.playPcmStream).toHaveBeenCalledTimes(2);
    expect(player.isExternalActive()).toBe(true);
  });

  it("returns false + sends the fallback when playTrack resolves false (dead/failed sidecar)", async () => {
    const controller = makeController();
    controller.playTrack = vi.fn(async () => false);
    const player = makePlayer();
    const ctx = makeResolveCtx({ controller, player, url: "spotify:track:abc" });

    const ok = await resolveAndPlay.call(ctx, spotifySong());

    expect(ok).toBe(false);
    expect(controller.playTrack).toHaveBeenCalledTimes(1);
    // Same Stage-1 fallback message as the backend-unavailable path.
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledTimes(1);
    // Never attach the player to a dead stream.
    expect(player.playPcmStream).not.toHaveBeenCalled();
    expect(ctx.currentSourceIsSpotify).toBe(false);
  });

  it("recovers on mid-session sidecar death: onExternalEnd stops controller+player and clears the flag", async () => {
    const controller = makeController();
    const player = makePlayer();
    const ctx = makeResolveCtx({ controller, player, url: "spotify:track:abc" });

    await resolveAndPlay.call(ctx, spotifySong());
    expect(ctx.currentSourceIsSpotify).toBe(true);
    expect(player.playPcmStream).toHaveBeenCalledTimes(1);

    // The sidecar PCM stream EOFs mid-session → fire the wired onExternalEnd.
    const opts = player.playPcmStream.mock.calls[0][1] as { onExternalEnd?: () => void };
    expect(typeof opts.onExternalEnd).toBe("function");
    opts.onExternalEnd!();

    // Recovery: controller torn down (next track rebuilds), player stopped
    // (drops external mode so the next track re-attaches), flag cleared.
    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect(player.stop).toHaveBeenCalledTimes(1);
    expect(ctx.currentSourceIsSpotify).toBe(false);
  });

  it("pauses the sidecar and clears the flag when switching to a non-spotify track", async () => {
    const controller = makeController();
    const player = makePlayer();
    const song = { ...spotifySong(), platform: "netease" };
    const ctx = makeResolveCtx({
      controller, player, url: "http://cdn/x.mp3", currentSourceIsSpotify: true,
    });

    const ok = await resolveAndPlay.call(ctx, song);

    expect(ok).toBe(true);
    expect(controller.pause).toHaveBeenCalledTimes(1);
    expect(ctx.currentSourceIsSpotify).toBe(false);
    expect(player.play).toHaveBeenCalledWith("http://cdn/x.mp3", 0, 200);
    expect(player.playPcmStream).not.toHaveBeenCalled();
  });

  // R3-3: spotify A playing → pause → skip to spotify B. The persistent PCM
  // stream stays attached through the pause, so the re-attach gate skips
  // playPcmStream (which is what sets state='playing'). Without an explicit
  // resume the player would sit 'paused' and emit silence while the sidecar
  // decodes B. The reuse path must force the player back to PLAYING.
  it("resumes the player when skipping from a PAUSED spotify track to another spotify track (R3-3)", async () => {
    const controller = makeController();
    const player = makePlayer();
    const ctx = makeResolveCtx({
      controller, player, url: "spotify:track:abc", currentSourceIsSpotify: false,
    });

    // Spotify A starts → PCM stream attached, player playing.
    await resolveAndPlay.call(ctx, spotifySong());
    expect(player.getState()).toBe("playing");
    expect(player.isExternalActive()).toBe(true);

    // User pauses: player paused; the external stream stays attached.
    player.pause();
    expect(player.getState()).toBe("paused");
    expect(player.isExternalActive()).toBe(true);

    // Skip to spotify B via the external-stream-reuse path (playPcmStream skipped).
    await resolveAndPlay.call(ctx, spotifySong());

    // Player must be PLAYING again (frames would emit), not stuck paused.
    expect(player.getState()).toBe("playing");
    // Reuse path — the persistent stream was NOT re-attached.
    expect(player.playPcmStream).toHaveBeenCalledTimes(1);
    expect(player.resume).toHaveBeenCalled();
  });

  // The normal (non-paused) spotify→spotify handoff must be unaffected: resume
  // on an already-playing player is a no-op, so state stays 'playing'.
  it("keeps a non-paused spotify→spotify handoff playing (R3-3 no-regression)", async () => {
    const controller = makeController();
    const player = makePlayer();
    const ctx = makeResolveCtx({
      controller, player, url: "spotify:track:abc", currentSourceIsSpotify: false,
    });

    await resolveAndPlay.call(ctx, spotifySong());
    await resolveAndPlay.call(ctx, spotifySong());

    expect(player.getState()).toBe("playing");
    expect(player.playPcmStream).toHaveBeenCalledTimes(1);
  });
});

describe("BotInstance.setupPlayerEvents — controller trackEnded wiring", () => {
  function makeEventCtx(currentPlatform: string) {
    return {
      spotifyController: { on: vi.fn() },
      player: { on: vi.fn() },
      queue: { current: vi.fn(() => ({ platform: currentPlatform })) },
      logger: { debug: vi.fn(), error: vi.fn() },
      playNext: vi.fn(async () => true),
    } as any;
  }
  function trackEndedHandler(ctx: any) {
    const call = ctx.spotifyController.on.mock.calls.find(
      (c: any[]) => c[0] === "trackEnded",
    );
    expect(call).toBeDefined();
    return call[1] as (e: any) => void;
  }

  it("advances via playNext when the current song is spotify", () => {
    const ctx = makeEventCtx("spotify");
    setupPlayerEvents.call(ctx);
    trackEndedHandler(ctx)({ uri: "spotify:track:x", reason: "ended" });
    expect(ctx.playNext).toHaveBeenCalledTimes(1);
  });

  it("ignores controller trackEnded when the current song is not spotify", () => {
    const ctx = makeEventCtx("netease");
    setupPlayerEvents.call(ctx);
    trackEndedHandler(ctx)({ uri: "spotify:track:x", reason: "ended" });
    expect(ctx.playNext).not.toHaveBeenCalled();
  });
});

describe("BotInstance transport delegation — spotify current song", () => {
  function makeCmdCtx(currentPlatform: string) {
    return {
      player: { pause: vi.fn(), resume: vi.fn(), stop: vi.fn() },
      spotifyController: {
        pause: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
        stop: vi.fn(() => {}),
      },
      queue: { current: vi.fn(() => ({ platform: currentPlatform })), clear: vi.fn() },
      logger: { warn: vi.fn() },
      emit: vi.fn(),
      autoPaused: true,
      currentSourceIsSpotify: true,
      sweepLocalAudio: vi.fn(),
      disableFmMode: vi.fn(),
      profileManager: { onSongChange: vi.fn(async () => {}) },
    } as any;
  }

  it("cmdPause delegates to controller.pause when current is spotify", () => {
    const ctx = makeCmdCtx("spotify");
    cmdPause.call(ctx);
    expect(ctx.player.pause).toHaveBeenCalled();
    expect(ctx.spotifyController.pause).toHaveBeenCalledTimes(1);
  });

  it("cmdResume delegates to controller.resume when current is spotify", () => {
    const ctx = makeCmdCtx("spotify");
    cmdResume.call(ctx);
    expect(ctx.player.resume).toHaveBeenCalled();
    expect(ctx.spotifyController.resume).toHaveBeenCalledTimes(1);
  });

  it("cmdStop stops the sidecar + player and clears the spotify flag", () => {
    const ctx = makeCmdCtx("spotify");
    cmdStop.call(ctx);
    expect(ctx.spotifyController.stop).toHaveBeenCalledTimes(1);
    expect(ctx.player.stop).toHaveBeenCalledTimes(1);
    expect(ctx.queue.clear).toHaveBeenCalledTimes(1);
    expect(ctx.currentSourceIsSpotify).toBe(false);
  });

  it("does NOT touch the controller when current is not spotify", () => {
    const ctx = makeCmdCtx("netease");
    cmdPause.call(ctx);
    cmdResume.call(ctx);
    expect(ctx.spotifyController.pause).not.toHaveBeenCalled();
    expect(ctx.spotifyController.resume).not.toHaveBeenCalled();
  });
});

// --- R3-2: removing the currently-playing Spotify track ---------------------
// queue.remove() of the current index only decrements currentIndex; it never
// stops the player or sidecar. A spotify track has NO player self-EOF advance
// path, so leaving the sidecar running while queue.current() is no longer that
// track wedges the bot in silence. cmdRemove must reconcile: stop the sidecar
// and advance (or stop cleanly) — but ONLY for a current spotify track.
describe("BotInstance.cmdRemove — spotify current-track reconciliation (R3-2)", () => {
  function makeRemoveCtx(opts: {
    currentIndex: number;
    currentSourceIsSpotify: boolean;
    removed: any;
  }) {
    return {
      currentSourceIsSpotify: opts.currentSourceIsSpotify,
      queue: {
        getCurrentIndex: vi.fn(() => opts.currentIndex),
        remove: vi.fn(() => opts.removed),
      },
      spotifyController: makeController(),
      player: makePlayer(),
      playNext: vi.fn(async () => true),
      sweepLocalAudio: vi.fn(),
      emit: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as any;
  }

  it("stops the sidecar and advances when removing the CURRENT spotify track", async () => {
    const ctx = makeRemoveCtx({
      currentIndex: 0,
      currentSourceIsSpotify: true,
      removed: { name: "A", platform: "spotify" },
    });

    const reply = await cmdRemove.call(ctx, { args: "1" }); // index 0 == current

    expect(reply).toContain("Removed: A");
    expect(ctx.spotifyController.stop).toHaveBeenCalledTimes(1);
    expect(ctx.currentSourceIsSpotify).toBe(false);
    expect(ctx.player.stop).toHaveBeenCalledTimes(1);
    // Advance to whatever is now current (or stop cleanly if empty).
    expect(ctx.playNext).toHaveBeenCalledTimes(1);
  });

  it("does NOT stop the sidecar when removing a NON-current track", async () => {
    const ctx = makeRemoveCtx({
      currentIndex: 0,
      currentSourceIsSpotify: true,
      removed: { name: "B", platform: "spotify" },
    });

    await cmdRemove.call(ctx, { args: "2" }); // index 1 != current (0)

    expect(ctx.spotifyController.stop).not.toHaveBeenCalled();
    expect(ctx.player.stop).not.toHaveBeenCalled();
    expect(ctx.playNext).not.toHaveBeenCalled();
    expect(ctx.currentSourceIsSpotify).toBe(true);
  });

  it("does NOT stop the sidecar when the current track is NOT spotify (URL self-heals)", async () => {
    const ctx = makeRemoveCtx({
      currentIndex: 0,
      currentSourceIsSpotify: false, // current is a URL track
      removed: { name: "A", platform: "netease" },
    });

    await cmdRemove.call(ctx, { args: "1" }); // index 0 == current

    expect(ctx.spotifyController.stop).not.toHaveBeenCalled();
    expect(ctx.player.stop).not.toHaveBeenCalled();
    expect(ctx.playNext).not.toHaveBeenCalled();
  });

  it("returns 'Invalid position' without touching the sidecar on a bad index", async () => {
    const ctx = makeRemoveCtx({
      currentIndex: 0,
      currentSourceIsSpotify: true,
      removed: null, // queue.remove() rejects the index
    });

    const reply = await cmdRemove.call(ctx, { args: "9" });

    expect(reply).toBe("Invalid position");
    expect(ctx.spotifyController.stop).not.toHaveBeenCalled();
    expect(ctx.playNext).not.toHaveBeenCalled();
  });
});

// --- R3-6: queue exhausts on a spotify track --------------------------------
// playNext's exhausted (non-FM) branch only called player.stop(); it left the
// sidecar decoding and currentSourceIsSpotify stale — diverging from cmdStop.
describe("BotInstance.playNext — spotify teardown on queue exhaust (R3-6)", () => {
  function makeExhaustCtx(opts: { currentSourceIsSpotify: boolean }) {
    return {
      connected: true,
      isAdvancing: false,
      isFmMode: false,
      currentSourceIsSpotify: opts.currentSourceIsSpotify,
      voteSkipUsers: new Set<string>(),
      queue: { next: vi.fn(() => null), unplayedCount: vi.fn(() => 0) },
      player: makePlayer(),
      spotifyController: makeController(),
      profileManager: { onSongChange: vi.fn(async () => {}) },
      resolveAndPlay: vi.fn(async () => true),
      sweepLocalAudio: vi.fn(),
      emit: vi.fn(),
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as any;
  }

  it("stops the sidecar and clears the flag when a spotify queue exhausts", async () => {
    const ctx = makeExhaustCtx({ currentSourceIsSpotify: true });

    const started = await playNext.call(ctx);

    expect(started).toBe(false);
    expect(ctx.spotifyController.stop).toHaveBeenCalledTimes(1);
    expect(ctx.currentSourceIsSpotify).toBe(false);
    expect(ctx.player.stop).toHaveBeenCalledTimes(1);
  });

  it("does NOT stop the sidecar when a NON-spotify queue exhausts", async () => {
    const ctx = makeExhaustCtx({ currentSourceIsSpotify: false });

    const started = await playNext.call(ctx);

    expect(started).toBe(false);
    expect(ctx.spotifyController.stop).not.toHaveBeenCalled();
    expect(ctx.player.stop).toHaveBeenCalledTimes(1);
  });
});

describe("BotInstance.handleOccupancy — spotify auto-pause delegation (C4)", () => {
  function makeOccupancyCtx(currentPlatform: string, state: string) {
    return {
      player: { getState: () => state, pause: vi.fn(), resume: vi.fn() },
      spotifyController: { pause: vi.fn(async () => {}), resume: vi.fn(async () => {}) },
      queue: { current: vi.fn(() => ({ platform: currentPlatform })) },
      config: { autoPauseOnEmpty: true },
      autoPaused: false,
      logger: { warn: vi.fn() },
      emit: vi.fn(),
      _scheduleIdleCheck: vi.fn(),
      _cancelIdleTimer: vi.fn(),
    } as any;
  }

  it("delegates pause to the controller when auto-pausing a spotify track (empty channel)", () => {
    const ctx = makeOccupancyCtx("spotify", "playing");
    handleOccupancy.call(ctx, 0);
    expect(ctx.player.pause).toHaveBeenCalledTimes(1);
    expect(ctx.spotifyController.pause).toHaveBeenCalledTimes(1);
    expect(ctx.autoPaused).toBe(true);
  });

  it("delegates resume to the controller when a listener returns to a spotify track", () => {
    const ctx = makeOccupancyCtx("spotify", "paused");
    ctx.autoPaused = true;
    handleOccupancy.call(ctx, 1);
    expect(ctx.player.resume).toHaveBeenCalledTimes(1);
    expect(ctx.spotifyController.resume).toHaveBeenCalledTimes(1);
    expect(ctx.autoPaused).toBe(false);
  });

  it("does NOT touch the controller when auto-pausing a non-spotify track", () => {
    const ctx = makeOccupancyCtx("netease", "playing");
    handleOccupancy.call(ctx, 0);
    expect(ctx.player.pause).toHaveBeenCalledTimes(1);
    expect(ctx.spotifyController.pause).not.toHaveBeenCalled();
  });
});

describe("BotInstance.seek — spotify routing (C4)", () => {
  function makeSeekCtx(currentPlatform: string) {
    return {
      queue: { current: vi.fn(() => ({ platform: currentPlatform })) },
      spotifyController: { seek: vi.fn(async () => {}) },
      player: { seek: vi.fn() },
      logger: { warn: vi.fn() },
    } as any;
  }

  it("routes seek to the controller for a spotify track, converting seconds -> ms", () => {
    const ctx = makeSeekCtx("spotify");
    seek.call(ctx, 30); // 30 seconds
    // SpotifyController.seek is millisecond-based: 30s -> 30000ms (not 30).
    expect(ctx.spotifyController.seek).toHaveBeenCalledWith(30000);
    expect(ctx.player.seek).not.toHaveBeenCalled();
  });

  it("routes seek to the player (seconds-based) for a non-spotify track", () => {
    const ctx = makeSeekCtx("netease");
    seek.call(ctx, 30);
    expect(ctx.player.seek).toHaveBeenCalledWith(30);
    expect(ctx.spotifyController.seek).not.toHaveBeenCalled();
  });
});

// --- Spotify OAuth threading (Task 6, C3.1) --------------------------------
// The process-wide shared SpotifyOAuth must reach the SpotifyController via the
// controller factory. We drive the REAL BotInstance constructor with a fake
// controller factory that captures its param object, so the thread is observed
// end-to-end (options.spotifyOAuth -> buildController({ oauth })).
describe("BotInstance — spotifyOAuth threading to the controller factory (C3.1)", () => {
  function makeInstanceOptions(over: Partial<BotInstanceOptions> = {}): {
    options: BotInstanceOptions;
    captured: { param?: { oauth?: SpotifyOAuth; instanceId?: string } };
  } {
    const captured: { param?: { oauth?: SpotifyOAuth; instanceId?: string } } = {};
    const provider = { platform: "netease" } as unknown as MusicProvider;
    const logger: any = {
      info() {}, warn() {}, error() {}, debug() {},
      child() { return logger; },
    };
    const database = {
      getProfileConfig: () => ({}),
      getCustomAvatarPath: () => null,
      getPlayerSettings: () => ({ volume: 75, playMode: "seq" }),
      saveVolume: () => {},
      savePlayMode: () => {},
    } as unknown as BotDatabase;
    const options: BotInstanceOptions = {
      id: "bot-oauth-test",
      name: "OAuthBot",
      tsOptions: { host: "localhost", port: 9987, queryPort: 10011, nickname: "OAuthBot" } as any,
      neteaseProvider: provider,
      qqProvider: provider,
      bilibiliProvider: provider,
      youtubeProvider: provider,
      database,
      config: { spotify: {} } as unknown as BotConfig,
      logger,
      avatarStore: { read: () => null } as unknown as AvatarStore,
      spotifyControllerFactory: (o) => {
        captured.param = o;
        // Only `on` is touched during construction (setupPlayerEvents wires
        // the "trackEnded" listener); return a minimal fake controller.
        return { on: () => {} } as unknown as SpotifyController;
      },
      ...over,
    };
    return { options, captured };
  }

  it("forwards the injected spotifyOAuth to the controller factory as `oauth`", () => {
    const sentinel = {} as unknown as SpotifyOAuth;
    const { options, captured } = makeInstanceOptions({ spotifyOAuth: sentinel });
    // eslint-disable-next-line no-new
    new BotInstance(options);
    expect(captured.param).toBeDefined();
    expect(captured.param?.oauth).toBe(sentinel);
  });

  it("leaves the factory `oauth` undefined when no spotifyOAuth is supplied (behavior-unchanged)", () => {
    const { options, captured } = makeInstanceOptions();
    // eslint-disable-next-line no-new
    new BotInstance(options);
    expect(captured.param).toBeDefined();
    expect(captured.param?.oauth).toBeUndefined();
  });

  // R2-5: the bot id must reach the controller as `instanceId` so the backend
  // derives a UNIQUE Spotify Connect device name (<base>-<id>). Without it two
  // bots share the process-global deviceName and Connect commands misroute.
  it("forwards the bot id to the controller factory as `instanceId` (corner-case R2-5)", () => {
    const { options, captured } = makeInstanceOptions({ id: "bot-xyz" });
    // eslint-disable-next-line no-new
    new BotInstance(options);
    expect(captured.param).toBeDefined();
    expect(captured.param?.instanceId).toBe("bot-xyz");
  });
});

describe("spotifyPortsForBotId — per-bot go-librespot ports (Fix 3)", () => {
  it("yields the SAME ports for the same bot id (stable across restarts)", () => {
    const a = spotifyPortsForBotId("bot-alpha");
    const b = spotifyPortsForBotId("bot-alpha");
    expect(a).toEqual(b);
  });

  it("yields DIFFERENT ports for different bot ids", () => {
    const a = spotifyPortsForBotId("bot-alpha");
    const b = spotifyPortsForBotId("bot-beta");
    expect(a.apiPort).not.toBe(b.apiPort);
    expect(a.callbackPort).not.toBe(b.callbackPort);
  });

  it("keeps apiPort and callbackPort in disjoint ranges", () => {
    for (const id of ["bot-alpha", "bot-beta", "x", "a-very-long-bot-identifier-123"]) {
      const { apiPort, callbackPort } = spotifyPortsForBotId(id);
      expect(apiPort).toBeGreaterThanOrEqual(3700);
      expect(apiPort).toBeLessThan(4700);
      expect(callbackPort).toBeGreaterThanOrEqual(8700);
      expect(callbackPort).toBeLessThan(9700);
      // Same offset within each range → the two never collide with each other.
      expect(callbackPort - apiPort).toBe(5000);
    }
  });
});

// --- Persisting volume + play mode across restarts (#125) ------------------
const cmdVol = (BotInstance.prototype as any).cmdVol as (this: unknown, cmd: any) => string;
const cmdMode = (BotInstance.prototype as any).cmdMode as (this: unknown, cmd: any) => string;

describe("BotInstance.cmdVol — persistence (#125)", () => {
  function makeVolCtx() {
    let stored = 75;
    return {
      id: "bot1",
      player: {
        setVolume: vi.fn((v: number) => { stored = v; }),
        getVolume: vi.fn(() => stored),
      },
      database: { saveVolume: vi.fn() },
      logger: { warn: vi.fn() },
      emit: vi.fn(),
      // The real private persist helper lives on the prototype; wire it so the
      // test exercises the shipped persistence path end-to-end.
      persistVolume: (BotInstance.prototype as any).persistVolume,
    } as any;
  }

  it("saves the new volume via database.saveVolume (covers chat !vol AND the REST endpoint)", () => {
    const ctx = makeVolCtx();
    const res = cmdVol.call(ctx, { args: "40" });
    expect(res).toBe("Volume set to 40%");
    expect(ctx.player.setVolume).toHaveBeenCalledWith(40);
    expect(ctx.database.saveVolume).toHaveBeenCalledWith("bot1", 40);
    expect(ctx.emit).toHaveBeenCalledWith("stateChange");
  });

  it("does not persist an out-of-range volume", () => {
    const ctx = makeVolCtx();
    const res = cmdVol.call(ctx, { args: "999" });
    expect(res).toBe("Usage: !vol <0-100>");
    expect(ctx.player.setVolume).not.toHaveBeenCalled();
    expect(ctx.database.saveVolume).not.toHaveBeenCalled();
  });

  it("swallows a database error so the volume change still succeeds", () => {
    const ctx = makeVolCtx();
    ctx.database.saveVolume = vi.fn(() => { throw new Error("disk full"); });
    const res = cmdVol.call(ctx, { args: "50" });
    expect(res).toBe("Volume set to 50%");
    expect(ctx.player.setVolume).toHaveBeenCalledWith(50);
    expect(ctx.logger.warn).toHaveBeenCalled();
  });
});

describe("BotInstance.cmdMode — persistence (#125)", () => {
  function makeModeCtx() {
    let mode = "seq";
    return {
      id: "bot1",
      queue: {
        setMode: vi.fn((m: string) => { mode = m; }),
        getMode: vi.fn(() => mode),
      },
      database: { savePlayMode: vi.fn() },
      logger: { warn: vi.fn() },
      emit: vi.fn(),
      persistPlayMode: (BotInstance.prototype as any).persistPlayMode,
    } as any;
  }

  it("saves the new play mode via database.savePlayMode", () => {
    const ctx = makeModeCtx();
    const res = cmdMode.call(ctx, { args: "rloop" });
    expect(res).toBe("Play mode set to: rloop");
    expect(ctx.queue.setMode).toHaveBeenCalledWith("rloop");
    expect(ctx.database.savePlayMode).toHaveBeenCalledWith("bot1", "rloop");
    expect(ctx.emit).toHaveBeenCalledWith("stateChange");
  });

  it("does not persist an unknown mode", () => {
    const ctx = makeModeCtx();
    const res = cmdMode.call(ctx, { args: "bogus" });
    expect(res).toBe("Usage: !mode <seq|loop|random|rloop>");
    expect(ctx.queue.setMode).not.toHaveBeenCalled();
    expect(ctx.database.savePlayMode).not.toHaveBeenCalled();
  });
});

describe("BotInstance — restores persisted player settings on construction (#125)", () => {
  const provider = { platform: "netease" } as unknown as MusicProvider;
  function makeOptions(id: string, database: BotDatabase): BotInstanceOptions {
    const logger: any = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } };
    return {
      id,
      name: "RestoreBot",
      tsOptions: { host: "localhost", port: 9987, queryPort: 10011, nickname: "RestoreBot" } as any,
      neteaseProvider: provider,
      qqProvider: provider,
      bilibiliProvider: provider,
      youtubeProvider: provider,
      database,
      config: { spotify: {} } as unknown as BotConfig,
      logger,
      avatarStore: { read: () => null } as unknown as AvatarStore,
      spotifyControllerFactory: () => ({ on: () => {} } as unknown as SpotifyController),
    };
  }

  it("applies the saved volume + play mode from the database", () => {
    const db = createDatabase(":memory:");
    db.saveBotInstance({
      id: "bot-restore", name: "B", serverAddress: "x", serverPort: 9987, nickname: "n",
      defaultChannel: "", channelId: "", channelPassword: "", autoStart: false,
      serverProtocol: "", ts6ApiKey: "", serverPassword: "",
    });
    db.saveVolume("bot-restore", 33);
    db.savePlayMode("bot-restore", "loop");

    const bot = new BotInstance(makeOptions("bot-restore", db));
    const status = bot.getStatus();
    expect(status.volume).toBe(33);
    expect(status.playMode).toBe("loop");
    db.close();
  });

  it("falls back to defaults for a bot with no saved settings", () => {
    const db = createDatabase(":memory:");
    const bot = new BotInstance(makeOptions("brand-new", db));
    const status = bot.getStatus();
    expect(status.volume).toBe(75);
    expect(status.playMode).toBe("seq");
    db.close();
  });
});

describe("BotInstance.handleTextMessage — response chunking (#116)", () => {
  it("splits a long command response into multiple sends, each under the byte cap", async () => {
    const ctx = makeGateCtx({ adminGroups: [] });
    const longResponse = Array.from(
      { length: 200 },
      (_, i) => `歌词 line number ${i} with some content`,
    ).join("\n");
    ctx.executeCommand = vi.fn(async () => longResponse);

    await handleTextMessage.call(ctx, makeMsg("!lyrics"));

    const calls = ctx.tsClient.sendTextMessage.mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const [chunk] of calls) {
      expect(Buffer.byteLength(chunk as string, "utf8")).toBeLessThanOrEqual(900);
    }
  });

  it("sends a short command response as a single message", async () => {
    const ctx = makeGateCtx({ adminGroups: [] });
    ctx.executeCommand = vi.fn(async () => "short reply");

    await handleTextMessage.call(ctx, makeMsg("!lyrics"));

    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(ctx.tsClient.sendTextMessage).toHaveBeenCalledWith("short reply");
  });
});

const cmdLyrics = (BotInstance.prototype as any).cmdLyrics as (
  this: unknown,
) => Promise<string>;

describe("BotInstance.cmdLyrics — full lyrics (#116)", () => {
  it("returns ALL lyric lines, not just the first 10", async () => {
    const lyricLines = Array.from({ length: 30 }, (_, i) => ({
      time: i,
      text: `lyric line ${i}`,
    }));
    const ctx: any = {
      queue: { current: () => ({ id: "s1", name: "Song", platform: "netease" }) },
      getProviderFor: () => ({ getLyrics: vi.fn(async () => lyricLines) }),
    };

    const out = await cmdLyrics.call(ctx);

    for (const l of lyricLines) {
      expect(out).toContain(l.text);
    }
    expect(out.startsWith("Lyrics for Song:")).toBe(true);
  });

  it("returns 'No lyrics available' when the provider has none", async () => {
    const ctx: any = {
      queue: { current: () => ({ id: "s1", name: "Song", platform: "netease" }) },
      getProviderFor: () => ({ getLyrics: vi.fn(async () => []) }),
    };
    expect(await cmdLyrics.call(ctx)).toBe("No lyrics available");
  });
});

// ─── Saved queues + live-queue persistence + playKeepsQueue (#119) ─────────
// All exercise the ACTUAL shipped methods via their prototype, bound to a
// minimal ctx — the same lightweight pattern as the cmd* tests above.
const playSingleSong = BotInstance.prototype.playSingleSong as (
  this: unknown,
  song: unknown,
  requesterName?: string,
) => Promise<boolean>;
const loadSavedQueue = BotInstance.prototype.loadSavedQueue as (
  this: unknown,
  songs: unknown[],
  mode: "replace" | "append",
  requesterName?: string,
) => Promise<void>;
const cmdSaveQueue = (BotInstance.prototype as any).cmdSaveQueue as (this: unknown, cmd: any) => string;
const cmdLoadQueue = (BotInstance.prototype as any).cmdLoadQueue as (this: unknown, cmd: any) => Promise<string>;
const cmdListQueues = (BotInstance.prototype as any).cmdListQueues as (this: unknown) => string;
const persistQueueSnapshot = (BotInstance.prototype as any).persistQueueSnapshot as (this: unknown) => void;
const scheduleQueueSnapshot = (BotInstance.prototype as any).scheduleQueueSnapshot as (this: unknown) => void;
const restoreQueueFromSnapshot = (BotInstance.prototype as any).restoreQueueFromSnapshot as (this: unknown) => Promise<void>;

const withRequester = (BotInstance.prototype as any).withRequester;
const isSameSong = (BotInstance.prototype as any).isSameSong;
const savedQueuesGuard = (BotInstance.prototype as any).savedQueuesGuard;

function song119(id: string) {
  return { id, name: id, artist: "", album: "", platform: "netease" as const, coverUrl: "", duration: 1 };
}
function makePlayer119() {
  let state: "idle" | "playing" | "paused" = "idle";
  return {
    stop: vi.fn(() => { state = "idle"; }),
    resetFailures: vi.fn(),
    getState: vi.fn(() => state),
    _play: () => { state = "playing"; },
  };
}

describe("BotInstance.playSingleSong / playKeepsQueue (#119)", () => {
  function makeCtx(playKeepsQueue: boolean) {
    const queue = new PlayQueue();
    return {
      config: { playKeepsQueue },
      queue,
      player: makePlayer119(),
      withRequester,
      isSameSong,
      disableFmMode: vi.fn(),
      sweepLocalAudio: vi.fn(),
      resolveAndPlay: vi.fn(async () => true),
    } as any;
  }

  it("clears the queue when playKeepsQueue is false (default)", async () => {
    const ctx = makeCtx(false);
    ctx.queue.add(song119("a"));
    ctx.queue.play();
    const ok = await playSingleSong.call(ctx, song119("b"), "alice");
    expect(ok).toBe(true);
    expect(ctx.queue.list().map((s: any) => s.id)).toEqual(["b"]);
    expect(ctx.queue.current()?.id).toBe("b");
    expect(ctx.sweepLocalAudio).toHaveBeenCalled();
  });

  it("inserts-after-current and keeps the queue when playKeepsQueue is true", async () => {
    const ctx = makeCtx(true);
    ctx.queue.add(song119("a"));
    ctx.queue.add(song119("c"));
    ctx.queue.play(); // current = a (index 0)
    await playSingleSong.call(ctx, song119("b"), "alice");
    expect(ctx.queue.list().map((s: any) => s.id)).toEqual(["a", "b", "c"]);
    expect(ctx.queue.current()?.id).toBe("b");
    expect(ctx.queue.current()?.requestedBy).toBe("alice");
    // Keep-queue mode must not sweep local uploads (nothing was released).
    expect(ctx.sweepLocalAudio).not.toHaveBeenCalled();
  });

  it("falls back to clear-and-play when playKeepsQueue is true but the queue is empty", async () => {
    const ctx = makeCtx(true);
    await playSingleSong.call(ctx, song119("b"), "alice");
    expect(ctx.queue.list().map((s: any) => s.id)).toEqual(["b"]);
    expect(ctx.queue.current()?.id).toBe("b");
  });
});

describe("BotInstance.loadSavedQueue (#119)", () => {
  function makeCtx() {
    const player = makePlayer119();
    return {
      queue: new PlayQueue(),
      player,
      withRequester,
      disableFmMode: vi.fn(),
      sweepLocalAudio: vi.fn(),
      resolveAndPlay: vi.fn(async () => { player._play(); return true; }),
      emit: vi.fn(),
    } as any;
  }

  it("replace clears + plays from the first track", async () => {
    const ctx = makeCtx();
    ctx.queue.add(song119("old"));
    ctx.queue.play();
    await loadSavedQueue.call(ctx, [song119("a"), song119("b")], "replace", "bob");
    expect(ctx.queue.list().map((s: any) => s.id)).toEqual(["a", "b"]);
    expect(ctx.queue.current()?.id).toBe("a");
    expect(ctx.queue.current()?.requestedBy).toBe("bob");
    expect(ctx.disableFmMode).toHaveBeenCalled();
    expect(ctx.resolveAndPlay).toHaveBeenCalled();
    expect(ctx.emit).toHaveBeenCalledWith("stateChange");
  });

  it("append adds to the end and starts playing only when idle", async () => {
    const ctx = makeCtx();
    // Idle bot with an existing (not playing) queue entry.
    ctx.queue.add(song119("x"));
    await loadSavedQueue.call(ctx, [song119("a"), song119("b")], "append");
    expect(ctx.queue.list().map((s: any) => s.id)).toEqual(["x", "a", "b"]);
    // wasIdle → start the first appended song (index 1).
    expect(ctx.queue.current()?.id).toBe("a");
    expect(ctx.resolveAndPlay).toHaveBeenCalledTimes(1);
  });

  it("append does not interrupt a playing track", async () => {
    const ctx = makeCtx();
    ctx.player._play(); // player is 'playing'
    ctx.queue.add(song119("x"));
    ctx.queue.play(); // current = x
    await loadSavedQueue.call(ctx, [song119("a")], "append");
    expect(ctx.queue.list().map((s: any) => s.id)).toEqual(["x", "a"]);
    expect(ctx.queue.current()?.id).toBe("x");
    expect(ctx.resolveAndPlay).not.toHaveBeenCalled();
  });
});

describe("BotInstance chat save/load/queues (#119)", () => {
  function makeCtx(enabled: boolean, db = createDatabase(":memory:")) {
    const queue = new PlayQueue();
    return {
      config: { savedQueuesEnabled: enabled, commandPrefix: "!" },
      queue,
      database: db,
      savedQueuesGuard,
      loadSavedQueue: vi.fn(async () => {}),
    } as any;
  }

  it("replies 此功能未启用 when the feature is disabled", () => {
    const ctx = makeCtx(false);
    expect(cmdSaveQueue.call(ctx, parseCommand("!save night", "!")!)).toBe("此功能未启用");
    expect(cmdListQueues.call(ctx)).toBe("此功能未启用");
  });

  it("refuses saving an empty queue", () => {
    const ctx = makeCtx(true);
    expect(cmdSaveQueue.call(ctx, parseCommand("!save night", "!")!)).toBe("队列为空，无法保存");
  });

  it("saves the current queue to the shared bucket and lists it", () => {
    const ctx = makeCtx(true);
    ctx.queue.add(song119("a"));
    ctx.queue.add(song119("b"));
    const reply = cmdSaveQueue.call(ctx, parseCommand("!save night", "!")!);
    expect(reply).toContain("已保存队列");
    expect(ctx.database.listSavedQueues(SHARED_QUEUE_OWNER, false).map((x: any) => x.name)).toContain("night");
    expect(cmdListQueues.call(ctx)).toContain("night");
  });

  it("loads a saved queue by name (replace by default, -a appends)", async () => {
    const db = createDatabase(":memory:");
    const ctx = makeCtx(true, db);
    db.saveQueue(SHARED_QUEUE_OWNER, "night", [song119("a")]);
    const rep = await cmdLoadQueue.call(ctx, parseCommand("!load night", "!")!);
    expect(rep).toContain("已加载");
    expect(ctx.loadSavedQueue).toHaveBeenCalledWith(expect.any(Array), "replace");

    const repA = await cmdLoadQueue.call(ctx, parseCommand("!load -a night", "!")!);
    expect(repA).toContain("已追加");
    expect(ctx.loadSavedQueue).toHaveBeenLastCalledWith(expect.any(Array), "append");
  });

  it("reports a missing saved queue", async () => {
    const ctx = makeCtx(true);
    expect(await cmdLoadQueue.call(ctx, parseCommand("!load nope", "!")!)).toContain("找不到");
  });
});

describe("BotInstance live-queue persistence (#119)", () => {
  function makeCtx(enabled: boolean, db = createDatabase(":memory:")) {
    return {
      id: "bot1",
      config: { savedQueuesEnabled: enabled },
      queue: new PlayQueue(),
      database: db,
      isFmMode: false,
      fmProvider: null,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      player: makePlayer119(),
      resolveAndPlay: vi.fn(async () => true),
      getProviderFor: vi.fn(() => ({ platform: "netease" })),
    } as any;
  }

  it("persists a snapshot when enabled", () => {
    const ctx = makeCtx(true);
    ctx.queue.add(song119("a"));
    ctx.queue.play();
    persistQueueSnapshot.call(ctx);
    const st = ctx.database.getQueueState("bot1")!;
    expect(st.songs.map((s: any) => s.id)).toEqual(["a"]);
    expect(st.currentIndex).toBe(0);
  });

  it("does NOT persist when the feature is disabled", () => {
    const ctx = makeCtx(false);
    ctx.queue.add(song119("a"));
    ctx.queue.play();
    persistQueueSnapshot.call(ctx);
    expect(ctx.database.getQueueState("bot1")).toBeNull();
  });

  it("clears the persisted row when the queue is empty", () => {
    const db = createDatabase(":memory:");
    db.saveQueueState({ botId: "bot1", songs: [song119("a")], currentIndex: 0, mode: "seq", isFmMode: false, fmPlatform: "" });
    const ctx = makeCtx(true, db);
    persistQueueSnapshot.call(ctx); // queue is empty
    expect(db.getQueueState("bot1")).toBeNull();
  });

  it("restores and resumes the current track on restore", async () => {
    const db = createDatabase(":memory:");
    db.saveQueueState({ botId: "bot1", songs: [song119("a"), song119("b")], currentIndex: 1, mode: "loop", isFmMode: false, fmPlatform: "" });
    const ctx = makeCtx(true, db);
    await restoreQueueFromSnapshot.call(ctx);
    expect(ctx.queue.list().map((s: any) => s.id)).toEqual(["a", "b"]);
    expect(ctx.queue.getCurrentIndex()).toBe(1);
    expect(ctx.queue.getMode()).toBe(PlayMode.Loop);
    expect(ctx.resolveAndPlay).toHaveBeenCalledTimes(1);
  });

  it("restores FM mode + provider from the snapshot", async () => {
    const db = createDatabase(":memory:");
    db.saveQueueState({ botId: "bot1", songs: [song119("a")], currentIndex: 0, mode: "random", isFmMode: true, fmPlatform: "qq" });
    const ctx = makeCtx(true, db);
    await restoreQueueFromSnapshot.call(ctx);
    expect(ctx.isFmMode).toBe(true);
    expect(ctx.getProviderFor).toHaveBeenCalledWith("qq");
  });

  it("does nothing when the feature is disabled", async () => {
    const db = createDatabase(":memory:");
    db.saveQueueState({ botId: "bot1", songs: [song119("a")], currentIndex: 0, mode: "seq", isFmMode: false, fmPlatform: "" });
    const ctx = makeCtx(false, db);
    await restoreQueueFromSnapshot.call(ctx);
    expect(ctx.queue.list()).toEqual([]);
    expect(ctx.resolveAndPlay).not.toHaveBeenCalled();
  });

  it("a cancelled snapshot timer does not wipe persisted state (disconnect race)", () => {
    vi.useFakeTimers();
    try {
      const db = createDatabase(":memory:");
      db.saveQueueState({ botId: "bot1", songs: [song119("a")], currentIndex: 0, mode: "seq", isFmMode: false, fmPlatform: "" });
      const ctx = makeCtx(true, db);
      ctx.queue.add(song119("a"));
      ctx.queue.play();
      // Debounced snapshot scheduled, then a disconnect clears the queue and
      // cancels the pending timer — the persisted row must survive for restore.
      scheduleQueueSnapshot.call(ctx);
      ctx.queue.clear();
      if (ctx.snapshotTimer) clearTimeout(ctx.snapshotTimer);
      vi.advanceTimersByTime(3000);
      expect(db.getQueueState("bot1")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
