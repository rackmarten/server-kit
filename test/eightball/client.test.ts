import { test } from "node:test";
import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { EightBallClient } from "../../src/eightball/client.js";
import type { InferenceRequestBody } from "../../src/eightball/client.js";

const API_KEY = "test-key";

// Fake inference gateway: a submitted request completes (or fails) on the Nth
// poll, controlled per-test by `respond`. Good enough to exercise
// submit -> poll -> parse without a real gateway.
const closeServer = (server: http.Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });

const startFakeGateway = (handlers: {
  onBlob?: (req: IncomingMessage, body: Buffer) => { status: number; body: unknown };
  onSubmit?: (body: InferenceRequestBody) => { status: number; body: unknown };
  onPoll?: (id: string, pollCount: number) => { status: number; body: unknown };
  onCancel?: (id: string) => number;
}): Promise<{ url: string; close: () => Promise<void> }> => {
  const pollCounts = new Map<string, number>();

  const server = http.createServer((req, response) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      send(req, response, raw);
    });
  });

  const send = (req: IncomingMessage, response: ServerResponse, raw: Buffer) => {
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const url = req.url ?? "";
    if (req.method === "POST" && url === "/v1/blobs" && handlers.onBlob) {
      const { status, body } = handlers.onBlob(req, raw);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    if (req.method === "POST" && url === "/v1/inference" && handlers.onSubmit) {
      const { status, body } = handlers.onSubmit(
        JSON.parse(raw.toString("utf8")) as InferenceRequestBody,
      );
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    const pollMatch = /^\/v1\/requests\/(.+)$/.exec(url);
    if (req.method === "GET" && pollMatch && handlers.onPoll) {
      const id = pollMatch[1];
      const count = (pollCounts.get(id) ?? 0) + 1;
      pollCounts.set(id, count);
      const { status, body } = handlers.onPoll(id, count);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    if (req.method === "DELETE" && pollMatch && handlers.onCancel) {
      response.writeHead(handlers.onCancel(pollMatch[1]));
      response.end();
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  };

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        close: () => closeServer(server),
      });
    });
  });
};

const makeClient = (
  baseUrl: string,
  overrides: Partial<ConstructorParameters<typeof EightBallClient>[0]> = {},
) =>
  new EightBallClient({
    baseUrl,
    apiKey: API_KEY,
    requester: "test-suite",
    pollIntervalMs: 5,
    pollTimeoutMs: 500,
    retries: 0,
    ...overrides,
  });

test("uploadBlob sends raw bytes with the given mime type", async () => {
  let seenContentType: string | undefined;
  let seenBody: Buffer | undefined;
  const gateway = await startFakeGateway({
    onBlob: (req, body) => {
      seenContentType = req.headers["content-type"];
      seenBody = body;
      return { status: 201, body: { id: "blob-1" } };
    },
  });
  try {
    const client = makeClient(gateway.url);
    const result = await client.uploadBlob(Buffer.from("fake-image-bytes"), "image/png");
    assert.deepEqual(result, { id: "blob-1" });
    assert.equal(seenContentType, "image/png");
    assert.equal(seenBody?.toString("utf8"), "fake-image-bytes");
  } finally {
    await gateway.close();
  }
});

test("uploadBlob sends a data URI as JSON", async () => {
  let seenBody: unknown;
  const gateway = await startFakeGateway({
    onBlob: (_req, body) => {
      seenBody = JSON.parse(body.toString("utf8"));
      return { status: 201, body: { id: "blob-2" } };
    },
  });
  try {
    const client = makeClient(gateway.url);
    const dataUri = "data:image/png;base64,AAAA";
    const result = await client.uploadBlob(dataUri);
    assert.deepEqual(result, { id: "blob-2" });
    // eslint-disable-next-line id-denylist -- wire-format field name of the gateway API
    assert.deepEqual(seenBody, { data: dataUri });
  } finally {
    await gateway.close();
  }
});

test("infer submits and polls a single litellm-style request to completion", async () => {
  const gateway = await startFakeGateway({
    onSubmit: (body) => {
      assert.equal(body.capability, "vision");
      assert.equal(body.requester, "test-suite");
      return { status: 202, body: { id: "req-1", status: "queued", priority: "normal" } };
    },
    onPoll: (_id, count) => {
      if (count < 2) return { status: 200, body: { id: "req-1", status: "running" } };
      return {
        status: 200,
        body: {
          id: "req-1",
          status: "completed",
          result: { choices: [{ message: { content: "a cat" } }], model: "llava" },
        },
      };
    },
  });
  try {
    const client = makeClient(gateway.url);
    const result = await client.infer({
      capability: "vision",
      prompt: "describe",
      image: "data:image/png;base64,AAAA",
    });
    assert.deepEqual(result, { content: "a cat", model: "llava" });
  } finally {
    await gateway.close();
  }
});

test("infer submits a batch (items[]) and returns typed per-item results", async () => {
  const gateway = await startFakeGateway({
    onSubmit: (body) => {
      assert.equal(body.capability, "clip-embed");
      assert.equal(body.model, "clip-vit-b32");
      assert.equal(body.items?.length, 2);
      return { status: 202, body: { id: "batch-1", status: "queued", priority: "normal" } };
    },
    onPoll: (_id, count) => {
      if (count < 2) return { status: 200, body: { id: "batch-1", status: "running" } };
      return {
        status: 200,
        body: {
          id: "batch-1",
          status: "completed",
          result: {
            results: [
              { ok: true, output: [0.1, 0.2] },
              { ok: false, error: "bad image" },
            ],
          },
        },
      };
    },
  });
  try {
    const client = makeClient(gateway.url);
    const result = await client.infer({
      capability: "clip-embed",
      model: "clip-vit-b32",
      items: [{ image: "blob:1" }, { image: "blob:2" }],
    });
    assert.deepEqual(result, {
      results: [
        { ok: true, output: [0.1, 0.2] },
        { ok: false, error: "bad image" },
      ],
    });
  } finally {
    await gateway.close();
  }
});

test("infer rejects items[] combined with a litellm capability before submitting", async () => {
  let hasSubmitted = false;
  const gateway = await startFakeGateway({
    onSubmit: () => {
      hasSubmitted = true;
      return { status: 400, body: { error: "should not be reached" } };
    },
  });
  try {
    const client = makeClient(gateway.url);
    await assert.rejects(
      () => client.infer({ capability: "vision", items: [{ image: "blob:1" }] }),
      /does not accept items/,
    );
    assert.equal(hasSubmitted, false);
  } finally {
    await gateway.close();
  }
});

test("infer surfaces a failed request's error", async () => {
  const gateway = await startFakeGateway({
    onSubmit: () => ({
      status: 202,
      body: { id: "req-fail", status: "queued", priority: "normal" },
    }),
    onPoll: () => ({
      status: 200,
      body: { id: "req-fail", status: "failed", error: "provider unreachable" },
    }),
  });
  try {
    const client = makeClient(gateway.url);
    await assert.rejects(
      () => client.infer({ capability: "text", prompt: "hi" }),
      /provider unreachable/,
    );
  } finally {
    await gateway.close();
  }
});

test("parseResult parses a callback body the same way as a poll response", () => {
  const client = makeClient("https://unused.invalid");
  const single = client.parseResult(
    {
      id: "x",
      status: "completed",
      result: { choices: [{ message: { content: "hi" } }], model: "m" },
    },
    false,
  );
  assert.deepEqual(single, { content: "hi", model: "m" });

  const batch = client.parseResult(
    { id: "y", status: "completed", result: { results: [{ ok: true, output: 1 }] } },
    true,
  );
  assert.deepEqual(batch, { results: [{ ok: true, output: 1 }] });
});

test("infer keeps polling a queued request past pollTimeoutMs without resubmitting", async () => {
  const submitted: string[] = [];
  const cancelled: string[] = [];
  const started = Date.now();
  const gateway = await startFakeGateway({
    onSubmit: () => {
      submitted.push("req-q");
      return { status: 202, body: { id: "req-q", status: "queued" } };
    },
    onPoll: (id) => {
      if (Date.now() - started < 150) return { status: 200, body: { id, status: "queued" } };
      return {
        status: 200,
        body: { id, status: "completed", result: { choices: [{ message: { content: "ok" } }] } },
      };
    },
    onCancel: (id) => {
      cancelled.push(id);
      return 204;
    },
  });
  try {
    const client = makeClient(gateway.url, { pollTimeoutMs: 40, retries: 2, retryDelayMs: 0 });
    const result = await client.infer({ capability: "text", prompt: "hi" });
    assert.equal(result.content, "ok");
    assert.deepEqual(submitted, ["req-q"]);
    assert.deepEqual(cancelled, []);
  } finally {
    await gateway.close();
  }
});

test("infer cancels a request running past pollTimeoutMs and resubmits once", async () => {
  let submits = 0;
  const cancelled: string[] = [];
  const gateway = await startFakeGateway({
    onSubmit: () => {
      submits++;
      return { status: 202, body: { id: `req-${String(submits)}`, status: "queued" } };
    },
    onPoll: (id) => {
      if (id === "req-1") return { status: 200, body: { id, status: "running" } };
      return {
        status: 200,
        body: { id, status: "completed", result: { choices: [{ message: { content: "two" } }] } },
      };
    },
    onCancel: (id) => {
      cancelled.push(id);
      return 204;
    },
  });
  try {
    const client = makeClient(gateway.url, { pollTimeoutMs: 40, retries: 2, retryDelayMs: 0 });
    const result = await client.infer({ capability: "text", prompt: "hi" });
    assert.equal(result.content, "two");
    assert.equal(submits, 2);
    assert.deepEqual(cancelled, ["req-1"]);
  } finally {
    await gateway.close();
  }
});

test("infer cancels each attempt past queuedTimeoutMs exactly once, then fails", async () => {
  let submits = 0;
  const cancelled: string[] = [];
  const gateway = await startFakeGateway({
    onSubmit: () => {
      submits++;
      return { status: 202, body: { id: `req-${String(submits)}`, status: "queued" } };
    },
    onPoll: (id) => ({ status: 200, body: { id, status: "queued" } }),
    onCancel: (id) => {
      cancelled.push(id);
      return id === "req-2" ? 404 : 204;
    },
  });
  try {
    const client = makeClient(gateway.url, {
      pollTimeoutMs: 10,
      queuedTimeoutMs: 40,
      retries: 2,
      retryDelayMs: 0,
    });
    await assert.rejects(
      () => client.infer({ capability: "text", prompt: "hi" }),
      /timed out while queued/,
    );
    assert.equal(submits, 3);
    assert.deepEqual(cancelled, ["req-1", "req-2", "req-3"]);
  } finally {
    await gateway.close();
  }
});

test("infer cancels a request when polling it fails", async () => {
  const cancelled: string[] = [];
  const gateway = await startFakeGateway({
    onSubmit: () => ({ status: 202, body: { id: "req-err", status: "queued" } }),
    onPoll: () => ({ status: 500, body: { error: "boom" } }),
    onCancel: (id) => {
      cancelled.push(id);
      return 204;
    },
  });
  try {
    const client = makeClient(gateway.url);
    await assert.rejects(() => client.infer({ capability: "text", prompt: "hi" }), /returned 500/);
    assert.deepEqual(cancelled, ["req-err"]);
  } finally {
    await gateway.close();
  }
});

test("infer resubmits a gateway-failed request without cancelling it", async () => {
  let submits = 0;
  const cancelled: string[] = [];
  const gateway = await startFakeGateway({
    onSubmit: () => {
      submits++;
      return { status: 202, body: { id: `req-${String(submits)}`, status: "queued" } };
    },
    onPoll: (id) => {
      if (id === "req-1") return { status: 200, body: { id, status: "failed", error: "oom" } };
      return {
        status: 200,
        body: { id, status: "completed", result: { choices: [{ message: { content: "ok" } }] } },
      };
    },
    onCancel: (id) => {
      cancelled.push(id);
      return 204;
    },
  });
  try {
    const client = makeClient(gateway.url, { retries: 1, retryDelayMs: 0 });
    const result = await client.infer({ capability: "text", prompt: "hi" });
    assert.equal(result.content, "ok");
    assert.equal(submits, 2);
    assert.deepEqual(cancelled, []);
  } finally {
    await gateway.close();
  }
});

test("infer sends litellm sampling fields in the submit body", async () => {
  const seen: InferenceRequestBody[] = [];
  const gateway = await startFakeGateway({
    onSubmit: (body) => {
      seen.push(body);
      return { status: 202, body: { id: "req-s", status: "queued" } };
    },
    onPoll: (id) => ({
      status: 200,
      body: { id, status: "completed", result: { choices: [{ message: { content: "ok" } }] } },
    }),
  });
  try {
    const client = makeClient(gateway.url);
    await client.infer({
      capability: "text",
      prompt: "hi",
      temperature: 0.2,
      maxTokens: 64,
      think: false,
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].temperature, 0.2);
    assert.equal(seen[0].maxTokens, 64);
    assert.equal(seen[0].think, false);
  } finally {
    await gateway.close();
  }
});
