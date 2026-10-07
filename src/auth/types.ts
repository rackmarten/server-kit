import type { FastifyRequest } from "fastify";

// A strategy only needs to decide whether a request is allowed through.
// How it decides (trusting the network path vs. checking a session) is up
// to the implementation - callers select one by name via AuthConfig.
export interface AuthStrategy {
  readonly name: string;
  authenticate(request: FastifyRequest): Promise<boolean> | boolean;
}

export type AuthConfig =
  | { strategy: "tailnet-trust"; options?: TailnetTrustOptions }
  | { strategy: "jwt"; options?: JwtOptions }
  | { strategy: "real"; options?: never };

export interface TailnetTrustOptions {
  // CIDR of the tailnet, matched against the client IP the reverse
  // proxy forwards. Defaults to the tailnet range (100.64.0.0/10).
  cidr?: string;
}

export interface JwtOptions {
  // The gate's public keys in HOMELAB_TOKEN_KEYS format. Defaults to
  // process.env.HOMELAB_TOKEN_KEYS.
  keys?: string;
  // Path of the route returning the caller's identity (ui-kit reads it for
  // the "Viewing as" banner). `false` registers none. Default "/api/me".
  meRoute?: string | false;
  // Clock, for tests.
  now?: () => number;
}

// Who is asking, from a verified identity token.
export interface HomelabUser {
  // The gate's person id (the token's `sub`).
  id: string;
  name: string;
  roles: string[];
  groups: string[];
  services: string[];
  // Set while an admin views as this person (the token's `act`): the admin
  // behind the request. Such a request is read-only.
  actor?: { id: string; name: string };
}
