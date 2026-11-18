import pino from "pino";
import { isAxiosError } from "axios";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type Logger = pino.Logger;

function serializeHttpError(error: unknown): unknown {
  if (!isAxiosError<{ code?: unknown }>(error)) {
    return error instanceof Error ? pino.stdSerializers.err(error) : error;
  }
  const upstreamCode = error.response?.data?.code;
  return {
    type: "AxiosError",
    code: error.code,
    status: error.response?.status ?? error.status,
    upstreamCode: typeof upstreamCode === "number" ? upstreamCode : undefined,
  };
}

// Axios errors include the original request configuration and may contain
// session cookies, authorization headers or secrets in the request URL.
const serializers = { err: serializeHttpError, reason: serializeHttpError };

export function createLogger(logDir?: string): Logger {
  if (!logDir) {
    return pino({ level: "info", serializers });
  }

  mkdirSync(logDir, { recursive: true });

  const transport = pino.transport({
    targets: [
      {
        target: "pino/file",
        options: { destination: 1 }, // stdout
        level: "info",
      },
      {
        target: "pino/file",
        options: { destination: join(logDir, "bot.log"), mkdir: true },
        level: "debug",
      },
    ],
  });

  // Prevent EINTR errors from crashing the process (known pino/thread-stream issue on Linux)
  transport.on("error", (err: Error) => {
    if ((err as NodeJS.ErrnoException).code === "EINTR") return;
    console.error("Logger transport error:", err);
  });

  return pino({ level: "debug", serializers }, transport);
}
