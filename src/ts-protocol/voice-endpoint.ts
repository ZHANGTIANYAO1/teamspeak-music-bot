import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Resolver } from "@honeybbq/teamspeak-client/discovery";
import type {
  AddrResolver,
  ResolvedAddr,
} from "@honeybbq/teamspeak-client";

export interface ResolvedVoiceEndpoint {
  host: string;
  port: number;
}

type ResolveIpv4 = (host: string) => Promise<string>;

function parseVoiceAddress(address: string): ResolvedVoiceEndpoint | null {
  let host: string;
  let rawPort: string;

  if (address.startsWith("[")) {
    const closingBracket = address.indexOf("]");
    if (closingBracket < 0 || address[closingBracket + 1] !== ":") return null;
    host = address.slice(1, closingBracket);
    rawPort = address.slice(closingBracket + 2);
  } else {
    const separator = address.lastIndexOf(":");
    if (separator <= 0) return null;
    host = address.slice(0, separator);
    rawPort = address.slice(separator + 1);
  }

  const port = Number(rawPort);
  if (
    host.length === 0 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    return null;
  }
  return { host, port };
}

function formatVoiceAddress(endpoint: ResolvedVoiceEndpoint): string {
  return endpoint.host.includes(":")
    ? `[${endpoint.host}]:${endpoint.port}`
    : `${endpoint.host}:${endpoint.port}`;
}

async function resolveIpv4(host: string): Promise<string> {
  if (isIP(host) === 4) return host;
  return (await lookup(host, { family: 4 })).address;
}

/**
 * Uses the SDK's normal SRV/TSDNS discovery, then pins its selected hostname
 * to the IPv4 address that the UDP connection will use. Besides making the
 * connection target observable, this gives all bots a common registry scope
 * when one is configured with a DNS alias and another with the underlying IP.
 */
export class TrackingVoiceEndpointResolver implements AddrResolver {
  private endpoint: ResolvedVoiceEndpoint | null = null;

  constructor(
    private readonly delegate: AddrResolver = new Resolver(),
    private readonly resolveHost: ResolveIpv4 = resolveIpv4,
  ) {}

  async resolve(input: string, signal?: AbortSignal): Promise<ResolvedAddr[]> {
    this.endpoint = null;
    const candidates = await this.delegate.resolve(input, signal);
    const selected = candidates[0];
    if (!selected) return candidates;

    const parsed = parseVoiceAddress(selected.addr);
    if (!parsed) return candidates;

    try {
      const pinned = {
        host: await this.resolveHost(parsed.host),
        port: parsed.port,
      };
      this.endpoint = pinned;
      return [
        { ...selected, addr: formatVoiceAddress(pinned) },
        ...candidates.slice(1),
      ];
    } catch {
      // Preserve the SDK's original target if local A-record resolution fails.
      // The connection may still succeed through platform-specific resolution;
      // the registry then falls back to the logical host + resolved port.
      this.endpoint = parsed;
      return candidates;
    }
  }

  reset(): void {
    this.endpoint = null;
  }

  getEndpoint(): ResolvedVoiceEndpoint | null {
    return this.endpoint ? { ...this.endpoint } : null;
  }
}
