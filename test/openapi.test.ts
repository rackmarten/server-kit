import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/core.js";
import { defineDto, Type, type TypeBoxTypeProvider } from "../src/index.js";
import type { OpenApiOptions } from "../src/openapi.js";

const thingSchema = Type.Object({ id: Type.Integer(), name: Type.String() });

const buildApp = async (openapi?: false | OpenApiOptions) =>
  createApp({
    auth: { strategy: "tailnet-trust" },
    logger: false,
    openapi: openapi ?? { title: "things", version: "1.2.3" },
    // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin signature must be async
    registerServices: async (app) => {
      const typed = app.withTypeProvider<TypeBoxTypeProvider>();
      typed.get(
        "/api/things/:id",
        { schema: { params: Type.Object({ id: Type.Integer() }), response: { 200: thingSchema } } },
        // `id` is typed as number here; a string would not compile.
        (request) =>
          Promise.resolve({
            id: request.params.id,
            name: `thing ${String(request.params.id + 1)}`,
          }),
      );
      typed.post(
        "/api/things",
        { schema: { body: Type.Object({ name: Type.String({ minLength: 1 }) }) } },
        (request) => Promise.resolve({ name: request.body.name }),
      );
      app.get("/api/legacy", () => Promise.resolve({ ok: true }));
      const widget = defineDto(
        app,
        "Widget",
        Type.Object({ id: Type.Integer(), label: Type.String() }),
      );
      typed.get("/api/widgets", { schema: { response: { 200: Type.Array(widget) } } }, () =>
        // `label` is typed as string here; extra properties are dropped.
        Promise.resolve([{ id: 1, label: "first", secret: "x" }]),
      );
      typed.post(
        "/api/widgets",
        { schema: { body: widget, response: { 200: widget } } },
        (request) => Promise.resolve({ id: request.body.id + 1, label: request.body.label }),
      );
    },
  });

interface JsonContent {
  content: Record<string, { schema: { properties: Record<string, { minLength?: number }> } }>;
}

interface Operation {
  parameters: { name: string; in: string; schema: { type: string } }[];
  responses: Record<string, JsonContent>;
  requestBody: JsonContent;
}

interface OpenApiDocument {
  openapi: string;
  info: unknown;
  paths: Record<string, { get?: Operation; post?: Operation } | undefined>;
}

test("a schema'd route shows up in /api/openapi.json with its types", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "GET", url: "/api/openapi.json" });
  assert.equal(response.statusCode, 200);
  const doc = response.json<OpenApiDocument>();
  assert.equal(doc.openapi, "3.1.0");
  assert.deepEqual(doc.info, { title: "things", version: "1.2.3" });

  const get = doc.paths["/api/things/{id}"]?.get;
  assert.ok(get);
  assert.equal(get.parameters[0].name, "id");
  assert.equal(get.parameters[0].in, "path");
  assert.equal(get.parameters[0].schema.type, "integer");
  const ok = get.responses["200"].content["application/json"].schema;
  // eslint-disable-next-line unicorn/no-array-sort, sonarjs/no-alphabetical-sort -- sorts a fresh ASCII Object.keys array; toSorted is not in the test lib target
  assert.deepEqual(Object.keys(ok.properties).sort(), ["id", "name"]);

  const post = doc.paths["/api/things"]?.post;
  assert.ok(post);
  const body = post.requestBody.content["application/json"].schema;
  assert.equal(body.properties.name.minLength, 1);

  // Unconverted routes are listed without types; the document itself is not.
  assert.ok(doc.paths["/api/legacy"]?.get);
  assert.equal(doc.paths["/api/openapi.json"], undefined);
  await app.close();
});

test("the schema validates and serializes", async () => {
  const app = await buildApp();
  const invalidParam = await app.inject({ method: "GET", url: "/api/things/nope" });
  assert.equal(invalidParam.statusCode, 400);
  const found = await app.inject({ method: "GET", url: "/api/things/4" });
  assert.deepEqual(found.json(), { id: 4, name: "thing 5" });
  const invalidBody = await app.inject({
    method: "POST",
    url: "/api/things",
    payload: { name: "" },
  });
  assert.equal(invalidBody.statusCode, 400);
  await app.close();
});

test("openapi: false serves no document", async () => {
  const app = await buildApp(false);
  const response = await app.inject({ method: "GET", url: "/api/openapi.json" });
  assert.equal(response.statusCode, 404);
  await app.close();
});

const statusOf = (app: FastifyInstance, url: string) =>
  app.inject({ method: "GET", url }).then((response) => response.statusCode);
const documentOf = <T>(app: FastifyInstance) =>
  app.inject({ method: "GET", url: "/api/openapi.json" }).then((response) => response.json<T>());

interface Components {
  components?: {
    schemas?: Record<string, { properties: Record<string, unknown> }>;
    securitySchemes?: Record<string, unknown>;
  };
  security?: unknown;
  paths: Record<
    string,
    Record<string, { security?: unknown; requestBody?: unknown; responses?: unknown }>
  >;
}

test("a defineDto schema is named under components.schemas and referenced by routes", async () => {
  const app = await buildApp();
  const doc = await documentOf<Components>(app);
  const widget = doc.components?.schemas?.Widget;
  assert.ok(widget);
  assert.deepEqual(Object.keys(widget.properties), ["id", "label"]);
  const ref = { $ref: "#/components/schemas/Widget" };
  const list = doc.paths["/api/widgets"].get.responses as Record<string, JsonContent>;
  assert.deepEqual(list["200"].content["application/json"].schema, { type: "array", items: ref });
  const post = doc.paths["/api/widgets"].post;
  assert.deepEqual((post.requestBody as JsonContent).content["application/json"].schema, ref);
  // Without jwt there is nothing to authenticate with.
  assert.equal(doc.components?.securitySchemes, undefined);
  assert.equal(doc.security, undefined);

  const listed = await app.inject({ method: "GET", url: "/api/widgets" });
  assert.deepEqual(listed.json(), [{ id: 1, label: "first" }]);
  const created = await app.inject({
    method: "POST",
    url: "/api/widgets",
    payload: { id: 1, label: "new" },
  });
  assert.deepEqual(created.json(), { id: 2, label: "new" });
  const invalid = await app.inject({ method: "POST", url: "/api/widgets", payload: { id: "x" } });
  assert.equal(invalid.statusCode, 400);
  await app.close();
});

test("the default title is neutral", async () => {
  const app = await buildApp({});
  const doc = await documentOf<OpenApiDocument>(app);
  assert.deepEqual(doc.info, { title: "API", version: "0.0.0" });
  await app.close();
});

test("Swagger UI at /api/docs loads same-origin assets under a scoped CSP", async () => {
  const app = await buildApp();
  const page = await app.inject({ method: "GET", url: "/api/docs" });
  assert.equal(page.statusCode, 200);
  assert.match(String(page.headers["content-type"]), /^text\/html/);
  const sources = [...page.body.matchAll(/<(?:script|link)[^>]*(?:src|href)="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(sources.some((source) => source.endsWith("swagger-ui-bundle.js")));
  for (const source of sources) assert.doesNotMatch(source, /^(https?:)?\/\//);
  assert.doesNotMatch(page.body, /<script>[^<]*\S/);

  const csp = String(page.headers["content-security-policy"]);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /default-src 'self'/);

  const bundle = await app.inject({ method: "GET", url: "/api/docs/static/swagger-ui-bundle.js" });
  assert.equal(bundle.statusCode, 200);
  const json = await app.inject({ method: "GET", url: "/api/docs/json" });
  assert.equal(json.json<OpenApiDocument>().openapi, "3.1.0");

  // The rest of the app keeps helmet's own policy.
  const other = await app.inject({ method: "GET", url: "/api/legacy" });
  assert.notEqual(other.headers["content-security-policy"], csp);
  assert.match(String(other.headers["content-security-policy"]), /script-src 'self'/);
  // The UI's routes stay out of the document.
  const doc = await documentOf<OpenApiDocument>(app);
  assert.ok(Object.keys(doc.paths).every((path) => !path.startsWith("/api/docs")));
  await app.close();
});

test("ui: false serves the document without the UI, uiRoute moves it", async () => {
  const off = await buildApp({ ui: false });
  assert.equal(await statusOf(off, "/api/docs"), 404);
  assert.equal(await statusOf(off, "/api/openapi.json"), 200);
  await off.close();

  const moved = await buildApp({ uiRoute: "/api/swagger" });
  assert.equal(await statusOf(moved, "/api/swagger"), 200);
  assert.equal(await statusOf(moved, "/api/docs"), 404);
  await moved.close();
});

test("openapi: false serves no UI either", async () => {
  const app = await buildApp(false);
  assert.equal(await statusOf(app, "/api/docs"), 404);
  await app.close();
});
