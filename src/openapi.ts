import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { Type, type Static, type TSchema, type TUnsafe } from "@fastify/type-provider-typebox";
import type { FastifyInstance } from "fastify";

// Every app gets its OpenAPI document and a Swagger UI for free. A route
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
  // Swagger UI for the document. On unless `false`.
  ui?: boolean;
  // Where the UI is served. Default "/api/docs".
  uiRoute?: string;
  // Describe the jwt strategy's token in `components.securitySchemes` and
  // require it on every route not marked `config: { public: true }`.
  // createApp sets this under the jwt strategy.
  jwt?: boolean;
}

// The UI's own CSP, scoped to its routes. Every asset is served from the
// same origin, so this is no looser than helmet's default for the rest of
// the app; inline styles are allowed because Swagger UI sets style
// attributes.
const DOCS_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
].join("; ");

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
        title: options.title ?? "API",
        version: options.version ?? "0.0.0",
        description: options.description,
      },
      ...(options.jwt && {
        components: {
          securitySchemes: {
            bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
            tokenHeader: { type: "apiKey", in: "header", name: "x-homelab-token" },
          },
        },
        security: [{ bearerAuth: [] }, { tokenHeader: [] }],
      }),
    },
    // Name a shared schema after its $id (see defineDto) instead of def-<n>.
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, i) =>
        typeof json.$id === "string" ? json.$id : `def-${String(i)}`,
    },
    ...(options.jwt && {
      // A public route needs no token, so it overrides the global security.
      transform: ({ schema, url, route }) =>
        route.config?.public ? { schema: { ...schema, security: [] }, url } : { schema, url },
    }),
  });

  const route = options.route ?? "/api/openapi.json";
  app.get(route, { schema: { hide: true } }, () => Promise.resolve(app.swagger()));

  if (options.ui !== false) {
    await app.register(swaggerUi, {
      routePrefix: options.uiRoute ?? "/api/docs",
      staticCSP: DOCS_CSP,
    });
  }
};

// A named, reusable DTO: registers `schema` as a shared schema called
// `name`, so it is listed once under `components.schemas`, and returns a
// reference to it that keeps the schema's static type for route handlers.
// Call it before the routes that use it, on the same instance (or a parent).
export const defineDto = <T extends TSchema>(
  app: FastifyInstance,
  name: string,
  schema: T,
): TUnsafe<Static<T>> => {
  app.addSchema({ ...schema, $id: name });
  return Type.Unsafe<Static<T>>(Type.Ref(name));
};
