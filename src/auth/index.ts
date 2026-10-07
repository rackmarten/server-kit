import type { AuthConfig, AuthStrategy } from "./types.js";
import { createTailnetTrustStrategy } from "./tailnetTrust.js";
import { createJwtStrategy } from "./jwt.js";

export type {
  AuthConfig,
  AuthStrategy,
  HomelabUser,
  JwtOptions,
  TailnetTrustOptions,
} from "./types.js";
export { createJwtStrategy, registerJwtAuth } from "./jwt.js";
export type { JwtStrategy } from "./jwt.js";
export {
  parsePublicKeys,
  tokenFromHeaders,
  verifyToken,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
} from "./token.js";
export type { TokenClaims } from "./token.js";

export const createAuthStrategy = (config: AuthConfig): AuthStrategy => {
  switch (config.strategy) {
    case "tailnet-trust": {
      return createTailnetTrustStrategy(config.options);
    }
    case "jwt": {
      return createJwtStrategy(config.options);
    }
    case "real": {
      // Not implemented yet - homelab services currently rely on
      // the reverse proxy's tailnet gate rather than per-user login. Add a
      // real strategy (session/passkey) here if a service ever needs
      // actual user accounts, and switch to it via config alone.
      throw new Error("'real' auth strategy is not implemented yet");
    }
    default: {
      throw new Error(`Unknown auth strategy: ${(config as AuthConfig).strategy}`);
    }
  }
};
