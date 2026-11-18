import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiServerManager, describeQqApiStartupError } from "./api-server.js";
import type { Logger } from "../logger.js";

const state = vi.hoisted(() => ({ fork: vi.fn(), probes: [] as EventEmitter[], probeAutomatically: true, portFree: true, directImports: 0 }));
vi.mock("node:child_process", () => ({ fork: state.fork }));
vi.mock("node:net", async () => {
  const { EventEmitter } = await import("node:events");
  return { default: { createServer: () => {
    const probe = new EventEmitter() as EventEmitter & { close(done: () => void): void; listen(): void };
    probe.close = (done) => queueMicrotask(done);
    probe.listen = () => {
      state.probes.push(probe);
      if (state.probeAutomatically) queueMicrotask(() => probe.emit(state.portFree ? "listening" : "error"));
    };
    return probe;
  } } };
});
vi.mock("@sansenjian/qq-music-api", () => {
  state.directImports++;
  return { default: { listen: () => { throw new Error("sidecar imported in parent"); } } };
});
vi.mock("NeteaseCloudMusicApi", () => {
  state.directImports++;
  return { server: { serveNcmApi: () => { throw new Error("sidecar imported in parent"); } } };
});

class FakeChild extends EventEmitter {
  connected = true;
  exitOnStop = true;
  send = vi.fn((message: { type: string }) => {
    if (message.type === "stop" && this.exitOnStop) queueMicrotask(() => this.finish(0, null));
    return true;
  });
  kill = vi.fn((signal: string = "SIGTERM") => { queueMicrotask(() => this.finish(null, signal)); return true; });
  finish(code: number | null, signal: string | null) { this.connected = false; this.emit("exit", code, signal); }
}

describe("describeQqApiStartupError", () => {
  it("retains ESM diagnostics by code and message", () => {
    expect(describeQqApiStartupError({ code: "ERR_REQUIRE_ESM" })).toMatch(/~2\.4\.0/);
    expect(describeQqApiStartupError(new Error("require() of ES Module is unsupported"))).toMatch(/ERR_REQUIRE_ESM/);
  });
  it("retains engine diagnostics and ignores unrelated failures", () => {
    expect(describeQqApiStartupError(new Error("Unsupported engine: requires Node >=20.17"))).toMatch(/Node >=20\.17/);
    expect(describeQqApiStartupError(new Error("EADDRINUSE"))).toBeNull();
  });
});

describe("embedded API child lifecycle", () => {
  let children: FakeChild[];
  let logger: Logger;
  let manager: ReturnType<typeof createApiServerManager>;
  let automaticReady: boolean;
  const options = { neteasePort: 39218, qqMusicPort: 39217, neteaseEnabled: true, qqEnabled: true };
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  beforeEach(() => {
    vi.useRealTimers(); children = []; automaticReady = true;
    state.probes = []; state.portFree = true; state.probeAutomatically = true; state.fork.mockReset();
    state.fork.mockImplementation((_entry: string, args: string[]) => {
      const child = new FakeChild(); children.push(child);
      if (automaticReady) queueMicrotask(() => child.emit("message", { type: "ready", provider: args[0], port: Number(args[1]) }));
      return child as unknown as ChildProcess;
    });
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    manager = createApiServerManager(options, logger);
  });
  afterEach(async () => { manager.stop(); await flush(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it("isolates both APIs with ignored stdio, configured ports and IPC", async () => {
    await manager.start();
    expect(state.fork).toHaveBeenCalledTimes(2);
    expect(state.fork.mock.calls.map((call) => call[1])).toEqual([["netease", "39218"], ["qq", "39217"]]);
    for (const call of state.fork.mock.calls) {
      expect(String(call[0])).toMatch(/api-server-child\.ts$/);
      expect(call[2].stdio).toEqual(["ignore", "ignore", "ignore", "ipc"]);
      expect(call[2].execArgv).not.toContain("--eval");
      expect(call[2].execArgv).not.toContain("--input-type=module");
    }
    expect(state.directImports).toBe(0);
    expect(manager.getNeteaseBaseUrl()).toBe("http://127.0.0.1:39218");
    expect(manager.getQQMusicBaseUrl()).toBe("http://127.0.0.1:39217");
  });
  it("preserves provider gating and externally bound port reuse", async () => {
    manager = createApiServerManager({ ...options, neteaseEnabled: false, qqEnabled: false }, logger);
    await manager.start(); expect(state.probes).toHaveLength(0); expect(state.fork).not.toHaveBeenCalled();
    state.portFree = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { message: "no songmid" } }), {
      status: 400, headers: { "Content-Type": "application/json" },
    }));
    manager = createApiServerManager({ ...options, neteaseEnabled: false }, logger);
    await manager.start(); expect(state.fork).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith({ port: 39217 }, expect.stringContaining("reusing"));
  });
  it("detects the wrong service on the QQ music port without assuming every occupied port is reusable", async () => {
    state.portFree = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>WebUI</html>", { status: 200 }));
    manager = createApiServerManager({ ...options, neteaseEnabled: false }, logger);
    await manager.start();
    expect(state.fork).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith({ provider: "qq", port: 39217, category: "port-in-use" }, expect.stringContaining("qqMusicApiPort"));
    expect(() => manager.assertQqMusicApiPort()).toThrow(expect.objectContaining({ code: "QQ_API_PORT_CONFLICT" }));
  });
  it("inherits tsx loader arguments without unrelated parent runner flags", async () => {
    const previous = process.execArgv;
    process.execArgv = ["--require", "C:\\app\\node_modules\\tsx\\dist\\preflight.cjs", "--import", "file:///app/node_modules/tsx/dist/loader.mjs", "--eval", "synthetic-evaluation", "--conditions", "vitest", "--input-type=module", "--inspect"];
    try {
      await manager.start();
      expect(state.fork.mock.calls[0][2].execArgv).toEqual(process.execArgv.slice(0, 4));
    } finally { process.execArgv = previous; }
  });
  it("does not duplicate concurrent or repeated starts", async () => {
    await Promise.all([manager.start(), manager.start()]); await manager.start();
    expect(state.fork).toHaveBeenCalledTimes(2);
  });
  it("fences a stop during pending port preflight", async () => {
    state.probeAutomatically = false;
    const starting = manager.start(); await flush(); manager.stop();
    state.probes[0].emit("listening"); await starting;
    expect(state.fork).not.toHaveBeenCalled();
  });
  it("cancels a pending handshake and ignores its late ready", async () => {
    automaticReady = false;
    const starting = manager.start(); await flush(); expect(children).toHaveLength(1);
    manager.stop(); children[0].emit("message", { type: "ready", provider: "netease", port: 39218 }); await starting;
    expect(children[0].send).toHaveBeenCalledWith({ type: "stop" }, expect.any(Function));
    expect(state.fork).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalledWith({ port: 39218 }, "NetEase Cloud Music API started");
  });
  it("waits for a cancelled preflight to release its probe before restart", async () => {
    state.probeAutomatically = false;
    const first = manager.start(); await flush(); manager.stop();
    const restarting = manager.start(); await flush();
    expect(state.probes).toHaveLength(1);
    state.probeAutomatically = true; state.probes[0].emit("listening");
    await Promise.all([first, restarting]);
    expect(state.fork).toHaveBeenCalledTimes(2);
  });
  it("waits for old children to exit before restart", async () => {
    await manager.start(); children.forEach((child) => { child.exitOnStop = false; }); manager.stop();
    const restarting = manager.start(); await flush(); expect(state.fork).toHaveBeenCalledTimes(2);
    children.slice(0, 2).forEach((child) => child.finish(0, null)); await restarting;
    expect(state.fork).toHaveBeenCalledTimes(4);
  });
  it("reports unexpected post-ready exits with safe fields", async () => {
    await manager.start(); children[1].finish(7, "SIGTERM");
    expect(logger.error).toHaveBeenCalledWith({ provider: "qq", port: 39217, code: 7, signal: "SIGTERM" }, expect.stringContaining("exited unexpectedly"));
  });
  it("retains static QQ diagnostics and discards arbitrary IPC fields", async () => {
    automaticReady = false; manager = createApiServerManager({ ...options, neteaseEnabled: false }, logger);
    const starting = manager.start(); await flush();
    children[0].emit("message", { type: "error", provider: "qq", port: 39217, category: "esm", code: "ERR_REQUIRE_ESM", message: "synthetic-credential", stack: "synthetic-credential" }); await starting;
    expect(logger.error).toHaveBeenCalledWith({ provider: "qq", port: 39217, category: "esm", code: "ERR_REQUIRE_ESM" }, expect.stringContaining("ERR_REQUIRE_ESM"));
    expect(JSON.stringify([...(logger.error as ReturnType<typeof vi.fn>).mock.calls, ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls])).not.toContain("synthetic-credential");
    expect(children[0].send).toHaveBeenCalledWith({ type: "stop" }, expect.any(Function));
  });
  it("ignores a ready message for a different provider or port", async () => {
    automaticReady = false; manager = createApiServerManager({ ...options, neteaseEnabled: false }, logger);
    const starting = manager.start(); await flush();
    children[0].emit("message", { type: "ready", provider: "netease", port: 39217 });
    children[0].emit("message", { type: "ready", provider: "qq", port: 39999 });
    await flush();
    expect(logger.info).not.toHaveBeenCalledWith({ port: 39217 }, "QQ Music API started");
    children[0].emit("message", { type: "ready", provider: "qq", port: 39217 }); await starting;
    expect(logger.info).toHaveBeenCalledWith({ port: 39217 }, "QQ Music API started");
  });
  it("cleans up a failed fork that closes without an exit event", async () => {
    automaticReady = false; manager = createApiServerManager({ ...options, neteaseEnabled: false }, logger);
    const starting = manager.start(); await flush();
    children[0].emit("error", Object.assign(new Error("synthetic-credential"), { code: "ENOENT" }));
    children[0].emit("close", null, null); await starting;
    expect(logger.error).toHaveBeenCalledWith({ provider: "qq", port: 39217, category: "startup", code: "ENOENT" }, expect.stringContaining("start"));
    automaticReady = true; await manager.start();
    expect(state.fork).toHaveBeenCalledTimes(2);
  });
  it("times out and terminates a silent child", async () => {
    vi.useFakeTimers(); automaticReady = false; manager = createApiServerManager({ ...options, neteaseEnabled: false }, logger);
    const starting = manager.start(); await flush(); await vi.advanceTimersByTimeAsync(30000); await starting;
    expect(logger.error).toHaveBeenCalledWith({ provider: "qq", port: 39217, category: "timeout" }, expect.stringContaining("start"));
    expect(children[0].send).toHaveBeenCalledWith({ type: "stop" }, expect.any(Function));
  });
  it("forces shutdown if a child ignores stop", async () => {
    vi.useFakeTimers(); await manager.start(); children.forEach((child) => { child.exitOnStop = false; }); manager.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(children.every((child) => child.kill.mock.calls.length > 0)).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });
  it("escalates to SIGKILL if stop and SIGTERM are ignored", async () => {
    vi.useFakeTimers(); await manager.start();
    for (const child of children) {
      child.exitOnStop = false;
      child.kill.mockImplementation((signal: string = "SIGTERM") => {
        if (signal === "SIGKILL") queueMicrotask(() => child.finish(null, signal));
        return true;
      });
    }
    manager.stop(); await vi.advanceTimersByTimeAsync(2000);
    expect(children.every((child) => child.kill.mock.calls.some(([signal]) => signal === "SIGKILL"))).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
