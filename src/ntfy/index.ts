// Publishes to an ntfy server, for phone push. One topic per app, each with
// a write-only token (e.g. NTFY_TOKEN_<APP>). NTFY_URL can be the server's
// LAN address when its public hostname sits behind an auth gate that server
// processes can't pass.
//
// Sent as ntfy's JSON publish (POST to the root URL) rather than headers, so
// a title with diacritics isn't mangled or rejected as a non-ASCII header.

export type NtfyPriority =
  1 | 2 | 3 | 4 | 5 | "min" | "low" | "default" | "high" | "max" | "urgent";

const PRIORITY_NAMES: Record<string, number> = {
  min: 1,
  low: 2,
  default: 3,
  high: 4,
  max: 5,
  urgent: 5,
};

export interface NtfyMessage {
  topic: string;
  message: string;
  title?: string;
  // Opened when the notification is tapped.
  clickUrl?: string;
  priority?: NtfyPriority;
  // Emoji shortcodes ("warning") render as emoji in front of the title.
  tags?: string[];
}

export interface NtfyLogger {
  warn: (context: unknown, msg?: string) => void;
}

export interface NtfyClientOptions {
  // Empty or unset turns notify() into a no-op, so local dev needs no ntfy.
  url: string | undefined;
  token: string | undefined;
  timeoutMs?: number;
  // A Fastify/pino logger fits (app.log); defaults to console.
  logger?: NtfyLogger;
  fetch?: typeof fetch;
}

export interface NtfyClient {
  // Never rejects: a failed publish is logged and resolves false, so a
  // notification can't break the request that triggered it.
  notify(message: NtfyMessage): Promise<boolean>;
}

const stripTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end--;
  return value.slice(0, end);
};

export const createNtfyClient = (options: NtfyClientOptions): NtfyClient => {
  const url = options.url === undefined ? undefined : stripTrailingSlashes(options.url);
  const timeoutMs = options.timeoutMs ?? 5000;
  const logger = options.logger ?? console;
  const doFetch = options.fetch ?? fetch;

  return {
    async notify({ topic, message, title, clickUrl, priority, tags }) {
      if (!url) return false;
      const body: Record<string, unknown> = { topic, message };
      if (title) body.title = title;
      if (clickUrl) body.click = clickUrl;
      if (priority !== undefined)
        body.priority = typeof priority === "number" ? priority : PRIORITY_NAMES[priority];
      if (tags?.length) body.tags = tags;

      const headers: Record<string, string> = { "content-type": "application/json" };
      if (options.token) headers.authorization = `Bearer ${options.token}`;

      try {
        const response = await doFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) return true;
        const detailText = await response.text().catch(() => "");
        const detail = detailText.slice(0, 200);
        logger.warn({ topic, status: response.status, detail }, "ntfy publish failed");
      } catch (error) {
        logger.warn(
          { topic, err: error instanceof Error ? error.message : String(error) },
          "ntfy publish failed",
        );
      }
      return false;
    },
  };
};
