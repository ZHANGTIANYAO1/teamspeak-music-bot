import net from "node:net";
import type { Server } from "node:http";

export type ApiProvider = "netease" | "qq";
export type ApiStartupCategory = "esm" | "node-engine" | "port-in-use" | "startup" | "timeout" | "cancelled";
export interface SafeApiStartupError { category: ApiStartupCategory; code?: string }
export type ApiChildMessage =
  | { type: "ready"; provider: ApiProvider; port: number }
  | ({ type: "error"; provider: ApiProvider; port: number } & SafeApiStartupError);

const SAFE_ERROR_CODES = new Set(["ERR_REQUIRE_ESM", "EBADENGINE", "EADDRINUSE", "EACCES", "ENOENT", "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"]);
export function safeApiErrorCode(code: unknown): string | undefined {
  return typeof code === "string" && SAFE_ERROR_CODES.has(code) ? code : undefined;
}

/** Classification may inspect a message locally, but IPC never contains it. */
export function getSafeApiStartupError(err: unknown): SafeApiStartupError {
  const error = (err ?? {}) as { code?: unknown; message?: unknown };
  const code = safeApiErrorCode(error.code);
  const message = typeof error.message === "string" ? error.message : "";
  let category: ApiStartupCategory = "startup";
  if (code === "ERR_REQUIRE_ESM" || /ERR_REQUIRE_ESM|require\(\) of ES ?Module/i.test(message)) category = "esm";
  else if (code === "EBADENGINE" || /Unsupported engine|EBADENGINE|requires Node|Node\.js version/i.test(message)) category = "node-engine";
  else if (code === "EADDRINUSE") category = "port-in-use";
  return code ? { category, code } : { category };
}

export function isApiPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => server.close(() => resolve(false)));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/** Identify the QQ wrapper without credentials or a request to QQ upstream. */
export async function isQqMusicApi(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/getMusicPlay`, {
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
    });
    if (response.status !== 400 || !response.headers.get("content-type")?.includes("application/json")) {
      await response.body?.cancel();
      return false;
    }
    const reader = response.body?.getReader();
    if (!reader) return false;
    const buffer = Buffer.alloc(1024);
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (length + value.length > buffer.length) return false;
        buffer.set(value, length);
        length += value.length;
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(buffer.toString("utf8", 0, length))?.data?.message === "no songmid";
  } catch {
    return false;
  }
}

function waitForListening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ready = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { server.off("listening", ready); server.off("error", failed); };
    server.once("listening", ready);
    server.once("error", failed);
  });
}

export async function closeEmbeddedApi(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => {
    try {
      server.close(() => resolve());
      server.closeAllConnections?.();
    } catch { resolve(); }
  });
}

/** Only call in the isolated child: these dependencies write raw request URLs
 *  and response cookies directly to console, outside the bot's logger. */
export async function startEmbeddedApi(provider: ApiProvider, port: number): Promise<{ server: Server | null }> {
  let server: Server | null = null;
  try {
    if (provider === "netease") {
      const imported = await import("NeteaseCloudMusicApi") as any;
      const api = imported.server ?? imported.default?.server;
      const app = await api.serveNcmApi({ port, host: "127.0.0.1", checkVersion: false });
      server = app.server;
      if (!server) throw new Error("NetEase API did not expose its HTTP server");
    } else {
      const previousPort = process.env.PORT;
      process.env.PORT = String(port);
      let imported: any;
      try { imported = await import("@sansenjian/qq-music-api"); }
      finally {
        if (previousPort === undefined) delete process.env.PORT;
        else process.env.PORT = previousPort;
      }
      const candidate = imported.default ?? imported;
      const app = typeof candidate.listen === "function" ? candidate : candidate.default;
      if (!app || typeof app.listen !== "function") throw new Error("QQ API did not expose a Koa app");
      // Historical packages listened during import. Their listener remains
      // owned by this child and closes when the child exits.
      if (!(await isApiPortFree(port))) {
        if (await isQqMusicApi(port)) return { server: null };
        throw Object.assign(new Error("QQ Music API port is occupied"), { code: "EADDRINUSE" });
      }
      server = app.listen(port, "127.0.0.1");
    }
    await waitForListening(server!);
    return { server };
  } catch (error) {
    await closeEmbeddedApi(server);
    throw error;
  }
}
