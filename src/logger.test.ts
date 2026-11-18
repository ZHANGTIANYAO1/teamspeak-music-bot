import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("application log errors", () => {
  it("preserves HTTP diagnostics while omitting Axios request and response data", () => {
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval", `
        import { AxiosError } from "axios";
        import { createLogger } from "./src/logger.ts";

        const config = { params: { cookie: "sample-request-cookie" } };
        const response = { status: 400, data: { code: -460, cookie: "sample-response-cookie" } };
        const err = new AxiosError("sample-sensitive-url", "ERR_BAD_REQUEST", config, undefined, response);
        const log = createLogger().child({ component: "test" });
        log.warn({ err }, "Provider failed");
        log.error({ reason: err }, "Unhandled rejection");
        log.error(new Error("ordinary error"));
      `,
    ], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" });

    expect(child.status, child.stderr).toBe(0);
    const [provider, rejection, ordinary] = child.stdout.trim().split("\n").map(line => JSON.parse(line));
    const expected = { type: "AxiosError", code: "ERR_BAD_REQUEST", status: 400, upstreamCode: -460 };
    expect(provider.err).toMatchObject(expected);
    expect(rejection.reason).toMatchObject(expected);
    expect(child.stdout).not.toContain("sample-");
    expect(ordinary.err.message).toBe("ordinary error");
  });
});
