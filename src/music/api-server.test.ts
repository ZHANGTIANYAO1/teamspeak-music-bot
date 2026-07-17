import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApiServerManager, describeQqApiStartupError } from "./api-server.js";
import type { Logger } from "../logger.js";

// Record every listen() the QQ sidecar makes so we can assert it is always
// pinned to the configured port (regression coverage for issue #122).
const mockState = vi.hoisted(() => ({
  listenCalls: [] as Array<{ port: number; host: string }>,
}));

vi.mock("@sansenjian/qq-music-api", () => {
  const app = {
    listen(port: number, host: string, cb?: () => void) {
      mockState.listenCalls.push({ port, host });
      const server = {
        address: () => ({ port, address: host, family: "IPv4" as const }),
        on() {
          return server;
        },
        close(done?: () => void) {
          done?.();
        },
      };
      // Real net/Koa fire the listening callback on a later tick, after the
      // caller has captured the returned server handle.
      if (cb) setImmediate(cb);
      return server;
    },
  };
  return { default: app };
});

describe("describeQqApiStartupError", () => {
  it("flags ERR_REQUIRE_ESM by error code with version-pin guidance", () => {
    const hint = describeQqApiStartupError({ code: "ERR_REQUIRE_ESM", message: "..." });
    expect(hint).toMatch(/ERR_REQUIRE_ESM/);
    expect(hint).toMatch(/~2\.4\.0/);
    expect(hint).toMatch(/~2\.2\.10/);
  });

  it("flags ERR_REQUIRE_ESM by message when the code is absent", () => {
    const hint = describeQqApiStartupError(
      new Error("require() of ES Module .../@sansenjian/qq-music-api/dist/index.js not supported")
    );
    expect(hint).toMatch(/incompatible @sansenjian\/qq-music-api/);
  });

  it("flags a Node engine mismatch with a Node-upgrade hint", () => {
    const hint = describeQqApiStartupError(new Error("Unsupported engine: requires Node >=20.17"));
    expect(hint).toMatch(/Node >=20\.17/);
    expect(hint).toMatch(/~2\.2\.10/);
  });

  it("returns null for an unrelated startup error (falls back to the generic warning)", () => {
    expect(describeQqApiStartupError(new Error("EADDRINUSE: port in use"))).toBeNull();
    expect(describeQqApiStartupError(undefined)).toBeNull();
    expect(describeQqApiStartupError(null)).toBeNull();
  });
});

// Regression coverage for issue #122: the QQ Music API sidecar must listen on
// the same port the client base URL targets (config.qqMusicApiPort). A stale
// build once bound 3300 while the client requested 3200, silently breaking the
// QQ login QR / search flow with ECONNREFUSED on 127.0.0.1:3200.
describe("createApiServerManager — QQ sidecar port binding", () => {
  const noopLogger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    fatal() {},
  } as unknown as Logger;

  beforeEach(() => {
    mockState.listenCalls = [];
  });

  it("listens on the configured qqMusicPort and exposes a matching base URL", async () => {
    const port = 39217; // uncommon port to avoid clashing with a real instance
    const manager = createApiServerManager(
      { neteasePort: 39218, qqMusicPort: port, neteaseEnabled: false, qqEnabled: true },
      noopLogger
    );
    await manager.start();
    manager.stop();

    expect(manager.getQQMusicBaseUrl()).toBe(`http://127.0.0.1:${port}`);
    expect(mockState.listenCalls).toEqual([{ port, host: "127.0.0.1" }]);
  });

  it("follows qqMusicPort — not an injected PORT — and restores PORT afterwards", async () => {
    const port = 39219;
    const previous = process.env.PORT;
    // Simulate a hosting platform / compose file injecting a stray PORT that
    // must NOT leak into the QQ sidecar's chosen port.
    process.env.PORT = "39999";
    const manager = createApiServerManager(
      { neteasePort: 39220, qqMusicPort: port, neteaseEnabled: false, qqEnabled: true },
      noopLogger
    );
    try {
      await manager.start();
      // The sidecar follows qqMusicPort, never the injected PORT.
      expect(mockState.listenCalls).toEqual([{ port, host: "127.0.0.1" }]);
      // The injected PORT is restored so nothing else in the process is affected.
      expect(process.env.PORT).toBe("39999");
    } finally {
      manager.stop();
      if (previous === undefined) delete process.env.PORT;
      else process.env.PORT = previous;
    }
  });

  it("leaves an absent PORT env unset after importing the sidecar", async () => {
    const port = 39221;
    const previous = process.env.PORT;
    delete process.env.PORT;
    const manager = createApiServerManager(
      { neteasePort: 39222, qqMusicPort: port, neteaseEnabled: false, qqEnabled: true },
      noopLogger
    );
    try {
      await manager.start();
      // Was unset before importing — must be unset again, no leaked override.
      expect(process.env.PORT).toBeUndefined();
    } finally {
      manager.stop();
      if (previous === undefined) delete process.env.PORT;
      else process.env.PORT = previous;
    }
  });
});
