import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeEmbeddedApi, getSafeApiStartupError, startEmbeddedApi } from "./api-server-runtime.js";

const state = vi.hoisted(() => ({ serveNcmApi: vi.fn(), qqExport: null as any, portFree: true }));
vi.mock("NeteaseCloudMusicApi", () => ({ server: { serveNcmApi: state.serveNcmApi } }));
vi.mock("@sansenjian/qq-music-api", () => ({ get default() { return state.qqExport; } }));
vi.mock("node:net", async () => {
  const { EventEmitter } = await import("node:events");
  return { default: { createServer: () => {
    const probe = new EventEmitter() as EventEmitter & { close(done: () => void): void; listen(): void };
    probe.close = (done) => queueMicrotask(done);
    probe.listen = () => queueMicrotask(() => probe.emit(state.portFree ? "listening" : "error"));
    return probe;
  } } };
});

class FakeServer extends EventEmitter {
  listening = false;
  close = vi.fn((done: () => void) => { this.listening = false; queueMicrotask(done); return this; });
  closeAllConnections = vi.fn();
}

describe("embedded API runtime", () => {
  let server: FakeServer;
  let listen: ReturnType<typeof vi.fn>;
  let previousPort: string | undefined;
  beforeEach(() => {
    previousPort = process.env.PORT;
    server = new FakeServer();
    state.portFree = true;
    state.serveNcmApi.mockReset();
    state.serveNcmApi.mockResolvedValue({ server });
    listen = vi.fn(() => { queueMicrotask(() => { server.listening = true; server.emit("listening"); }); return server; });
    state.qqExport = { listen };
  });
  afterEach(() => { if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort; vi.restoreAllMocks(); });

  it("binds NetEase to loopback/configured port without version checks and waits for listening", async () => {
    let ready = false;
    const starting = startEmbeddedApi("netease", 39218).then((result) => { ready = true; return result; });
    await vi.waitFor(() => expect(server.listenerCount("listening")).toBe(1));
    expect(state.serveNcmApi).toHaveBeenCalledWith({ port: 39218, host: "127.0.0.1", checkVersion: false });
    expect(ready).toBe(false);
    server.listening = true; server.emit("listening");
    expect((await starting).server).toBe(server);
  });
  it("closes the HTTP server returned by NetEase rather than the Express app", async () => {
    server.listening = true;
    const runtime = await startEmbeddedApi("netease", 39218);
    await closeEmbeddedApi(runtime.server);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
  });
  it("rejects failed listening and cleans up the startup handle", async () => {
    const starting = startEmbeddedApi("netease", 39218);
    const rejected = expect(starting).rejects.toMatchObject({ code: "EADDRINUSE" });
    await vi.waitFor(() => expect(server.listenerCount("error")).toBe(1));
    server.emit("error", Object.assign(new Error("bind failure"), { code: "EADDRINUSE" }));
    await rejected;
    expect(server.close).toHaveBeenCalledTimes(1);
  });
  it("binds QQ to its configured loopback port and restores injected PORT", async () => {
    process.env.PORT = "39999";
    expect((await startEmbeddedApi("qq", 39217)).server).toBe(server);
    expect(listen).toHaveBeenCalledWith(39217, "127.0.0.1");
    expect(process.env.PORT).toBe("39999");
  });
  it("restores an absent PORT and supports the legacy nested export", async () => {
    delete process.env.PORT; state.qqExport = { default: { listen } };
    await startEmbeddedApi("qq", 39217);
    expect(process.env.PORT).toBeUndefined();
    expect(listen).toHaveBeenCalledWith(39217, "127.0.0.1");
  });
  it("reuses a legacy module that auto-started on import without a duplicate listen", async () => {
    state.portFree = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { message: "no songmid" } }), {
      status: 400, headers: { "Content-Type": "application/json" },
    }));
    expect(await startEmbeddedApi("qq", 39217)).toEqual({ server: null });
    expect(listen).not.toHaveBeenCalled();
  });
  it("reports an occupied port if another service bound it during import", async () => {
    state.portFree = false;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not QQ", { status: 200 }));
    await expect(startEmbeddedApi("qq", 39217)).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(listen).not.toHaveBeenCalled();
  });
  it("never reflects arbitrary startup message, stack or code values", () => {
    expect(getSafeApiStartupError({ message: "synthetic-credential", stack: "synthetic-credential", code: "synthetic-credential" })).toEqual({ category: "startup" });
    expect(getSafeApiStartupError({ code: "ERR_REQUIRE_ESM", message: "synthetic-credential" })).toEqual({ category: "esm", code: "ERR_REQUIRE_ESM" });
    expect(getSafeApiStartupError({ code: "EBADENGINE" })).toEqual({ category: "node-engine", code: "EBADENGINE" });
    expect(getSafeApiStartupError({ code: "EADDRINUSE" })).toEqual({ category: "port-in-use", code: "EADDRINUSE" });
  });
});
