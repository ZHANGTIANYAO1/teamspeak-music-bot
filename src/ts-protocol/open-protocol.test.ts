import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { APP_VERSION } from "../version.js";
import {
  ACK_GLOBAL_BURST,
  ANNOUNCE_DEBOUNCE_MS,
  ANNOUNCE_RETRY_DELAY_MS,
  APP_NAME,
  BOT_CAPABILITIES,
  COMMANDS_LIST_REQ_COOLDOWN_MS,
  COMMANDS_PLUGIN,
  IDENTITY_ANNOUNCE_COOLDOWN_MS,
  IDENTITY_PLUGIN,
  IDENTITY_QUERY_COOLDOWN_MS,
  MAX_CMD_ARGS_CHARS,
  MAX_CMD_DESC_CHARS,
  MAX_CMD_NAME_CHARS,
  MAX_COMMANDS,
  MAX_PAYLOAD_BYTES,
  OPEN_PROTOCOL_VERSION,
  OpenProtocolManager,
  buildCommandsListAckJson,
  buildIdentityPayloadJson,
  buildOpenProtocolCommands,
  type OpenProtocolRuntimeConfig,
  type OpenProtocolTransport,
} from "./open-protocol.js";
import type { TS3PluginCommand } from "./client.js";

function makeCmd(overrides: Partial<TS3PluginCommand> = {}): TS3PluginCommand {
  return {
    name: IDENTITY_PLUGIN,
    data: JSON.stringify({ v: 1, action: "announce" }),
    invokerId: 7,
    invokerName: "Alice",
    invokerUid: "uid-alice",
    ...overrides,
  };
}

describe("OpenProtocol payload builders", () => {
  it("builds valid v1 identity payloads with package version under 1024 bytes", () => {
    const raw = buildIdentityPayloadJson("announce");
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(MAX_PAYLOAD_BYTES);
    expect(JSON.parse(raw)).toEqual({
      v: OPEN_PROTOCOL_VERSION,
      action: "announce",
      client_type: "bot",
      app_name: APP_NAME,
      app_version: APP_VERSION,
      capabilities: [...BOT_CAPABILITIES],
    });

    const ack = JSON.parse(buildIdentityPayloadJson("announce_ack"));
    expect(ack.action).toBe("announce_ack");
    expect(ack.command_prefix).toBeUndefined();
  });

  it("advertises only playback mode values supported by the bot", () => {
    for (const locale of ["zh", "en"] as const) {
      expect(buildOpenProtocolCommands(locale).find(({ name }) => name === "mode")?.args)
        .toBe("<seq|loop|random|rloop>");
    }
  });

  it("builds localized command lists adhering to field caps and <1024 byte UTF-8 limit", () => {
    for (const locale of ["zh", "en"] as const) {
      const cmds = buildOpenProtocolCommands(locale);
      expect(cmds.length).toBeGreaterThan(0);
      expect(cmds.length).toBeLessThanOrEqual(MAX_COMMANDS);

      for (const cmd of cmds) {
        expect(Array.from(cmd.name).length).toBeLessThanOrEqual(MAX_CMD_NAME_CHARS);
        expect(Array.from(cmd.desc).length).toBeLessThanOrEqual(MAX_CMD_DESC_CHARS);
        if (cmd.args !== undefined) {
          expect(Array.from(cmd.args).length).toBeLessThanOrEqual(MAX_CMD_ARGS_CHARS);
        }
      }

      const raw = buildCommandsListAckJson(locale, "!");
      if (raw === null) throw new Error("Expected a command list for a valid prefix");
      expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(MAX_PAYLOAD_BYTES);
      const parsed = JSON.parse(raw) as {
        v: number;
        action: string;
        command_prefix: string;
        commands: unknown[];
      };
      expect(parsed.v).toBe(OPEN_PROTOCOL_VERSION);
      expect(parsed.action).toBe("list_ack");
      expect(parsed.command_prefix).toBe("!");
      expect(parsed.commands.length).toBe(cmds.length);
    }
  });
});

describe("OpenProtocolManager", () => {
  let nowMs: number;
  let clientId: number;
  let config: OpenProtocolRuntimeConfig;
  let sendPluginCommand: ReturnType<typeof vi.fn>;
  let manager: OpenProtocolManager;

  beforeEach(() => {
    vi.useFakeTimers();
    nowMs = 100_000;
    clientId = 42;
    config = { locale: "zh", commandPrefix: "!" };
    sendPluginCommand = vi.fn(async () => {});
    const transport: OpenProtocolTransport = {
      getClientId: () => clientId,
      sendPluginCommand: sendPluginCommand as OpenProtocolTransport["sendPluginCommand"],
    };
    manager = new OpenProtocolManager({
      transport,
      getConfig: () => config,
      logger: pino({ level: "silent" }),
      now: () => nowMs,
    });
  });

  afterEach(() => {
    manager.reset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ignores unrelated plugins, self-sent commands, malformed JSON, and non-v1 versions", async () => {
    await manager.handlePluginCommand(makeCmd({ name: "other:plugin" }));
    await manager.handlePluginCommand(makeCmd({ invokerId: 42 }));
    await manager.handlePluginCommand(makeCmd({ data: "{not-json" }));
    await manager.handlePluginCommand(makeCmd({ data: JSON.stringify({ v: 2, action: "query" }) }));
    await manager.handlePluginCommand(makeCmd({ data: JSON.stringify({ v: 1, action: "announce_ack" }) }));
    await manager.handlePluginCommand(
      makeCmd({ name: COMMANDS_PLUGIN, data: JSON.stringify({ v: 1, action: "list_ack" }) }),
    );
    expect(sendPluginCommand).not.toHaveBeenCalled();
  });

  it("replies with unicast announce_ack to announce and query, with separate cooldowns", async () => {
    await manager.handlePluginCommand(makeCmd({ data: JSON.stringify({ v: 1, action: "announce" }) }));
    expect(sendPluginCommand).toHaveBeenCalledTimes(1);
    expect(sendPluginCommand).toHaveBeenLastCalledWith(IDENTITY_PLUGIN, expect.any(String), 7);
    expect(JSON.parse(sendPluginCommand.mock.calls[0][1] as string).action).toBe("announce_ack");

    // Repeated announce within 10s cooldown is suppressed
    nowMs += 3_000;
    await manager.handlePluginCommand(makeCmd({ data: JSON.stringify({ v: 1, action: "announce" }) }));
    expect(sendPluginCommand).toHaveBeenCalledTimes(1);

    // query uses an independent 5s cooldown bucket, so it succeeds immediately
    await manager.handlePluginCommand(makeCmd({ data: JSON.stringify({ v: 1, action: "query" }) }));
    expect(sendPluginCommand).toHaveBeenCalledTimes(2);

    // Repeated query within 5s is suppressed, then allowed after 5s
    nowMs += IDENTITY_QUERY_COOLDOWN_MS - 1;
    await manager.handlePluginCommand(makeCmd({ data: JSON.stringify({ v: 1, action: "query" }) }));
    expect(sendPluginCommand).toHaveBeenCalledTimes(2);
    nowMs += 1;
    await manager.handlePluginCommand(makeCmd({ data: JSON.stringify({ v: 1, action: "query" }) }));
    expect(sendPluginCommand).toHaveBeenCalledTimes(3);

    // announce still respects its 10s cooldown until elapsed
    nowMs += 1_000; // total 9_000ms since first announce
    await manager.handlePluginCommand(makeCmd({ data: JSON.stringify({ v: 1, action: "announce" }) }));
    expect(sendPluginCommand).toHaveBeenCalledTimes(3);
    nowMs += IDENTITY_ANNOUNCE_COOLDOWN_MS;
    await manager.handlePluginCommand(makeCmd({ data: JSON.stringify({ v: 1, action: "announce" }) }));
    expect(sendPluginCommand).toHaveBeenCalledTimes(4);
  });

  it("replies with localized unicast list_ack on commands list_req using dynamic config", async () => {
    config = { locale: "en", commandPrefix: "?" };
    await manager.handlePluginCommand(
      makeCmd({
        name: COMMANDS_PLUGIN,
        data: JSON.stringify({ v: 1, action: "list_req" }),
        invokerId: 11,
        invokerUid: "",
      }),
    );

    expect(sendPluginCommand).toHaveBeenCalledTimes(1);
    expect(sendPluginCommand).toHaveBeenCalledWith(COMMANDS_PLUGIN, expect.any(String), 11);
    const payload = JSON.parse(sendPluginCommand.mock.calls[0][1] as string);
    expect(payload.v).toBe(1);
    expect(payload.action).toBe("list_ack");
    expect(payload.command_prefix).toBe("?");
    expect(payload.commands[0]).toEqual({ name: "play", args: "<query>", desc: "Play song" });

    // Cooldown falls back to invokerId when invokerUid is empty
    nowMs += COMMANDS_LIST_REQ_COOLDOWN_MS - 10;
    await manager.handlePluginCommand(
      makeCmd({
        name: COMMANDS_PLUGIN,
        data: JSON.stringify({ v: 1, action: "list_req" }),
        invokerId: 11,
        invokerUid: "",
      }),
    );
    expect(sendPluginCommand).toHaveBeenCalledTimes(1);
  });

  it("does not advertise command discovery with a prefix too long to send unchanged", async () => {
    config.commandPrefix = "musicbot!!";
    manager.scheduleAnnounce();
    await manager.handlePluginCommand(makeCmd({
      name: COMMANDS_PLUGIN,
      data: JSON.stringify({ v: 1, action: "list_req" }),
    }));

    expect(sendPluginCommand).toHaveBeenCalledTimes(1);
    const identity = JSON.parse(sendPluginCommand.mock.calls[0][1] as string);
    expect(identity.capabilities).not.toContain("chat:slash_commands");
  });

  it("ignores inbound payloads beyond the protocol byte limit", async () => {
    await manager.handlePluginCommand(makeCmd({
      data: JSON.stringify({ v: 1, action: "query", padding: "中".repeat(MAX_PAYLOAD_BYTES / 2) }),
    }));
    expect(sendPluginCommand).not.toHaveBeenCalled();
  });

  it("enforces global and peer cooldowns when sending replies fails", async () => {
    for (let i = 1; i <= ACK_GLOBAL_BURST; i++) {
      await manager.handlePluginCommand(
        makeCmd({
          name: COMMANDS_PLUGIN,
          data: JSON.stringify({ v: 1, action: "list_req" }),
          invokerId: i,
          invokerUid: `peer-${i}`,
        }),
      );
    }
    expect(sendPluginCommand).toHaveBeenCalledTimes(ACK_GLOBAL_BURST);

    // 5th distinct peer in same millisecond is throttled by global burst
    await manager.handlePluginCommand(
      makeCmd({
        name: COMMANDS_PLUGIN,
        data: JSON.stringify({ v: 1, action: "list_req" }),
        invokerId: 99,
        invokerUid: "peer-99",
      }),
    );
    expect(sendPluginCommand).toHaveBeenCalledTimes(ACK_GLOBAL_BURST);

    // After 500ms, 1 token refills (2/sec)
    nowMs += 500;
    sendPluginCommand.mockRejectedValueOnce(new Error("transient send failure"));
    await manager.handlePluginCommand(
      makeCmd({
        name: COMMANDS_PLUGIN,
        data: JSON.stringify({ v: 1, action: "list_req" }),
        invokerId: 99,
        invokerUid: "peer-99",
      }),
    );
    expect(sendPluginCommand).toHaveBeenCalledTimes(ACK_GLOBAL_BURST + 1);

    // A rejected reply still consumes the global allowance for other peers.
    const otherRequest = makeCmd({
      name: COMMANDS_PLUGIN,
      data: JSON.stringify({ v: 1, action: "list_req" }),
      invokerId: 98,
      invokerUid: "peer-98",
    });
    await manager.handlePluginCommand(otherRequest);
    expect(sendPluginCommand).toHaveBeenCalledTimes(ACK_GLOBAL_BURST + 1);

    // Once a global slot refills, the original peer is still cooling down.
    nowMs += 500;
    await manager.handlePluginCommand({ ...otherRequest, invokerId: 99, invokerUid: "peer-99" });
    expect(sendPluginCommand).toHaveBeenCalledTimes(ACK_GLOBAL_BURST + 1);
    await manager.handlePluginCommand(otherRequest);
    expect(sendPluginCommand).toHaveBeenCalledTimes(ACK_GLOBAL_BURST + 2);
  });

  it("debounces self-announce over 2s window and emits at most one trailing announce", async () => {
    manager.scheduleAnnounce();
    await Promise.resolve();
    expect(sendPluginCommand).toHaveBeenCalledTimes(1);
    expect(sendPluginCommand).toHaveBeenLastCalledWith(IDENTITY_PLUGIN, expect.any(String), "channel");

    // Two calls inside 2s window coalesce into a single trailing broadcast
    nowMs += 400;
    manager.scheduleAnnounce();
    nowMs += 600;
    manager.scheduleAnnounce();
    expect(sendPluginCommand).toHaveBeenCalledTimes(1);

    nowMs += ANNOUNCE_DEBOUNCE_MS - 1_000;
    await vi.advanceTimersByTimeAsync(ANNOUNCE_DEBOUNCE_MS - 400);
    expect(sendPluginCommand).toHaveBeenCalledTimes(2);
  });

  it("retries failed announce once after 500ms and cancels pending timers on reset", async () => {
    sendPluginCommand.mockRejectedValueOnce(new Error("channel broadcast error"));
    manager.scheduleAnnounce();
    await Promise.resolve();
    await Promise.resolve();
    expect(sendPluginCommand).toHaveBeenCalledTimes(1);

    nowMs += ANNOUNCE_RETRY_DELAY_MS;
    await vi.advanceTimersByTimeAsync(ANNOUNCE_RETRY_DELAY_MS);
    expect(sendPluginCommand).toHaveBeenCalledTimes(2);

    // Trigger another failure then reset before retry fires
    nowMs += ANNOUNCE_DEBOUNCE_MS;
    sendPluginCommand.mockRejectedValueOnce(new Error("error before disconnect"));
    manager.scheduleAnnounce();
    await Promise.resolve();
    await Promise.resolve();
    expect(sendPluginCommand).toHaveBeenCalledTimes(3);

    manager.reset();
    await vi.advanceTimersByTimeAsync(ANNOUNCE_RETRY_DELAY_MS);
    expect(sendPluginCommand).toHaveBeenCalledTimes(3);
  });
});
