import swagger from "@fastify/swagger";
import type { FastifyInstance } from "fastify";

// Every app gets its OpenAPI document for free. A route
// with a TypeBox `schema` (see README "Typed routes") shows up with its
// params/query/body/response types; a route without one still appears, with
// no types, so apps can convert gradually.
export interface OpenApiOptions {
  // Shown in the document's `info`. server-kit can't know the app's own
  // name and version, so pass them (e.g. from its package.json).
  title?: string;
  version?: string;
  description?: string;
  // Where the JSON document is served. Default "/api/openapi.json".
  route?: string;
}

export const registerOpenApi = async (
  app: FastifyInstance,
  options: OpenApiOptions = {},
): Promise<void> => {
  // Must be registered before the routes it documents: it collects them
  // from an onRoute hook.
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: options.title ?? "homelab service",
        version: options.version ?? "0.0.0",
        description: options.description,
      },
    },
  });

  const route = options.route ?? "/api/openapi.json";
  app.get(route, { schema: { hide: true } }, () => Promise.resolve(app.swagger()));
};
