import { afterEach, describe, it, expect, vi } from "vitest";
import pino from "pino";
import { TS3Client } from "./client.js";

/**
 * Integration "smoke test" for the admin-command gate's group resolution.
 *
 * It drives the REAL TS3Client.getClientServerGroups → library getClientInfo
 * path against a stubbed underlying client, so it exercises the actual
 * `clientinfo clid=<id>` query string and the real `client_servergroups`
 * parsing — the pieces that were previously only verified by reading the code.
 *
 * What this CANNOT cover (inherently server-side, needs a live TS server):
 * whether a real server returns groups for a client in a DIFFERENT channel.
 * The stub models the server-wide answer (groups returned regardless of
 * channel); the failure modes below confirm we fail closed when it doesn't.
 */
function makeClient(): TS3Client {
  return new TS3Client(
    { host: "localhost", port: 9987, queryPort: 10011, nickname: "TestBot" },
    pino({ level: "silent" }),
  );
}

/** Inject a fake low-level client carrying a canned clientinfo response. */
function withFakeClient(
  ts: TS3Client,
  respond: (cmd: string) => Record<string, string>[] | Promise<Record<string, string>[]>,
): string[] {
  const calls: string[] = [];
  const fake = {
    execCommandWithResponse: vi.fn(async (cmd: string) => {
      calls.push(cmd);
      return respond(cmd);
    }),
  };
  (ts as unknown as { client: unknown }).client = fake;
  return calls;
}

describe("TS3Client.getClientServerGroups — live query + parse smoke test", () => {
  it("issues `clientinfo clid=<id>` and parses comma-separated client_servergroups", async () => {
    const ts = makeClient();
    const calls = withFakeClient(ts, () => [
      { client_nickname: "Alice", cid: "99", client_servergroups: "6,8" },
    ]);

    const groups = await ts.getClientServerGroups(5);

    expect(groups).toEqual(["6", "8"]);
    // Exact query the bot sends to resolve a sender's groups, by client id.
    expect(calls[0]).toBe("clientinfo clid=5");
  });

  it("parses a single-group response", async () => {
    const ts = makeClient();
    withFakeClient(ts, () => [{ client_servergroups: "6" }]);
    expect(await ts.getClientServerGroups(5)).toEqual(["6"]);
  });

  it("returns [] when the client carries no server groups (empty field)", async () => {
    const ts = makeClient();
    withFakeClient(ts, () => [{ client_nickname: "Bob", client_servergroups: "" }]);
    expect(await ts.getClientServerGroups(7)).toEqual([]);
  });

  it("returns [] when the server-groups field is absent", async () => {
    const ts = makeClient();
    withFakeClient(ts, () => [{ client_nickname: "Carol" }]);
    expect(await ts.getClientServerGroups(7)).toEqual([]);
  });

  it("fails closed (returns []) when the query throws / client id is unknown", async () => {
    const ts = makeClient();
    withFakeClient(ts, () => {
      throw new Error("invalid clientID");
    });
    expect(await ts.getClientServerGroups(999)).toEqual([]);
  });

  it("returns [] when not connected (no underlying client)", async () => {
    const ts = makeClient();
    expect(await ts.getClientServerGroups(5)).toEqual([]);
  });
});

describe("TS3Client stable identity UID", () => {
  it("derives the same client UID after exporting and restoring an identity", () => {
    const first = makeClient();
    const restored = new TS3Client(
      {
        host: "localhost",
        port: 9987,
        queryPort: 10011,
        nickname: "RestoredBot",
        identity: first.getIdentityExport(),
      },
      pino({ level: "silent" }),
    );

    expect(first.getClientUid()).toBeTruthy();
    expect(restored.getClientUid()).toBe(first.getClientUid());
  });
});

type VisibleUidHarness = {
  visibleClientUids: Map<number, string>;
  rememberVisibleClientUid(clientId: number, clientUid: string): void;
  releaseVisibleClientUid(clientId: number): void;
  clearVisibleClientUids(): void;
};

describe("TS3Client visible client UID grace", () => {
  afterEach(() => vi.useRealTimers());

  it("retains a leaving client's UID for final reordered voice packets", () => {
    vi.useFakeTimers();
    const cache = makeClient() as unknown as VisibleUidHarness;
    cache.rememberVisibleClientUid(7, "managed-bot-uid=");

    cache.releaseVisibleClientUid(7);
    vi.advanceTimersByTime(999);
    expect(cache.visibleClientUids.get(7)).toBe("managed-bot-uid=");

    vi.advanceTimersByTime(1);
    expect(cache.visibleClientUids.has(7)).toBe(false);
  });

  it("lets a new clientEnter overwrite a reused id and cancel stale cleanup", () => {
    vi.useFakeTimers();
    const cache = makeClient() as unknown as VisibleUidHarness;
    cache.rememberVisibleClientUid(7, "old-managed-bot-uid=");
    cache.releaseVisibleClientUid(7);

    cache.rememberVisibleClientUid(7, "new-human-uid=");
    vi.advanceTimersByTime(1_000);

    expect(cache.visibleClientUids.get(7)).toBe("new-human-uid=");
    cache.clearVisibleClientUids();
  });
});
