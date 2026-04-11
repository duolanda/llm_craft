import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PresetStore } from "../PresetStore";

const tempDirs: string[] = [];

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-presets-"));
  tempDirs.push(dir);
  return new PresetStore({
    filePath: path.join(dir, "llm-presets.json"),
    encryptionSecret: "0123456789abcdef0123456789abcdef",
  });
}

describe("PresetStore", () => {
  it("stores api keys encrypted at rest", async () => {
    const store = await createStore();

    await store.create({
      name: "Preset A",
      providerType: "openai-compatible",
      baseURL: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      apiKey: "plain-secret-token",
    });

    const raw = await fs.readFile((store as any).filePath, "utf8");
    expect(raw).not.toContain("plain-secret-token");
  });

  it("keeps the previous api key when update apiKey is omitted", async () => {
    const store = await createStore();
    const created = await store.create({
      name: "Preset A",
      providerType: "openai-compatible",
      baseURL: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      apiKey: "plain-secret-token",
    });

    await store.update(created.id, {
      name: "Preset B",
      providerType: "openai-compatible",
      baseURL: "https://api.example.com/v2",
      model: "gpt-4.1-mini",
    });

    const runtime = await store.getRuntimeConfig(created.id);
    expect(runtime.apiKey).toBe("plain-secret-token");
    expect(runtime.model).toBe("gpt-4.1-mini");
  });

  it("serializes concurrent writes so two overlapping creates are both preserved", async () => {
    const store = await createStore();
    const originalReadAll = (store as any).readAll.bind(store) as () => Promise<unknown[]>;
    const gate = createDeferred<void>();
    let gatedReads = 0;

    vi.spyOn(store as any, "readAll").mockImplementation(async () => {
      gatedReads += 1;
      if (gatedReads === 1) {
        await gate.promise;
      }
      return originalReadAll();
    });

    const firstCreate = store.create({
      name: "Preset A",
      providerType: "openai-compatible",
      baseURL: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      apiKey: "token-a",
    });
    const secondCreate = store.create({
      name: "Preset B",
      providerType: "openai-compatible",
      baseURL: "https://api.example.com/v2",
      model: "gpt-4.1-mini",
      apiKey: "token-b",
    });

    await Promise.resolve();
    gate.resolve();
    await Promise.all([firstCreate, secondCreate]);

    const presets = await store.list();
    expect(presets).toHaveLength(2);
    expect(presets.map((preset) => preset.name).sort()).toEqual(["Preset A", "Preset B"]);
  });

  it("fails fast when the encryption secret is blank", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-presets-"));
    tempDirs.push(dir);

    expect(() => new PresetStore({
      filePath: path.join(dir, "llm-presets.json"),
      encryptionSecret: "   ",
    })).toThrowError("PRESET_ENCRYPTION_SECRET_REQUIRED");
  });

  it("waits for an in-flight write before serving reads", async () => {
    const store = await createStore();
    await store.create({
      name: "Preset A",
      providerType: "openai-compatible",
      baseURL: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      apiKey: "token-a",
    });

    const originalWriteAll = (store as any).writeAll.bind(store) as (presets: unknown[]) => Promise<void>;
    const gate = createDeferred<void>();
    let writeCount = 0;

    vi.spyOn(store as any, "writeAll").mockImplementation(async (...args: unknown[]) => {
      writeCount += 1;
      if (writeCount === 2) {
        await gate.promise;
      }
      const [presets] = args as [unknown[]];
      await originalWriteAll(presets);
    });

    const createPromise = store.create({
      name: "Preset B",
      providerType: "openai-compatible",
      baseURL: "https://api.example.com/v2",
      model: "gpt-4.1-mini",
      apiKey: "token-b",
    });

    await Promise.resolve();

    let readResolved = false;
    const listPromise = store.list().then((presets) => {
      readResolved = true;
      return presets;
    });

    await Promise.resolve();
    expect(readResolved).toBe(false);

    gate.resolve();
    await createPromise;

    const presets = await listPromise;
    expect(readResolved).toBe(true);
    expect(presets).toHaveLength(2);
    expect(presets.map((preset) => preset.name).sort()).toEqual(["Preset A", "Preset B"]);
  });

  it("keeps the previous store file readable when replacing the file fails", async () => {
    const store = await createStore();
    const created = await store.create({
      name: "Preset A",
      providerType: "openai-compatible",
      baseURL: "https://api.example.com/v1",
      model: "gpt-4o-mini",
      apiKey: "token-a",
    });

    const renameSpy = vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));

    await expect(
      store.update(created.id, {
        name: "Preset B",
        providerType: "openai-compatible",
        baseURL: "https://api.example.com/v2",
        model: "gpt-4.1-mini",
      })
    ).rejects.toThrow("rename failed");

    renameSpy.mockRestore();

    const presets = await store.list();
    expect(presets).toHaveLength(1);
    expect(presets[0]?.name).toBe("Preset A");

    const runtime = await store.getRuntimeConfig(created.id);
    expect(runtime.model).toBe("gpt-4o-mini");
    expect(runtime.apiKey).toBe("token-a");
  });
});
