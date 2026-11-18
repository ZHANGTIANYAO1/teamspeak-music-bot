import { describe, it, expect, beforeEach, vi } from "vitest";
import { BotProfileManager } from "./profile.js";
import { TS6HttpQuery } from "../ts-protocol/http-query.js";
import type { TS3Client } from "../ts-protocol/client.js";
import type { QueuedSong } from "../audio/queue.js";

function makeMockTs(): TS3Client & {
  uploadCalls: Buffer[];
  clearCalls: number;
} {
  const calls: Buffer[] = [];
  let clears = 0;
  const ts: any = {
    uploadCalls: calls,
    get clearCalls() { return clears; },
    getHost: () => "127.0.0.1",
    getHttpQuery: () => null,
    getClientId: () => 17,
    getChannelId: () => 5n,
    execCommand: vi.fn().mockResolvedValue(undefined),
    fileTransferInitUpload: vi.fn().mockResolvedValue({}),
    uploadFileData: vi.fn().mockImplementation(async (_h: any, _i: any, stream: any) => {
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      calls.push(Buffer.concat(chunks));
    }),
    fileTransferDeleteFile: vi.fn().mockResolvedValue(undefined),
    sendCommandNoWait: vi.fn().mockImplementation(async (cmd: string) => {
      if (/client_flag_avatar=$/.test(cmd)) clears++;
    }),
  };
  return ts;
}

const noopLogger: any = { child: () => noopLogger, info: () => {}, debug: () => {}, warn: () => {}, error: () => {} };

const cfgOn = { avatarEnabled: true, descriptionEnabled: false, nicknameEnabled: false, awayStatusEnabled: false, channelDescEnabled: false, nowPlayingMsgEnabled: false };
const cfgOff = { ...cfgOn, avatarEnabled: false };

const fakeSong: QueuedSong = {
  id: "1",
  name: "X",
  artist: "Y",
  album: "Z",
  platform: "netease",
  url: "u",
  coverUrl: "c",
  duration: 100,
};

const flush = () => new Promise((r) => setImmediate(r));

describe("BotProfileManager custom avatar precedence", () => {
  let ts: ReturnType<typeof makeMockTs>;
  beforeEach(() => { ts = makeMockTs(); });

  it("setCustomAvatar uploads immediately on a fresh idle bot (sync on)", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    pm.setCustomAvatar(Buffer.from([1, 2, 3]));
    await flush();
    expect(ts.uploadCalls.length).toBe(1);
    expect(ts.uploadCalls[0].equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it("setCustomAvatar uploads immediately when sync is off (always idle)", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOff, "Bot");
    pm.setCustomAvatar(Buffer.from([7]));
    await flush();
    expect(ts.uploadCalls.length).toBe(1);
  });

  it("setCustomAvatar while playing + sync on does NOT push (cover wins)", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    // Simulate the bot playing a song. We can't actually run updateAvatar's
    // full HTTP fetch path, but onSongChange records currentSong before
    // updateAvatar runs, which is enough for this assertion.
    void pm.onSongChange(fakeSong);
    await flush();
    const uploadsBefore = ts.uploadCalls.length;
    pm.setCustomAvatar(Buffer.from([42]));
    await flush();
    expect(ts.uploadCalls.length).toBe(uploadsBefore); // no new upload
  });

  it("setCustomAvatar while playing + sync off DOES push (sync-off is idle)", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOff, "Bot");
    void pm.onSongChange(fakeSong);
    await flush();
    const uploadsBefore = ts.uploadCalls.length;
    pm.setCustomAvatar(Buffer.from([42]));
    await flush();
    expect(ts.uploadCalls.length).toBe(uploadsBefore + 1);
  });

  it("setCustomAvatar(null) while idle clears the TS3 avatar", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    pm.setCustomAvatar(Buffer.from([1]));
    await flush();
    const clearsBefore = ts.clearCalls;
    pm.setCustomAvatar(null);
    await flush();
    expect(ts.clearCalls).toBe(clearsBefore + 1);
  });

  it("on stop with custom avatar set + sync on, restores custom (does not clear)", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    pm.setCustomAvatar(Buffer.from([1, 2, 3, 4]));
    await flush();
    const clearsBefore = ts.clearCalls;
    await pm.onSongChange(null);
    expect(ts.uploadCalls.at(-1)?.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    expect(ts.clearCalls).toBe(clearsBefore); // no extra clear
  });

  it("on stop with no custom avatar, falls back to clear", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    await pm.onSongChange(null);
    expect(ts.clearCalls).toBe(1);
    expect(ts.uploadCalls.length).toBe(0);
  });

  it("on connect with custom avatar set + sync ON, applies custom (spec matrix row 1)", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    pm.setCustomAvatar(Buffer.from([5, 5]));
    await flush();
    ts.uploadCalls.length = 0; // reset
    pm.onConnect();
    await flush();
    expect(ts.uploadCalls.length).toBe(1);
    expect(ts.uploadCalls[0].equals(Buffer.from([5, 5]))).toBe(true);
  });

  it("on connect with custom avatar set + sync OFF, applies custom", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOff, "Bot");
    pm.setCustomAvatar(Buffer.from([9, 9]));
    await flush();
    ts.uploadCalls.length = 0;
    pm.onConnect();
    await flush();
    expect(ts.uploadCalls.length).toBe(1);
    expect(ts.uploadCalls[0].equals(Buffer.from([9, 9]))).toBe(true);
  });

  it("on connect with no custom avatar, does not touch avatar", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOff, "Bot");
    pm.onConnect();
    await flush();
    expect(ts.uploadCalls.length).toBe(0);
    expect(ts.clearCalls).toBe(0);
  });
});

// #148: the persisted avatar is loaded in the BotInstance constructor, before
// tsClient.connect() has run. Loading it must not touch the wire at all.
describe("BotProfileManager loadCustomAvatar (pre-connect load, #148)", () => {
  let ts: ReturnType<typeof makeMockTs>;
  beforeEach(() => { ts = makeMockTs(); });

  it("does not upload or clear anything when called before connect", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    pm.loadCustomAvatar(Buffer.from([7, 7, 7]));
    await flush();
    expect(ts.uploadCalls.length).toBe(0);
    expect(ts.clearCalls).toBe(0);
    expect(ts.fileTransferInitUpload).not.toHaveBeenCalled();
  });

  it("the loaded avatar is uploaded once onConnect fires", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    pm.loadCustomAvatar(Buffer.from([7, 7, 7]));
    await flush();
    pm.onConnect();
    await flush();
    expect(ts.uploadCalls.length).toBe(1);
    expect(ts.uploadCalls[0].equals(Buffer.from([7, 7, 7]))).toBe(true);
  });

  it("survives a reconnect: onConnect re-applies the loaded avatar every time", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    pm.loadCustomAvatar(Buffer.from([8]));
    pm.onConnect();
    await flush();
    pm.onConnect();
    await flush();
    expect(ts.uploadCalls.length).toBe(2);
  });

  it("loading null leaves the wire untouched and onConnect stays quiet", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    pm.loadCustomAvatar(null);
    pm.onConnect();
    await flush();
    expect(ts.uploadCalls.length).toBe(0);
    expect(ts.clearCalls).toBe(0);
  });

  it("setCustomAvatar still uploads immediately after connect (post-connect edit unchanged)", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOn, "Bot");
    pm.loadCustomAvatar(Buffer.from([1]));
    pm.onConnect();
    await flush();
    ts.uploadCalls.length = 0;
    pm.setCustomAvatar(Buffer.from([2, 2]));
    await flush();
    expect(ts.uploadCalls.length).toBe(1);
    expect(ts.uploadCalls[0].equals(Buffer.from([2, 2]))).toBe(true);
  });
});

describe("BotProfileManager channel description follows the bot (#159)", () => {
  const cfgChannelDesc = { ...cfgOff, channelDescEnabled: true };
  let ts: ReturnType<typeof makeMockTs> & { cid: bigint };
  let channelEdits: () => string[];

  beforeEach(() => {
    ts = makeMockTs() as any;
    ts.cid = 5n;
    (ts as any).getChannelId = () => ts.cid;
    channelEdits = () =>
      (ts.execCommand as any).mock.calls
        .map((c: any[]) => c[0] as string)
        .filter((cmd: string) => cmd.startsWith("channeledit"));
  });

  it("clears the old channel and fills the new one when moved while playing", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgChannelDesc, "Bot");
    await pm.onSongChange(fakeSong);
    expect(channelEdits()).toEqual([
      expect.stringMatching(/^channeledit cid=5 channel_description=\S+/),
    ]);

    ts.cid = 9n;
    await pm.onChannelMoved(9n);

    const edits = channelEdits();
    expect(edits[1]).toBe("channeledit cid=5 channel_description=");
    expect(edits[2]).toMatch(/^channeledit cid=9 channel_description=\S+/);
  });

  it("stopping after a move clears the channel the bot is in now, not the old one", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgChannelDesc, "Bot");
    await pm.onSongChange(fakeSong);
    ts.cid = 9n;
    await pm.onChannelMoved(9n);
    await pm.onSongChange(null);
    expect(channelEdits().at(-1)).toBe("channeledit cid=9 channel_description=");
  });

  it("a move while idle touches no channel description", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgChannelDesc, "Bot");
    ts.cid = 9n;
    await pm.onChannelMoved(9n);
    expect(channelEdits()).toEqual([]);
  });

  it("a move is ignored when the channel description feature is off", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgOff, "Bot");
    await pm.onSongChange(fakeSong);
    ts.cid = 9n;
    await pm.onChannelMoved(9n);
    expect(channelEdits()).toEqual([]);
  });

  it("an event for the channel the description is already in is a no-op", async () => {
    const pm = new BotProfileManager(ts as any, noopLogger, cfgChannelDesc, "Bot");
    await pm.onSongChange(fakeSong);
    await pm.onChannelMoved(5n);
    expect(channelEdits()).toHaveLength(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeHttpProfile(partial: Partial<typeof cfgOff> = {}) {
  const ts = makeMockTs() as any;
  const state = { clid: 17, cid: 5n };
  const descriptions = new Map<number, string>();
  const http = new TS6HttpQuery({ host: "127.0.0.1", port: 10080 });
  const request = vi.spyOn(http, "request").mockImplementation(async (_method, path, body) => {
    if (path.includes("clientlist")) {
      return { status: 200, body: { body: [{ clid: String(state.clid), cid: String(state.cid) }], status: { code: 0, message: "ok" } } };
    }
    if (path.includes("channeledit")) descriptions.set(Number(body!.cid), String(body!.channel_description));
    return { status: 200, body: { status: { code: 0, message: "ok" } } };
  });
  ts.getHttpQuery = () => http;
  ts.getClientId = () => state.clid;
  ts.getChannelId = () => state.cid;
  const logger: any = { child: () => logger, info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const pm = new BotProfileManager(ts, logger, { ...cfgOff, ...partial }, "Bot");
  return { pm, ts, state, http, request, descriptions, logger };
}

describe("BotProfileManager checked TS6 profile lifecycle", () => {
  it("clears the old channel through HTTP Query when moved, even without full-client edit permission", async () => {
    const { pm, ts, state, descriptions } = makeHttpProfile({ channelDescEnabled: true });
    ts.execCommand.mockRejectedValue(new Error("insufficient client permissions"));
    await pm.onSongChange(fakeSong);
    expect(descriptions.get(5)).toContain("X - Y");
    state.cid = 9n;
    await pm.onChannelMoved(9n);
    expect(descriptions.get(5)).toBe("");
    expect(descriptions.get(9)).toContain("X - Y");
    expect(ts.sendCommandNoWait).not.toHaveBeenCalled();
    expect(ts.execCommand).not.toHaveBeenCalled();
  });

  it("discards an old client-list reply after reconnect", async () => {
    const { pm, state, request } = makeHttpProfile({ channelDescEnabled: true });
    state.cid = 0n;
    const lookup = deferred<any>();
    request.mockImplementationOnce(() => lookup.promise);
    const update = pm.onSongChange(fakeSong);
    await flush();
    state.clid = 21;
    state.cid = 9n;
    pm.onConnect();
    lookup.resolve({ status: 200, body: { body: [{ clid: "17", cid: "5" }], status: { code: 0, message: "ok" } } });
    await update;
    expect(request.mock.calls.filter((call) => call[1].includes("channeledit"))).toEqual([]);
    await pm.onSongChange(null);
    expect(request).toHaveBeenLastCalledWith("POST", "/1/channeledit?sid=1", { cid: 9, channel_description: "" });
  });

  it("does not restore the previous remembered channel when a write completes after reconnect", async () => {
    const { pm, state, request } = makeHttpProfile({ channelDescEnabled: true });
    const write = deferred<any>();
    request.mockImplementationOnce(() => write.promise);
    const update = pm.onSongChange(fakeSong);
    await flush();
    state.clid = 21;
    state.cid = 9n;
    pm.onConnect();
    write.resolve({ status: 200, body: { status: { code: 0, message: "ok" } } });
    await update;
    await pm.onSongChange(null);
    expect(request).toHaveBeenLastCalledWith("POST", "/1/channeledit?sid=1", { cid: 9, channel_description: "" });
  });

  it("discards a pending channel lookup when playback stops", async () => {
    const { pm, ts, request, descriptions } = makeHttpProfile({ channelDescEnabled: true });
    ts.getChannelId = () => 0n;
    const lookup = deferred<any>();
    request.mockImplementationOnce(() => lookup.promise);
    const update = pm.onSongChange(fakeSong);
    await flush();
    await pm.onSongChange(null);
    lookup.resolve({ status: 200, body: { body: [{ clid: "17", cid: "5" }], status: { code: 0, message: "ok" } } });
    await update;
    expect(descriptions.get(5)).toBe("");
  });

  it("discards a pending channel lookup when the bot is moved", async () => {
    const { pm, ts, request, descriptions } = makeHttpProfile({ channelDescEnabled: true });
    ts.getChannelId = () => 0n;
    const lookup = deferred<any>();
    request.mockImplementationOnce(() => lookup.promise);
    const update = pm.onSongChange(fakeSong);
    await flush();
    await pm.onChannelMoved(9n);
    lookup.resolve({ status: 200, body: { body: [{ clid: "17", cid: "5" }], status: { code: 0, message: "ok" } } });
    await update;
    expect(descriptions.has(5)).toBe(false);
    expect(descriptions.get(9)).toContain("X - Y");
  });

  it("does not disable the new connection after an old write returns a permission failure", async () => {
    const { pm, state, request } = makeHttpProfile({ channelDescEnabled: true });
    const write = deferred<any>();
    request.mockImplementationOnce(() => write.promise);
    const update = pm.onSongChange(fakeSong);
    await flush();
    state.clid = 21;
    state.cid = 9n;
    pm.onConnect();
    write.resolve({ status: 403, body: { status: { code: 2568, message: "insufficient client permissions" } } });
    await update;
    await pm.onSongChange(fakeSong);
    expect(request).toHaveBeenLastCalledWith("POST", "/1/channeledit?sid=1", { cid: 9, channel_description: "♪ 正在播放: X - Y\n专辑: Z\n平台: netease" });
  });

  it("resolves an unknown channel and sends raw newlines with one targeted description update", async () => {
    const { pm, ts, state, request } = makeHttpProfile({ channelDescEnabled: true, descriptionEnabled: true });
    ts.getChannelId = () => 0n;
    state.cid = 5n;
    await pm.onSongChange(fakeSong);
    expect(request.mock.calls.filter((call) => call[1].includes("clientedit"))).toEqual([
      ["POST", "/1/clientedit?sid=1", { clid: 17, client_description: "X - Y [Z]" }],
    ]);
    expect(request).toHaveBeenLastCalledWith("POST", "/1/channeledit?sid=1", { cid: 5, channel_description: "♪ 正在播放: X - Y\n专辑: Z\n平台: netease" });
    expect(ts.execCommand).not.toHaveBeenCalled();
  });

  it("does not resolve or write a disconnected client", async () => {
    const { pm, state, request } = makeHttpProfile({ channelDescEnabled: true, descriptionEnabled: true });
    state.clid = 0;
    state.cid = 0n;
    await pm.onSongChange(fakeSong);
    expect(request).not.toHaveBeenCalled();
  });

  it("reports HTTP lookup permission errors once and retries after reconnect", async () => {
    const { pm, ts, request } = makeHttpProfile({ channelDescEnabled: true });
    ts.getChannelId = () => 0n;
    request.mockResolvedValue({ status: 403, body: { status: { code: 2568, message: "insufficient client permissions" } } });
    await pm.onSongChange(fakeSong);
    await pm.onSongChange(fakeSong);
    expect(request).toHaveBeenCalledTimes(1);
    pm.onConnect();
    await pm.onSongChange(fakeSong);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("checks self clientupdate permission responses and retries only after reconnect", async () => {
    const { pm, ts, request, logger } = makeHttpProfile({ nicknameEnabled: true, awayStatusEnabled: true });
    const commands: string[] = [];
    ts.execCommand.mockImplementation(async (command: string) => {
      commands.push(command);
      throw new Error("insufficient client permissions (error id=2568)");
    });
    await pm.onSongChange(null);
    await pm.onSongChange(null);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBe("clientupdate client_nickname=Bot client_away=1 client_away_message=等待播放");
    expect(request).not.toHaveBeenCalled();
    expect(logger.info.mock.calls.some((call: any[]) => call[1] === "Client properties updated (nickname + away)")).toBe(false);
    pm.onConnect();
    await pm.onSongChange(null);
    expect(commands).toHaveLength(2);
  });
});
