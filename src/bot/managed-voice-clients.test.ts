import { describe, expect, it } from "vitest";
import {
  ManagedVoiceClientRegistry,
  normalizeManagedVoiceClientScope,
  normalizeManagedVoiceHost,
} from "./managed-voice-clients.js";

describe("managed voice client scope normalization", () => {
  it("normalizes DNS host casing, whitespace, and trailing root dots", () => {
    expect(normalizeManagedVoiceHost("  Voice.Example.COM...  ")).toBe(
      "voice.example.com",
    );
    expect(
      normalizeManagedVoiceClientScope({
        host: "VOICE.EXAMPLE.COM.",
        voicePort: 9987,
      }),
    ).toEqual({ host: "voice.example.com", voicePort: 9987 });
  });

  it("treats bracketed and equivalent expanded IPv6 literals as one host", () => {
    expect(normalizeManagedVoiceHost("[2001:0DB8:0:0:0:0:0:1]")).toBe(
      "2001:db8::1",
    );
    expect(normalizeManagedVoiceHost("2001:db8::1")).toBe("2001:db8::1");
  });

  it("rejects empty hosts and invalid voice ports", () => {
    expect(
      normalizeManagedVoiceClientScope({ host: " . ", voicePort: 9987 }),
    ).toBeNull();
    expect(
      normalizeManagedVoiceClientScope({ host: "example.com", voicePort: 0 }),
    ).toBeNull();
    expect(
      normalizeManagedVoiceClientScope({
        host: "example.com",
        voicePort: 65_536,
      }),
    ).toBeNull();
  });
});

describe("ManagedVoiceClientRegistry", () => {
  it("finds clients through normalized forms of the same scope", () => {
    const registry = new ManagedVoiceClientRegistry();
    const owner = Symbol("connection");

    expect(
      registry.register(
        { host: " Voice.Example.COM. ", voicePort: 9987 },
        42,
        owner,
      ),
    ).toBe(true);
    expect(
      registry.has({ host: "voice.example.com", voicePort: 9987 }, 42),
    ).toBe(true);
  });

  it("keeps different voice ports and hosts in separate scopes", () => {
    const registry = new ManagedVoiceClientRegistry();
    registry.register(
      { host: "voice.example.com", voicePort: 9987 },
      7,
      Symbol("connection"),
    );

    expect(
      registry.has({ host: "voice.example.com", voicePort: 9988 }, 7),
    ).toBe(false);
    expect(
      registry.has({ host: "other.example.com", voicePort: 9987 }, 7),
    ).toBe(false);
  });

  it("uses an IPv6-safe scope key", () => {
    const registry = new ManagedVoiceClientRegistry();
    registry.register(
      { host: "[2001:0db8:0:0:0:0:0:1]", voicePort: 9987 },
      9,
      Symbol("connection"),
    );

    expect(
      registry.has({ host: "2001:db8::1", voicePort: 9987 }, 9),
    ).toBe(true);
  });

  it("does not let a delayed old disconnect remove a replacement", () => {
    const registry = new ManagedVoiceClientRegistry();
    const scope = { host: "voice.example.com", voicePort: 9987 };
    const oldConnection = Symbol("old connection");
    const newConnection = Symbol("new connection");

    registry.register(scope, 12, oldConnection);
    registry.register(scope, 12, newConnection);

    expect(registry.unregister(scope, 12, oldConnection)).toBe(false);
    expect(registry.has(scope, 12)).toBe(true);
    expect(registry.unregister(scope, 12, newConnection)).toBe(true);
    expect(registry.has(scope, 12)).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "ignores invalid client id %s",
    (clientId) => {
      const registry = new ManagedVoiceClientRegistry();
      const scope = { host: "voice.example.com", voicePort: 9987 };
      const owner = Symbol("connection");

      expect(registry.register(scope, clientId, owner)).toBe(false);
      expect(registry.has(scope, clientId)).toBe(false);
      expect(registry.unregister(scope, clientId, owner)).toBe(false);
    },
  );

  it("has no shared module-level state between registry instances", () => {
    const first = new ManagedVoiceClientRegistry();
    const second = new ManagedVoiceClientRegistry();
    const scope = { host: "voice.example.com", voicePort: 9987 };

    first.register(scope, 3, Symbol("connection"));

    expect(first.has(scope, 3)).toBe(true);
    expect(second.has(scope, 3)).toBe(false);
  });
});
