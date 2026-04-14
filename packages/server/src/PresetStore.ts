import {
  CreateLLMPresetRequest,
  LLMPresetSummary,
  OpenAICompatibleRuntimeConfig,
  UpdateLLMPresetRequest,
} from "@llmcraft/shared";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { decryptString, encryptString } from "./crypto";

interface StoredPresetRecord {
  id: string;
  name: string;
  providerType: CreateLLMPresetRequest["providerType"];
  baseURL: string;
  model: string;
  rpm?: number | null;
  apiKeyEncrypted: string;
  createdAt: string;
  updatedAt: string;
}

export class PresetStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: { filePath: string; encryptionSecret: string }) {
    if (!options.encryptionSecret.trim()) {
      throw new Error("PRESET_ENCRYPTION_SECRET_REQUIRED");
    }
  }

  get filePath(): string {
    return this.options.filePath;
  }

  async list(): Promise<LLMPresetSummary[]> {
    return this.withLock(async () => {
      const presets = await this.readAll();
      return presets.map((preset) => this.toSummary(preset));
    });
  }

  async create(input: CreateLLMPresetRequest): Promise<LLMPresetSummary> {
    return this.withLock(async () => {
      const presets = await this.readAll();
      const now = new Date().toISOString();
      const preset: StoredPresetRecord = {
        id: randomUUID(),
        name: input.name,
        providerType: input.providerType,
        baseURL: input.baseURL,
        model: input.model,
        rpm: input.rpm ?? null,
        apiKeyEncrypted: encryptString(input.apiKey, this.options.encryptionSecret),
        createdAt: now,
        updatedAt: now,
      };

      presets.push(preset);
      await this.writeAll(presets);
      return this.toSummary(preset);
    });
  }

  async update(id: string, input: UpdateLLMPresetRequest): Promise<LLMPresetSummary> {
    return this.withLock(async () => {
      const presets = await this.readAll();
      const preset = presets.find((item) => item.id === id);
      if (!preset) {
        throw new Error("PRESET_NOT_FOUND");
      }

      preset.name = input.name;
      preset.providerType = input.providerType;
      preset.baseURL = input.baseURL;
      preset.model = input.model;
      preset.rpm = input.rpm ?? null;
      if (input.apiKey?.trim()) {
        preset.apiKeyEncrypted = encryptString(input.apiKey, this.options.encryptionSecret);
      }
      preset.updatedAt = new Date().toISOString();

      await this.writeAll(presets);
      return this.toSummary(preset);
    });
  }

  async delete(id: string): Promise<void> {
    await this.withLock(async () => {
      const presets = await this.readAll();
      const next = presets.filter((preset) => preset.id !== id);
      if (next.length === presets.length) {
        throw new Error("PRESET_NOT_FOUND");
      }

      await this.writeAll(next);
    });
  }

  async getRuntimeConfig(id: string): Promise<OpenAICompatibleRuntimeConfig> {
    return this.withLock(async () => {
      const presets = await this.readAll();
      const preset = presets.find((item) => item.id === id);
      if (!preset) {
        throw new Error("PRESET_NOT_FOUND");
      }

      let apiKey: string;
      try {
        apiKey = decryptString(preset.apiKeyEncrypted, this.options.encryptionSecret);
      } catch {
        throw new Error("PRESET_DECRYPT_FAILED");
      }

      return {
        providerType: "openai-compatible",
        apiKey,
        baseURL: preset.baseURL,
        model: preset.model,
        rpm: preset.rpm ?? null,
      };
    });
  }

  private async readAll(): Promise<StoredPresetRecord[]> {
    try {
      const content = await fs.readFile(this.options.filePath, "utf8");
      return JSON.parse(content) as StoredPresetRecord[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async writeAll(presets: StoredPresetRecord[]): Promise<void> {
    const directory = path.dirname(this.options.filePath);
    const tempFilePath = path.join(directory, `${path.basename(this.options.filePath)}.${randomUUID()}.tmp`);
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(tempFilePath, JSON.stringify(presets, null, 2), "utf8");
      await fs.rename(tempFilePath, this.options.filePath);
    } finally {
      await fs.rm(tempFilePath, { force: true }).catch(() => undefined);
    }
  }

  private toSummary(preset: StoredPresetRecord): LLMPresetSummary {
    return {
      id: preset.id,
      name: preset.name,
      providerType: "openai-compatible",
      baseURL: preset.baseURL,
      model: preset.model,
      rpm: preset.rpm ?? null,
      hasApiKey: Boolean(preset.apiKeyEncrypted),
      createdAt: preset.createdAt,
      updatedAt: preset.updatedAt,
    };
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
