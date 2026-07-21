import { describe, expect, it, vi } from "vitest";
import type { AddrResolver, ResolvedAddr } from "@honeybbq/teamspeak-client";
import { TrackingVoiceEndpointResolver } from "./voice-endpoint.js";

function result(addr: string): ResolvedAddr {
  return { addr, source: "test", expiry: new Date(0) };
}

function delegate(...addresses: string[]): AddrResolver {
  return {
    resolve: vi.fn(async () => addresses.map(result)),
  };
}

describe("TrackingVoiceEndpointResolver", () => {
  it("pins a DNS alias to the IPv4 endpoint used by the UDP connection", async () => {
    const resolveHost = vi.fn(async () => "203.0.113.20");
    const resolver = new TrackingVoiceEndpointResolver(
      delegate("voice-alias.example.com:9987"),
      resolveHost,
    );

    const resolved = await resolver.resolve("voice.example.com:9987");

    expect(resolveHost).toHaveBeenCalledWith("voice-alias.example.com");
    expect(resolved[0]?.addr).toBe("203.0.113.20:9987");
    expect(resolver.getEndpoint()).toEqual({ host: "203.0.113.20", port: 9987 });
  });

  it("preserves the port chosen by SRV/TSDNS discovery", async () => {
    const resolver = new TrackingVoiceEndpointResolver(
      delegate("srv-target.example.com:12000"),
      async () => "198.51.100.8",
    );

    expect((await resolver.resolve("voice.example.com:9987"))[0]?.addr).toBe(
      "198.51.100.8:12000",
    );
    expect(resolver.getEndpoint()?.port).toBe(12000);
  });

  it("keeps the SDK target as a safe fallback when A-record lookup fails", async () => {
    const original = "voice.example.com:9987";
    const resolver = new TrackingVoiceEndpointResolver(
      delegate(original),
      async () => {
        throw new Error("dns unavailable");
      },
    );

    expect((await resolver.resolve(original))[0]?.addr).toBe(original);
    expect(resolver.getEndpoint()).toEqual({ host: "voice.example.com", port: 9987 });
  });

  it("does not mutate secondary SDK candidates", async () => {
    const resolver = new TrackingVoiceEndpointResolver(
      delegate("first.example.com:9987", "second.example.com:9988"),
      async () => "192.0.2.4",
    );

    const resolved = await resolver.resolve("voice.example.com:9987");
    expect(resolved.map((candidate) => candidate.addr)).toEqual([
      "192.0.2.4:9987",
      "second.example.com:9988",
    ]);
  });

  it("clears the observed endpoint before a reconnect", async () => {
    const resolver = new TrackingVoiceEndpointResolver(
      delegate("voice.example.com:9987"),
      async () => "192.0.2.5",
    );
    await resolver.resolve("voice.example.com:9987");

    resolver.reset();

    expect(resolver.getEndpoint()).toBeNull();
  });
});
