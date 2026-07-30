import type {
  ModelCompletionRequest,
  ModelCompletionResult,
  ModelTransport,
  ModelTransportDescriptor,
} from "./ModelTransport";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

/** Applies RPM to every model request, including requests inside one tool loop. */
export class RateLimitedModelTransport implements ModelTransport {
  private nextAvailableAt = 0;
  private chain = Promise.resolve();

  constructor(
    private readonly inner: ModelTransport,
    private readonly rpm?: number | null,
  ) {}

  complete(request: ModelCompletionRequest): Promise<ModelCompletionResult> {
    if (!this.rpm) {
      return this.inner.complete(request);
    }

    const intervalMs = 60_000 / this.rpm;
    const run = async () => {
      if (request.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const waitMs = Math.max(0, this.nextAvailableAt - Date.now());
      if (waitMs > 0) {
        await sleep(waitMs, request.signal);
      }
      this.nextAvailableAt = Math.max(this.nextAvailableAt, Date.now()) + intervalMs;
      return this.inner.complete(request);
    };

    const pending = this.chain.then(run, run);
    this.chain = pending.then(() => undefined, () => undefined);
    return pending;
  }

  getDescriptor(): ModelTransportDescriptor {
    return this.inner.getDescriptor();
  }
}
