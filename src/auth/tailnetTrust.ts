import type { FastifyRequest } from "fastify";
import type { AuthStrategy, TailnetTrustOptions } from "./types.js";

// eslint-disable-next-line sonarjs/no-hardcoded-ip -- the tailnet CGNAT range is this strategy's functional default
const DEFAULT_TAILNET_CIDR = "100.64.0.0/10";

// Every internal homelab site already sits behind the reverse proxy's
// `tailnet_only`/`tailnet_https` Caddy gate,
// which only forwards requests whose source IP is on the tailnet
// (100.64.0.0/10) and runs Caddy with `network_mode: host` specifically so
// the real client IP survives instead of being rewritten by Docker's
// userland-proxy. This strategy trusts that gate: it just re-checks the
// same range on the request Fastify actually sees, as a defense-in-depth
// backstop against a service being reachable some other way (e.g. a
// misconfigured port publish straight to the LAN).
export const createTailnetTrustStrategy = (options?: TailnetTrustOptions): AuthStrategy => {
  const [rangeIp, prefixLength] = (options?.cidr ?? DEFAULT_TAILNET_CIDR).split("/");
  const rangeInt = ipv4ToInt(rangeIp);
  if (rangeInt === null)
    throw new Error(`Invalid tailnet CIDR: ${options?.cidr ?? DEFAULT_TAILNET_CIDR}`);
  const mask = prefixLength === "0" ? 0 : (0xff_ff_ff_ff << (32 - Number(prefixLength))) >>> 0;

  return {
    name: "tailnet-trust",
    authenticate(request: FastifyRequest): boolean {
      const ip = request.ip;
      if (!ip) return false;
      const ipInt = ipv4ToInt(stripIpv6Prefix(ip));
      if (ipInt === null) return false;
      return (ipInt & mask) === (rangeInt & mask);
    },
  };
};

const stripIpv6Prefix = (ip: string): string => (ip.startsWith("::ffff:") ? ip.slice(7) : ip);

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
};
