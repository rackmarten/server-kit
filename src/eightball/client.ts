import { forwardTokenHeaders } from "../forward.js";

export type Priority = "critical" | "high" | "normal" | "low";
export type Privacy = "local_only" | "any";

// One input item in a batch sent to a node-served capability (the
// gateway's items[]). A single
// request is just a batch of one.
export interface EightBallItem {
  image?: string;
  text?: string;
}

// litellm-backed capabilities ("text"/"vision"/"embeddings") are the only
// ones the gateway tracks in code; anything else is a string a worker node
// advertised via its own registration. Kept as a plain string here too, on
// purpose — this client shouldn't need updating every time a new node
// capability is added on the gateway side.
// eslint-disable-next-line sonarjs/redundant-type-aliases -- exported public type name
export type Capability = string;
const LITELLM_CAPABILITIES = new Set(["text", "vision", "embeddings"]);

export interface InferenceRequestBody {
  capability: Capability;
  prompt?: string;
  image?: string;
  // Batch payload for a node-served capability. Never combine with a
  // litellm capability (text/vision/embeddings) — the gateway rejects that with
  // a 400, since those are single-call-only.
  items?: EightBallItem[];
  // Pins this request to an exact model. Always set this for a node-served
  // capability whose outputs get compared across calls (e.g. embeddings) —
  // only a node that advertised this exact capability+model pair can lease
  // the request, and vectors/outputs from different models aren't
  // comparable. Unused by the three litellm capabilities.
  model?: string;
  // Passed through to the node's worker /run call as-is; never read by
  // the gateway itself.
  params?: unknown;
  priority?: Priority;
  privacy?: Privacy;
  requester?: string;
  // litellm sampling fields, passed through by the gateway. Apply to
  // text/vision only; ignored for embeddings and node-served capabilities.
  temperature?: number;
  maxTokens?: number;
  think?: boolean;
}

export interface InferenceResult {
  content: string;
  model?: string;
}

export interface EightBallItemResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface BatchInferenceResult {
  results: EightBallItemResult[];
}

export interface EightBallClientOptions {
  baseUrl: string;
  apiKey: string;
  requester: string;
  pollIntervalMs?: number;
  // How long a request may stay `running` before the attempt is abandoned.
  // Time spent `queued` doesn't count: a busy queue is not a failure, and
  // resubmitting would only put the same work in the queue again.
  pollTimeoutMs?: number;
  // Safety limit on time spent `queued` (default 30 minutes). An abandoned
  // request is always cancelled in the gateway (DELETE /v1/requests/:id), so
  // a retry never leaves the old one to run as well.
  queuedTimeoutMs?: number;
  // How many full submit-and-poll attempts to make before giving up. A paused
  // shared service otherwise looks like a quality bug in its consumer: a
  // single gateway hiccup (paused queue, a redeployed litellm briefly
  // failing health checks) would fall straight through to a permanent
  // failure with no second attempt.
  retries?: number;
  retryDelayMs?: number;
  // Identity token of the person the call is made for, sent as
  // X-Homelab-Token (Authorization already carries the API key). Set it
  // per request with forCaller() rather than here.
  homelabToken?: string | null;
}

interface InferenceRecord {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  result?: {
    choices?: { message?: { content?: string } }[];
    model?: string;
    results?: EightBallItemResult[];
  };
  error?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_POLL_TIMEOUT_MS = 90_000;
const DEFAULT_QUEUED_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 5000;

// The gateway itself ended the request (failed/cancelled), so there is
// nothing left to cancel.
class GatewayFinishedError extends Error {}

export class EightBallClient {
  constructor(private readonly options: EightBallClientOptions) {}

  // A copy of this client that forwards the caller's identity token, e.g.
  // `app.eightball.forCaller(request).infer(...)`, so the gateway can tell
  // whose request it is.
  forCaller(caller: { homelabToken?: string | null } | null | undefined): EightBallClient {
    return new EightBallClient({ ...this.options, homelabToken: caller?.homelabToken ?? null });
  }

  private authHeaders(): Record<string, string> {
    const authorization = `Bearer ${this.options.apiKey}`;
    return { authorization, ...forwardTokenHeaders(this.options.homelabToken, { authorization }) };
  }

  // Uploads raw bytes (image/vision.jpg, a video frame, ...) and returns the
  // blob id the gateway assigned it, referenceable elsewhere as
  // "blob:<id>" wherever a request body accepts an image/data URI.
  async uploadBlob(bytes: Buffer | Uint8Array, mime?: string): Promise<{ id: string }>;
  // Uploads an already-encoded data URI (e.g. "data:image/png;base64,...").
  async uploadBlob(dataUri: string): Promise<{ id: string }>;
  async uploadBlob(input: Buffer | Uint8Array | string, mime?: string): Promise<{ id: string }> {
    if (typeof input === "string") {
      return this.fetch<{ id: string }>("/v1/blobs", {
        method: "POST",
        // eslint-disable-next-line id-denylist -- wire-format field name of the gateway API
        body: JSON.stringify({ data: input }),
      });
    }
    const response = await fetch(`${this.options.baseUrl}/v1/blobs`, {
      method: "POST",
      headers: {
        "content-type": mime ?? "application/octet-stream",
        ...this.authHeaders(),
      },
      body: input as BodyInit,
    });
    if (!response.ok)
      throw new Error(`inference gateway /v1/blobs returned ${String(response.status)}`);
    return response.json() as Promise<{ id: string }>;
  }

  // Single litellm-style call (text/vision/embeddings) — unchanged from
  // before batches/node-served capabilities existed.
  async infer(body: Omit<InferenceRequestBody, "requester" | "items">): Promise<InferenceResult>;
  // Batch call to a node-served capability — one typed result per item,
  // in the same order as body.items.
  async infer(
    body: Omit<InferenceRequestBody, "requester"> & { items: EightBallItem[] },
  ): Promise<BatchInferenceResult>;
  async infer(
    body: Omit<InferenceRequestBody, "requester">,
  ): Promise<InferenceResult | BatchInferenceResult> {
    const retries = this.options.retries ?? DEFAULT_RETRIES;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.runOnce(body);
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await sleep(this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async runOnce(
    body: Omit<InferenceRequestBody, "requester">,
  ): Promise<InferenceResult | BatchInferenceResult> {
    if (body.items && body.items.length > 0 && LITELLM_CAPABILITIES.has(body.capability)) {
      throw new Error(
        `capability ${body.capability} does not accept items[] — that's for node-served capabilities only`,
      );
    }

    const submitted = await this.fetch<{ id: string }>("/v1/inference", {
      method: "POST",
      body: JSON.stringify({ ...body, requester: this.options.requester }),
    });

    try {
      return await this.pollUntilDone(submitted.id, Boolean(body.items && body.items.length > 0));
    } catch (error) {
      if (!(error instanceof GatewayFinishedError)) await this.cancel(submitted.id);
      throw error;
    }
  }

  // Polls one request id until it finishes. Time is attributed to the status
  // seen at the start of each interval, so only `running` time counts
  // against pollTimeoutMs and only `queued` time against queuedTimeoutMs.
  private async pollUntilDone(
    id: string,
    isBatch: boolean,
  ): Promise<InferenceResult | BatchInferenceResult> {
    const pollInterval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const runningLimit = this.options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const queuedLimit = this.options.queuedTimeoutMs ?? DEFAULT_QUEUED_TIMEOUT_MS;
    let status: InferenceRecord["status"] = "queued";
    let runningMs = 0;
    let queuedMs = 0;
    let last = Date.now();

    for (;;) {
      await sleep(pollInterval);
      const record = await this.fetch<InferenceRecord>(`/v1/requests/${id}`);
      const now = Date.now();
      if (status === "queued") queuedMs += now - last;
      else runningMs += now - last;
      last = now;
      status = record.status;

      if (record.status === "completed") {
        return this.parseResult(record, isBatch);
      }
      if (record.status === "failed" || record.status === "cancelled") {
        throw new GatewayFinishedError(
          `inference request ${record.status}: ${record.error ?? "unknown error"}`,
        );
      }
      if (runningMs >= runningLimit) throw new Error("inference request timed out while running");
      if (queuedMs >= queuedLimit) throw new Error("inference request timed out while queued");
    }
  }

  // Best effort: 204 (cancelled) and 404 (already finished) are both fine,
  // and any other failure is swallowed so the caller sees the original error.
  // No content-type header, since there is no body.
  private async cancel(id: string): Promise<void> {
    try {
      await fetch(`${this.options.baseUrl}/v1/requests/${id}`, {
        method: "DELETE",
        headers: this.authHeaders(),
      });
    } catch {
      // gateway unreachable; nothing more to do
    }
  }

  // Shared between polling above and a caller parsing a callbackUrl POST
  // body (same QueuedRequest shape the gateway sends to both).
  parseResult(record: InferenceRecord, isBatch: boolean): InferenceResult | BatchInferenceResult {
    if (isBatch) {
      return { results: record.result?.results ?? [] };
    }
    const content = record.result?.choices?.[0]?.message?.content;
    if (!content) throw new Error("inference gateway returned no content");
    return { content, model: record.result?.model };
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...this.authHeaders(),
        // eslint-disable-next-line @typescript-eslint/no-misused-spread -- HeadersInit spread semantics kept as-is (callers pass plain objects)
        ...init?.headers,
      },
    });
    if (!response.ok)
      throw new Error(`inference gateway ${path} returned ${String(response.status)}`);
    return response.json() as Promise<T>;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
