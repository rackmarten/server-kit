import { createPublicKey, verify, type KeyObject } from "node:crypto";

// Verifying side of the auth gate's identity tokens. The gate mints a short-lived Ed25519 JWT per gated
// request and Caddy hands it to the upstream as X-Homelab-Token. Only the gate
// holds the private key; services verify locally against the public keys
// distributed to them as HOMELAB_TOKEN_KEYS, so no request ever calls the
// gate // and a compromised service can read tokens but never mint one.
//
// This mirrors the gate's own token module (verifyToken, parsePublicKeys,
// tokenFromHeaders), which is the reference: keep the two checking the same
// things.

export const TOKEN_ISSUER = "tower";
export const TOKEN_AUDIENCE = "homelab";

export interface TokenClaims {
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  // The gate's person id.
  sub: string;
  name: string;
  // Only "admin" exists today; a plain member has an empty list.
  roles: string[];
  // The gate's group ids the person belongs to.
  groups: string[];
  // Hostnames the person may reach through the gate.
  services: string[];
  // Set while an admin views as someone else: the admin behind the token.
  act?: { sub: string; name: string };
}

// HOMELAB_TOKEN_KEYS: space or comma separated `<kid>:<x>` entries, x being
// the raw Ed25519 public key as base64url (the JWK "x" member). More than
// one only during a key rotation.
export const parsePublicKeys = (raw: string | undefined): Map<string, KeyObject> => {
  const keys = new Map<string, KeyObject>();
  for (const entry of (raw ?? "").split(/[,\s]+/).filter(Boolean)) {
    const [kid, x] = entry.split(":");
    if (!kid || !x) throw new Error(`bad HOMELAB_TOKEN_KEYS entry: ${entry}`);
    keys.set(kid, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }));
  }
  return keys;
};

// The claims of a valid token, or null for anything else: bad shape,
// unknown kid, any algorithm but EdDSA (so `alg: none` is refused), bad
// signature, wrong issuer/audience, expired.
export const verifyToken = (
  token: string,
  keys: Map<string, KeyObject>,
  now = Date.now(),
): TokenClaims | null => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as {
      alg?: string;
      kid?: string;
    } | null;
    const key = header?.alg === "EdDSA" ? keys.get(header.kid as string) : undefined;
    if (!key) return null;
    if (
      !verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"))
    )
      return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as TokenClaims;
    if (claims.iss !== TOKEN_ISSUER || claims.aud !== TOKEN_AUDIENCE) return null;
    if (typeof claims.exp !== "number" || claims.exp <= Math.floor(now / 1000)) return null;
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    return claims;
  } catch {
    return null;
  }
};

// X-Homelab-Token (what the gate injects) or `Authorization: Bearer` (what
// apps send each other on app-to-app calls).
export const tokenFromHeaders = (
  headers: Record<string, string | string[] | undefined>,
): string | null => {
  const direct = headers["x-homelab-token"];
  if (typeof direct === "string" && direct) return direct;
  const auth = headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim() || null;
  return null;
};
