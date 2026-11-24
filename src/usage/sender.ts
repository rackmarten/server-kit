import {
  USAGE_MAX_BATCH,
  type UsageEvent,
  type UsageEventBatch,
  type UsageInventory,
  type UsageInventoryItem,
} from "./types.js";

// Fire-and-forget delivery to the usage ingest: a bounded in-memory buffer
// flushed in batches. An ingest outage loses events, never breaks the app,
// so nothing here throws or rejects.

export interface UsageLogger {
  debug: (context: unknown, msg?: string) => void;
}

export interface UsageSenderOptions {
  app: string;
  // The ingest's base URL. Empty turns sending into a no-op (local dev).
  endpoint: string;
  flushIntervalMs?: number;
  maxBuffer?: number;
  logger: UsageLogger;
  fetch?: typeof fetch;
}

export interface UsageSender {
  record(event: UsageEvent): void;
  flush(): Promise<void>;
  sendInventory(items: UsageInventoryItem[]): Promise<void>;
  // Stops the timer and flushes what is left.
  close(): Promise<void>;
  // Events waiting in the buffer, for tests.
  readonly buffered: number;
}

export const DEFAULT_USAGE_FLUSH_INTERVAL_MS = 15_000;
export const DEFAULT_USAGE_MAX_BUFFER = 5000;
// A flush starts early once this many events are waiting.
const FLUSH_AT = 500;
const SEND_TIMEOUT_MS = 5000;
const LOG_EVERY_MS = 60_000;

const stripTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
};

export const createUsageSender = (options: UsageSenderOptions): UsageSender => {
  const endpoint = stripTrailingSlashes(options.endpoint);
  const maxBuffer = Math.max(1, options.maxBuffer ?? DEFAULT_USAGE_MAX_BUFFER);
  const flushAt = Math.min(FLUSH_AT, maxBuffer);
  const doFetch = options.fetch ?? fetch;
  const buffer: UsageEvent[] = [];
  let flushing: Promise<void> | null = null;
  let lastLogAt = -Infinity;
  let didLastFlushFail = false;

  // At most one line a minute, at debug: a down ingest is expected to
  // happen and must not flood the app's log.
  const logFailure = (path: string, error: unknown) => {
    const now = Date.now();
    if (now - lastLogAt < LOG_EVERY_MS) return;
    lastLogAt = now;
    options.logger.debug(
      { err: error instanceof Error ? error.message : String(error), path },
      "usage ingest unreachable, dropping batch",
    );
  };

  const post = async (path: string, body: UsageEventBatch | UsageInventory): Promise<boolean> => {
    try {
      const response = await doFetch(`${endpoint}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      return true;
    } catch (error) {
      logFailure(path, error);
      return false;
    }
  };

  const drain = async () => {
    didLastFlushFail = false;
    while (buffer.length > 0) {
      const events = buffer.splice(0, USAGE_MAX_BATCH);
      // A failed batch is dropped; stop there rather than keep hitting a
      // down ingest with the rest until the next interval.
      if (!(await post("/v1/events", { app: options.app, events }))) {
        didLastFlushFail = true;
        return;
      }
    }
  };

  const flush = (): Promise<void> => {
    flushing ??= drain().finally(() => {
      flushing = null;
    });
    return flushing;
  };

  const finalFlush = async () => {
    await flush();
    // A flush already running may have left events recorded meanwhile,
    // unless the ingest just proved to be down.
    if (!didLastFlushFail) await flush();
  };

  const timer = setInterval(() => {
    void flush();
  }, options.flushIntervalMs ?? DEFAULT_USAGE_FLUSH_INTERVAL_MS);
  timer.unref();

  return {
    record(event) {
      if (!endpoint) return;
      buffer.push(event);
      if (buffer.length > maxBuffer) buffer.shift();
      if (buffer.length >= flushAt) void flush();
    },
    flush,
    async sendInventory(items) {
      if (endpoint) await post("/v1/inventory", { app: options.app, items });
    },
    async close() {
      clearInterval(timer);
      // One deadline for all of it, so a hanging ingest can't hold up the
      // app's shutdown past a container's stop grace period.
      let deadline: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, SEND_TIMEOUT_MS);
      });
      await Promise.race([finalFlush(), timeout]);
      clearTimeout(deadline);
    },
    get buffered() {
      return buffer.length;
    },
  };
};
