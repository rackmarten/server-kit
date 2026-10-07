import type { FastifyInstance } from "fastify";

export const registerHealth = async (
  app: FastifyInstance,
  check?: () => Promise<void> | void,
  // eslint-disable-next-line @typescript-eslint/require-await -- keeps the Promise<void> contract so registration errors reject instead of throwing synchronously
): Promise<void> => {
  // Public: healthchecks run over SSH/LAN without an identity token.
  app.get("/health", { config: { public: true } }, async () => {
    if (check) await check();
    return { status: "ok" };
  });
};
