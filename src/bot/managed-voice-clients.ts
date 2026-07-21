import { isIP } from "node:net";

/** Identifies one TeamSpeak voice server. */
export interface ManagedVoiceClientScope {
  host: string;
  voicePort: number;
}

export interface NormalizedManagedVoiceClientScope {
  readonly host: string;
  readonly voicePort: number;
}

/**
 * An opaque value identifying the connection that owns a client id.
 *
 * A fresh object or Symbol per connection is recommended. Value tokens are
 * also supported for callers that already have a unique connection id.
 */
export type ManagedVoiceClientOwnerToken = object | string | number | symbol;

/**
 * Normalize a TeamSpeak host for comparisons.
 *
 * DNS names are case-insensitive and may include a trailing root dot. IPv6
 * literals may be supplied either bare or in URL-style brackets; valid IPv6
 * addresses are also put into the canonical form produced by the URL parser.
 */
export function normalizeManagedVoiceHost(host: string): string {
  let normalized = host.trim().toLowerCase().replace(/\.+$/, "");

  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }

  if (isIP(normalized) === 6) {
    // URL's host serializer compresses equivalent IPv6 spellings. `isIP`
    // ensures interpolation cannot be interpreted as another URL component.
    const serialized = new URL(`http://[${normalized}]/`).hostname;
    return serialized.slice(1, -1);
  }

  return normalized;
}

/** Return a comparable scope, or null when the runtime input is unusable. */
export function normalizeManagedVoiceClientScope(
  scope: ManagedVoiceClientScope,
): NormalizedManagedVoiceClientScope | null {
  if (
    !scope ||
    typeof scope.host !== "string" ||
    typeof scope.voicePort !== "number"
  ) {
    return null;
  }

  const host = normalizeManagedVoiceHost(scope.host);
  if (
    host.length === 0 ||
    !Number.isInteger(scope.voicePort) ||
    scope.voicePort < 1 ||
    scope.voicePort > 65_535
  ) {
    return null;
  }

  return { host, voicePort: scope.voicePort };
}

function scopeKey(scope: ManagedVoiceClientScope): string | null {
  const normalized = normalizeManagedVoiceClientScope(scope);
  if (!normalized) return null;

  // A serialized tuple stays unambiguous when host itself contains colons.
  return JSON.stringify([normalized.host, normalized.voicePort]);
}

function validClientId(clientId: number): boolean {
  return Number.isSafeInteger(clientId) && clientId > 0;
}

/**
 * Tracks voice client ids owned by bot connections in this process.
 *
 * This class intentionally has no module-level singleton. BotManager owns one
 * instance and injects it into its BotInstances so separate managers remain
 * isolated in tests and in the same process.
 */
export class ManagedVoiceClientRegistry {
  private readonly clientsByScope = new Map<
    string,
    Map<number, ManagedVoiceClientOwnerToken>
  >();

  /**
   * Register (or replace) the connection that owns a client id.
   * Returns false when the scope or client id is invalid.
   */
  register(
    scope: ManagedVoiceClientScope,
    clientId: number,
    ownerToken: ManagedVoiceClientOwnerToken,
  ): boolean {
    const key = scopeKey(scope);
    if (!key || !validClientId(clientId)) return false;

    let clients = this.clientsByScope.get(key);
    if (!clients) {
      clients = new Map();
      this.clientsByScope.set(key, clients);
    }
    clients.set(clientId, ownerToken);
    return true;
  }

  /**
   * Remove a client only if it is still owned by this connection.
   *
   * The ownership check prevents a delayed disconnect from an old connection
   * deleting a newer connection that reused the same TeamSpeak client id.
   */
  unregister(
    scope: ManagedVoiceClientScope,
    clientId: number,
    ownerToken: ManagedVoiceClientOwnerToken,
  ): boolean {
    const key = scopeKey(scope);
    if (!key || !validClientId(clientId)) return false;

    const clients = this.clientsByScope.get(key);
    if (!clients || clients.get(clientId) !== ownerToken) return false;

    clients.delete(clientId);
    if (clients.size === 0) this.clientsByScope.delete(key);
    return true;
  }

  has(scope: ManagedVoiceClientScope, clientId: number): boolean {
    const key = scopeKey(scope);
    if (!key || !validClientId(clientId)) return false;
    return this.clientsByScope.get(key)?.has(clientId) ?? false;
  }
}
