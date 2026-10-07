import { test } from "node:test";
import assert from "node:assert/strict";
import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { forwardTokenHeaders, homelabFetch } from "../src/forward.js";
import { EightBallClient } from "../src/eightball/client.js";

// Records the headers of every request and answers the gateway's blob upload.
const recorder = async () => {
  const seen: IncomingHttpHeaders[] = [];
  const server = http.createServer((req, response) => {
    seen.push(req.headers);
    req.resume();
    req.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "blob1" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    url,
    seen,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
};

test("forwardTokenHeaders: Bearer by default, X-Homelab-Token when Authorization is taken, nothing without a token", () => {
  assert.deepEqual(forwardTokenHeaders("t"), { authorization: "Bearer t" });
  assert.deepEqual(forwardTokenHeaders("t", { Authorization: "Bearer key" }), {
    "x-homelab-token": "t",
  });
  assert.deepEqual(forwardTokenHeaders(null), {});
});

test("homelabFetch forwards the caller's token", async () => {
  const srv = await recorder();
  try {
    await homelabFetch({ homelabToken: "tok" }, `${srv.url}/api/x`);
    await homelabFetch({ homelabToken: null }, `${srv.url}/api/x`);
    assert.equal(srv.seen[0].authorization, "Bearer tok");
    assert.equal(srv.seen[1].authorization, undefined);
  } finally {
    await srv.close();
  }
});

test("EightBallClient.forCaller keeps the API key and adds X-Homelab-Token", async () => {
  const srv = await recorder();
  try {
    const client = new EightBallClient({ baseUrl: srv.url, apiKey: "key", requester: "test" });
    await client.forCaller({ homelabToken: "tok" }).uploadBlob("data:image/png;base64,AA==");
    await client.uploadBlob("data:image/png;base64,AA==");
    assert.equal(srv.seen[0].authorization, "Bearer key");
    assert.equal(srv.seen[0]["x-homelab-token"], "tok");
    assert.equal(srv.seen[1]["x-homelab-token"], undefined);
  } finally {
    await srv.close();
  }
});
