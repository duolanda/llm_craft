export type ModelRequestFailure = "cancelled" | "quota" | "network" | "timeout" | "transient" | "other";

export interface ModelRetryProgress {
  /** Retry number, excluding the initial request. */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  phase: "waiting" | "retrying";
  error: unknown;
}

export interface ModelRequestRetryOptions {
  signal?: AbortSignal;
  onRetry?: (progress: ModelRetryProgress) => void;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2_000;

/** Inspect error/cause fields, never request headers, payloads or arbitrary object serialization. */
export function classifyModelRequestError(error: unknown): ModelRequestFailure {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const labels: string[] = [];
  let status: number | undefined;
  while (pending.length > 0 && seen.size < 8) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const fields = current as Record<string, unknown>;
    if (status === undefined && typeof fields.status === "number" && Number.isFinite(fields.status)) status = fields.status;
    for (const key of ["name", "message", "code", "type", "errno"]) {
      if (typeof fields[key] === "string") labels.push(fields[key].slice(0, 4_096));
    }
    pending.push(fields.cause, fields.error);
  }
  const text = labels.join("\n");
  if (/AbortError|APIUserAbortError|ABORT_ERR|MODEL_REQUEST_ABORTED|request (?:was )?aborted|^aborted$/im.test(text)) return "cancelled";
  // OpenCode Go subscription limits can also arrive as HTTP 429.
  if (/GoUsageLimitError|FreeUsageLimitError|insufficient_quota|credit_balance_exhausted|(?:spend|usage)_limit_exceeded|quota exceeded|out of budget|billing|usage limit reached|available balance/i.test(text)) return "quota";
  if (status === 408) return "timeout";
  if (status === 409 || status === 429 || (status !== undefined && status >= 500 && status < 600)) return "transient";
  if (status !== undefined && status >= 400 && status < 500) return "other";
  if (/ETIMEDOUT|UND_ERR_\w*TIMEOUT|timed? out|timeout/i.test(text)) return "timeout";
  if (/ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET|network.?error|connection.?(?:error|refused|lost)|fetch failed|socket hang up|other side closed|reset before headers|upstream.?connect|socket connection was closed|terminated/i.test(text)) return "network";
  return "other";
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Model request cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry only one model request; history, tool execution and persistence stay outside this loop. */
export async function retryModelRequest<T>(
  request: (attempt: number) => Promise<T>,
  options: ModelRequestRetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      const result = await request(attempt);
      options.signal?.throwIfAborted();
      return result;
    } catch (error) {
      options.signal?.throwIfAborted();
      const kind = classifyModelRequestError(error);
      if (attempt > MAX_RETRIES || (kind !== "network" && kind !== "timeout" && kind !== "transient")) throw error;
      const progress: ModelRetryProgress = {
        attempt, maxAttempts: MAX_RETRIES, delayMs: BASE_DELAY_MS * 2 ** (attempt - 1), phase: "waiting", error,
      };
      options.onRetry?.(progress);
      await waitForRetry(progress.delayMs, options.signal);
      options.signal?.throwIfAborted();
      options.onRetry?.({ ...progress, phase: "retrying", delayMs: 0 });
    }
  }
}
