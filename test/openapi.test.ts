import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/core.js";
import { Type, type TypeBoxTypeProvider } from "../src/index.js";

const thingSchema = Type.Object({ id: Type.Integer(), name: Type.String() });

const buildApp = async (openapi?: false) =>
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
