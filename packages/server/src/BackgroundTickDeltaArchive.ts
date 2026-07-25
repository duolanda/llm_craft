import { gunzipSync } from "node:zlib";
import { Worker } from "node:worker_threads";
import type { TickDeltaRecord } from "@llmcraft/shared";

type WorkerRequest =
  | { operation: "append"; key: string; value: TickDeltaRecord }
  | { id: number; operation: "seal"; key: string }
  | { id: number; operation: "decompress"; value: Uint8Array };

interface WorkerResponse {
  id: number;
  ok: boolean;
  value?: Uint8Array | TickDeltaRecord[];
  error?: string;
}

interface PendingJob {
  resolve: (value: Uint8Array | TickDeltaRecord[]) => void;
  reject: (error: Error) => void;
}

type WorkerJobRequest =
  | { operation: "seal"; key: string }
  | { operation: "decompress"; value: Uint8Array };

const WORKER_SOURCE = String.raw`
  const { parentPort } = require("node:worker_threads");
  const { gzipSync, gunzipSync } = require("node:zlib");
  const chunks = new Map();

  parentPort.on("message", (request) => {
    try {
      if (request.operation === "append") {
        const chunk = chunks.get(request.key) || [];
        chunk.push(request.value);
        chunks.set(request.key, chunk);
        return;
      }
      if (request.operation === "seal") {
        const chunk = chunks.get(request.key) || [];
        chunks.delete(request.key);
        const value = gzipSync(Buffer.from(JSON.stringify(chunk)));
        parentPort.postMessage({ id: request.id, ok: true, value });
        return;
      }
      const json = gunzipSync(Buffer.from(request.value)).toString("utf8");
      parentPort.postMessage({ id: request.id, ok: true, value: JSON.parse(json) });
    } catch (error) {
      parentPort.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
`;

class TickDeltaCompressionWorker {
  private worker: Worker | null = null;
  private workerGeneration = 0;
  private nextJobId = 1;
  private readonly jobs = new Map<number, PendingJob>();

  append(key: string, value: TickDeltaRecord): number {
    const worker = this.getWorker();
    worker.postMessage({ operation: "append", key, value } satisfies WorkerRequest);
    return this.workerGeneration;
  }

  seal(key: string, expectedGeneration: number): Promise<Uint8Array> {
    const worker = this.getWorker();
    if (this.workerGeneration !== expectedGeneration) {
      return Promise.reject(new Error("Tick delta worker restarted before chunk seal"));
    }
    return this.run(worker, { operation: "seal", key });
  }

  decompress(value: Uint8Array): Promise<TickDeltaRecord[]> {
    const worker = this.getWorker();
    return this.run(worker, { operation: "decompress", value }).then((result) => {
      if (!Array.isArray(result)) throw new Error("Invalid decompression response");
      return result as TickDeltaRecord[];
    });
  }

  private run(worker: Worker, request: { operation: "seal"; key: string }): Promise<Uint8Array>;
  private run(worker: Worker, request: { operation: "decompress"; value: Uint8Array }): Promise<TickDeltaRecord[]>;
  private run(worker: Worker, request: WorkerJobRequest): Promise<Uint8Array | TickDeltaRecord[]> {
    const id = this.nextJobId++;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      worker.ref();
      worker.postMessage({ ...request, id });
    });
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    this.workerGeneration++;
    worker.unref();
    worker.on("message", (response: WorkerResponse) => {
      const job = this.jobs.get(response.id);
      if (!job) return;
      this.jobs.delete(response.id);
      if (this.jobs.size === 0) worker.unref();
      if (!response.ok || response.value === undefined) {
        job.reject(new Error(response.error ?? "Tick delta worker failed"));
        return;
      }
      job.resolve(response.value);
    });
    worker.on("error", (error) => this.failWorker(worker, error));
    worker.on("exit", (code) => {
      if (code !== 0) this.failWorker(worker, new Error(`Tick delta worker exited with code ${code}`));
      else if (this.worker === worker) this.worker = null;
    });
    this.worker = worker;
    return worker;
  }

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const job of this.jobs.values()) job.reject(error);
    this.jobs.clear();
    worker.unref();
  }
}

interface ArchivedChunk {
  raw?: TickDeltaRecord[];
  compressed?: Uint8Array;
  ready: Promise<void>;
}

const compressionWorker = new TickDeltaCompressionWorker();
let nextArchiveId = 1;

/**
 * Stores completed recording chunks as gzip while keeping JSON serialization
 * and zlib work off the simulation thread. A raw chunk is retained only if the
 * worker fails, so recording never compromises the match.
 */
export class BackgroundTickDeltaArchive {
  private readonly archiveId = nextArchiveId++;
  private readonly chunks: ArchivedChunk[] = [];
  private activeChunk: TickDeltaRecord[] = [];
  private activeChunkSequence = 0;
  private activeWorkerGeneration: number | null = null;

  constructor(private readonly chunkSize = 100) {}

  append(delta: TickDeltaRecord): void {
    const key = this.activeChunkKey();
    this.activeChunk.push(delta);
    let generation = -1;
    try {
      generation = compressionWorker.append(key, delta);
    } catch {
      // Keep collecting the raw fallback if the worker cannot accept work.
    }
    if (this.activeWorkerGeneration === null) this.activeWorkerGeneration = generation;
    else if (this.activeWorkerGeneration !== generation) this.activeWorkerGeneration = -1;
    if (this.activeChunk.length < this.chunkSize) return;

    const chunk: ArchivedChunk = { raw: this.activeChunk, ready: Promise.resolve() };
    chunk.ready = (generation >= 0 && this.activeWorkerGeneration === generation
      ? compressionWorker.seal(key, generation)
      : Promise.reject(new Error("Tick delta worker changed during chunk")))
      .then((value) => {
        chunk.compressed = value;
        chunk.raw = undefined;
      })
      .catch(() => {
        // Raw fallback is intentional: recording must not interrupt simulation.
      });
    this.chunks.push(chunk);
    this.activeChunk = [];
    this.activeChunkSequence++;
    this.activeWorkerGeneration = null;
  }

  *iterateSync(): Generator<TickDeltaRecord> {
    for (const chunk of this.chunks) {
      const deltas = chunk.raw ?? JSON.parse(
        gunzipSync(Buffer.from(chunk.compressed!)).toString("utf8"),
      ) as TickDeltaRecord[];
      yield* deltas;
    }
    yield* this.activeChunk;
  }

  async getAll(): Promise<TickDeltaRecord[]> {
    await Promise.all(this.chunks.map((chunk) => chunk.ready));
    const chunks = await Promise.all(this.chunks.map(async (chunk) => {
      if (chunk.raw) return chunk.raw;
      return compressionWorker.decompress(chunk.compressed!);
    }));
    return [...chunks.flat(), ...this.activeChunk];
  }

  private activeChunkKey(): string {
    return `${this.archiveId}:${this.activeChunkSequence}`;
  }
}
