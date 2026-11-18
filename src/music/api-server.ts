import { fork, type ChildProcess } from "node:child_process";
import type { Logger } from "../logger.js";
import { getSafeApiStartupError, isApiPortFree, isQqMusicApi, safeApiErrorCode, type ApiProvider, type SafeApiStartupError } from "./api-server-runtime.js";

export interface ApiServerOptions {
  neteasePort: number;
  qqMusicPort: number;
  neteaseEnabled?: boolean;
  qqEnabled?: boolean;
}
export interface ApiServerManager {
  start(): Promise<void>;
  stop(): void;
  getNeteaseBaseUrl(): string;
  getQQMusicBaseUrl(): string;
  assertQqMusicApiPort(): void;
}

export function describeQqApiStartupError(err: unknown): string | null {
  const { category } = getSafeApiStartupError(err);
  if (category === "esm") return "an incompatible @sansenjian/qq-music-api build is installed (ERR_REQUIRE_ESM). Pin it to ~2.4.0 (needs Node >=20.17) or ~2.2.10 in package.json, then reinstall";
  if (category === "node-engine") return "@sansenjian/qq-music-api 2.4.x requires Node >=20.17 (or >=22.9) — upgrade Node, or pin the package to ~2.2.10";
  return null;
}

/** Carry only tsx loader arguments into a source child. CLI evaluation,
 *  inspector and test-runner flags have unrelated meanings in a fork. */
function childExecArgv(source: boolean): string[] {
  if (!source) return [];
  const args: string[] = [];
  for (let i = 0; i < process.execArgv.length; i++) {
    const arg = process.execArgv[i];
    if (arg === "--import" || arg === "--require" || arg === "-r") {
      const value = process.execArgv[++i];
      if (value && (value === "tsx" || /[/\\]tsx[/\\]/.test(value))) args.push(arg, value);
    } else if (arg.startsWith("--import=") && (arg === "--import=tsx" || /[/\\]tsx[/\\]/.test(arg))) args.push(arg);
  }
  return args.length ? args : ["--import", "tsx"];
}

class StartupFailure extends Error {
  constructor(readonly details: SafeApiStartupError) { super("Embedded music API startup failed"); }
}
interface ManagedChild {
  child: ChildProcess;
  stop(): Promise<void>;
}
const STARTUP_TIMEOUT_MS = 15000;
const ERROR_CATEGORIES = new Set(["esm", "node-engine", "port-in-use", "startup"]);

export function createApiServerManager(options: ApiServerOptions, logger: Logger): ApiServerManager {
  const children = new Map<ApiProvider, ManagedChild>();
  let generation = 0;
  let starting: Promise<void> | null = null;
  let stopping: Promise<void> = Promise.resolve();
  let qqPortConflict = false;

  function reportQqPortConflict(port: number): void {
    qqPortConflict = true;
    logger.error({ provider: "qq", port, category: "port-in-use" },
      "QQ Music API port is occupied by another service. Free the port or set qqMusicApiPort to an unused port and restart.");
  }

  function launch(provider: ApiProvider, port: number, launchGeneration: number): Promise<void> {
    const source = import.meta.url.endsWith(".ts");
    const entry = new URL(source ? "./api-server-child.ts" : "./api-server-child.js", import.meta.url);
    const child = fork(entry, [provider, String(port)], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: childExecArgv(source),
    });
    let ready = false;
    let expectedExit = false;
    let settled = false;
    let hasExited = false;
    let startupTimer: ReturnType<typeof setTimeout>;
    let terminateTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    let resolveStart!: () => void;
    let rejectStart!: (error: StartupFailure) => void;
    const started = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    const settle = (error?: SafeApiStartupError) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      if (error) rejectStart(new StartupFailure(error)); else resolveStart();
    };
    const record: ManagedChild = {
      child,
      stop() {
        if (expectedExit) return exited;
        expectedExit = true;
        settle({ category: "cancelled" });
        if (children.get(provider) === record) children.delete(provider);
        stopping = Promise.all([stopping, exited]).then(() => {});
        if (hasExited) return exited;
        try {
          if (child.connected) child.send({ type: "stop" }, (error) => { if (error) child.kill("SIGTERM"); });
          else child.kill("SIGTERM");
        } catch { child.kill("SIGTERM"); }
        terminateTimer = setTimeout(() => child.kill("SIGTERM"), 1000);
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
        terminateTimer.unref(); killTimer.unref();
        return exited;
      },
    };
    children.set(provider, record);
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || expectedExit || launchGeneration !== generation) return;
      const data = message as Record<string, unknown>;
      if (data.provider !== provider || data.port !== port) return;
      if (data.type === "ready") { ready = true; settle(); }
      else if (data.type === "error" && typeof data.category === "string" && ERROR_CATEGORIES.has(data.category)) {
        const code = safeApiErrorCode(data.code);
        const details: SafeApiStartupError = { category: data.category as SafeApiStartupError["category"], ...(code ? { code } : {}) };
        if (!ready) settle(details);
        else logger.error({ provider, port, ...details }, "Embedded music API reported a runtime failure");
        void record.stop();
      }
    });
    child.on("error", (error) => {
      if (expectedExit) return;
      const details = getSafeApiStartupError(error);
      if (!ready) settle(details);
      else logger.error({ provider, port, ...details }, "Embedded music API child failed");
      void record.stop();
    });
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (hasExited) return;
      hasExited = true;
      clearTimeout(startupTimer); clearTimeout(terminateTimer); clearTimeout(killTimer);
      if (children.get(provider) === record) children.delete(provider);
      if (!expectedExit) {
        if (ready) logger.error({ provider, port, code, signal }, "Embedded music API exited unexpectedly");
        else settle({ category: "startup" });
      }
      resolveExit();
    };
    child.once("exit", onExit);
    // A failed fork emits close without exit.
    child.once("close", onExit);
    startupTimer = setTimeout(() => { settle({ category: "timeout" }); void record.stop(); }, STARTUP_TIMEOUT_MS);
    return started;
  }

  return {
    start(): Promise<void> {
      if (starting) return starting;
      const startGeneration = generation;
      const run = async () => {
        await stopping;
        if (startGeneration !== generation) return;
        if (options.neteaseEnabled === false && options.qqEnabled === false) {
          logger.info("NetEase/QQ providers disabled — embedded music API servers not started"); return;
        }
        logger.info("Starting embedded music API servers...");
        const providers: Array<{ provider: ApiProvider; port: number; enabled: boolean; name: string }> = [
          { provider: "netease", port: options.neteasePort, enabled: options.neteaseEnabled !== false, name: "NetEase Cloud Music" },
          { provider: "qq", port: options.qqMusicPort, enabled: options.qqEnabled !== false, name: "QQ Music" },
        ];
        for (const { provider, port, enabled, name } of providers) {
          if (startGeneration !== generation) return;
          if (!enabled || children.has(provider)) continue;
          try {
            const free = await isApiPortFree(port);
            if (startGeneration !== generation) return;
            if (!free) {
              if (provider === "qq") {
                const compatible = await isQqMusicApi(port);
                if (startGeneration !== generation) return;
                if (!compatible) { reportQqPortConflict(port); continue; }
                qqPortConflict = false;
              }
              logger.info({ port }, `${provider === "netease" ? "NetEase" : "QQ Music"} API port already in use — reusing existing instance`);
              continue;
            }
            await launch(provider, port, startGeneration);
            if (startGeneration !== generation) return;
            if (provider === "qq") qqPortConflict = false;
            logger.info({ port }, `${name} API started`);
          } catch (error) {
            if (startGeneration !== generation) return;
            const details = error instanceof StartupFailure ? error.details : getSafeApiStartupError(error);
            if (details.category === "cancelled") return;
            if (provider === "qq" && details.category === "port-in-use") { reportQqPortConflict(port); continue; }
            const hint = provider === "qq" ? describeQqApiStartupError(details.category === "esm" ? { code: "ERR_REQUIRE_ESM" } : details.category === "node-engine" ? { code: "EBADENGINE" } : {}) : null;
            logger.error({ provider, port, ...details }, hint ? `QQ Music API failed to start — ${hint}. QQ features (search/play/login) will be unavailable until fixed; port ${port} is down.` : `Failed to start ${name} API`);
          }
        }
      };
      const promise = run();
      starting = promise;
      void promise.finally(() => { if (starting === promise) starting = null; });
      return promise;
    },
    stop(): void {
      generation++;
      const pendingStart = starting;
      starting = null;
      logger.info("Stopping music API servers");
      const retiring = [...children.values()];
      children.clear();
      // A cancelled preflight still owns a temporary listening socket until
      // its callback closes it. Restart must wait for that work as well.
      stopping = Promise.all([stopping, pendingStart, ...retiring.map((record) => record.stop())]).then(() => {});
    },
    getNeteaseBaseUrl: () => `http://127.0.0.1:${options.neteasePort}`,
    getQQMusicBaseUrl: () => `http://127.0.0.1:${options.qqMusicPort}`,
    assertQqMusicApiPort(): void {
      if (qqPortConflict) {
        throw Object.assign(new Error("QQ Music API port conflict; check qqMusicApiPort"), { code: "QQ_API_PORT_CONFLICT" });
      }
    },
  };
}
