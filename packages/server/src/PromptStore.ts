import {
  type CreateStrategyPromptRequest,
  type MatchPromptSelection,
  type MatchPromptSnapshot,
  type PlayerId,
  type StrategyPrompt,
  type StrategyPromptVersion,
  type StrategyPromptVersionSource,
  type UpdateStrategyPromptRequest,
} from "@llmcraft/shared";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const STRATEGY_PROMPT_NAME_MAX_LENGTH = 80;
export const STRATEGY_PROMPT_CONTENT_MAX_LENGTH = 30_000;

export interface ResolvedStrategyPrompt {
  content: string;
  snapshot: MatchPromptSnapshot;
}

interface AddVersionOptions {
  title?: string;
  model?: string;
  content: string;
  source: StrategyPromptVersionSource;
  basedOnVersionId?: string;
  matchId?: string;
  playerId?: PlayerId;
  activate: boolean;
}

interface CreateReflectionPromptOptions {
  name: string;
  content: string;
  matchId: string;
  playerId: PlayerId;
  model?: string;
}

/** Owns named strategy prompts and their immutable revision history. */
export class PromptStore {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: { filePath: string }) {}

  get filePath(): string {
    return this.options.filePath;
  }

  async list(): Promise<StrategyPrompt[]> {
    return this.withLock(async () => {
      const prompts = await this.readAll();
      return structuredClone(prompts).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
  }

  async create(input: CreateStrategyPromptRequest): Promise<StrategyPrompt> {
    return this.withLock(async () => {
      const prompts = await this.readAll();
      const now = new Date().toISOString();
      const name = this.normalizeName(input.name);
      const content = this.normalizeContent(input.content);
      const version: StrategyPromptVersion = {
        id: randomUUID(),
        version: 1,
        content,
        source: "user",
        createdAt: now,
      };
      const prompt: StrategyPrompt = {
        id: randomUUID(),
        name,
        activeVersionId: version.id,
        versions: [version],
        createdAt: now,
        updatedAt: now,
      };
      prompts.push(prompt);
      await this.writeAll(prompts);
      return structuredClone(prompt);
    });
  }

  async createFromReflection(input: CreateReflectionPromptOptions): Promise<StrategyPrompt> {
    return this.withLock(async () => {
      const prompts = await this.readAll();
      const now = new Date().toISOString();
      const version: StrategyPromptVersion = {
        id: randomUUID(),
        version: 1,
        content: this.normalizeContent(input.content),
        title: this.normalizeName(input.name),
        ...(input.model ? { model: input.model } : {}),
        source: "reflection",
        createdAt: now,
        matchId: input.matchId,
        playerId: input.playerId,
      };
      const prompt: StrategyPrompt = {
        id: randomUUID(),
        name: this.normalizeName(input.name),
        activeVersionId: version.id,
        versions: [version],
        createdAt: now,
        updatedAt: now,
      };
      prompts.push(prompt);
      await this.writeAll(prompts);
      return structuredClone(prompt);
    });
  }

  async update(id: string, input: UpdateStrategyPromptRequest): Promise<StrategyPrompt> {
    return this.withLock(async () => {
      const prompts = await this.readAll();
      const prompt = this.requirePrompt(prompts, id);
      const activeVersion = this.requireVersion(prompt, prompt.activeVersionId);
      let changed = false;

      if (input.name !== undefined) {
        const name = this.normalizeName(input.name);
        if (name !== prompt.name) {
          prompt.name = name;
          changed = true;
        }
      }
      if (input.content !== undefined) {
        const content = this.normalizeContent(input.content);
        if (content !== activeVersion.content) {
          const version = this.createVersion(prompt, {
            content,
            source: "user",
            basedOnVersionId: activeVersion.id,
            activate: true,
          });
          prompt.activeVersionId = version.id;
          changed = true;
        }
      }

      if (changed) {
        prompt.updatedAt = new Date().toISOString();
        await this.writeAll(prompts);
      }
      return structuredClone(prompt);
    });
  }

  async addVersion(id: string, options: AddVersionOptions): Promise<StrategyPromptVersion> {
    return this.withLock(async () => {
      const prompts = await this.readAll();
      const prompt = this.requirePrompt(prompts, id);
      if (options.basedOnVersionId) {
        this.requireVersion(prompt, options.basedOnVersionId);
      }
      const version = this.createVersion(prompt, {
        ...options,
        content: this.normalizeContent(options.content),
      });
      if (options.activate) prompt.activeVersionId = version.id;
      prompt.updatedAt = new Date().toISOString();
      await this.writeAll(prompts);
      return structuredClone(version);
    });
  }

  async activateVersion(id: string, versionId: string): Promise<StrategyPrompt> {
    return this.withLock(async () => {
      const prompts = await this.readAll();
      const prompt = this.requirePrompt(prompts, id);
      this.requireVersion(prompt, versionId);
      if (prompt.activeVersionId !== versionId) {
        prompt.activeVersionId = versionId;
        prompt.updatedAt = new Date().toISOString();
        await this.writeAll(prompts);
      }
      return structuredClone(prompt);
    });
  }

  async delete(id: string): Promise<void> {
    await this.withLock(async () => {
      const prompts = await this.readAll();
      const next = prompts.filter((prompt) => prompt.id !== id);
      if (next.length === prompts.length) throw new Error("PROMPT_NOT_FOUND");
      await this.writeAll(next);
    });
  }

  async resolve(selection: MatchPromptSelection): Promise<ResolvedStrategyPrompt> {
    return this.withLock(async () => {
      const prompts = await this.readAll();
      const prompt = this.requirePrompt(prompts, selection.promptId);
      const version = this.requireVersion(prompt, selection.versionId);
      return {
        content: version.content,
        snapshot: {
          promptId: prompt.id,
          promptName: prompt.name,
          versionId: version.id,
          version: version.version,
        },
      };
    });
  }

  private createVersion(prompt: StrategyPrompt, options: AddVersionOptions): StrategyPromptVersion {
    const version: StrategyPromptVersion = {
      id: randomUUID(),
      version: Math.max(0, ...prompt.versions.map((item) => item.version)) + 1,
      content: options.content,
      ...(options.title ? { title: this.normalizeName(options.title) } : {}),
      ...(options.model ? { model: options.model } : {}),
      source: options.source,
      createdAt: new Date().toISOString(),
      ...(options.basedOnVersionId ? { basedOnVersionId: options.basedOnVersionId } : {}),
      ...(options.matchId ? { matchId: options.matchId } : {}),
      ...(options.playerId ? { playerId: options.playerId } : {}),
    };
    prompt.versions.push(version);
    return version;
  }

  private requirePrompt(prompts: StrategyPrompt[], id: string): StrategyPrompt {
    const prompt = prompts.find((item) => item.id === id);
    if (!prompt) throw new Error("PROMPT_NOT_FOUND");
    return prompt;
  }

  private requireVersion(prompt: StrategyPrompt, versionId: string): StrategyPromptVersion {
    const version = prompt.versions.find((item) => item.id === versionId);
    if (!version) throw new Error("PROMPT_VERSION_NOT_FOUND");
    return version;
  }

  private normalizeName(value: string): string {
    const name = value.trim();
    if (!name) throw new Error("策略名称不能为空。");
    if (name.length > STRATEGY_PROMPT_NAME_MAX_LENGTH) {
      throw new Error(`策略名称不能超过 ${STRATEGY_PROMPT_NAME_MAX_LENGTH} 个字符。`);
    }
    return name;
  }

  private normalizeContent(value: string): string {
    const content = value.trim();
    if (!content) throw new Error("Prompt 内容不能为空。");
    if (content.length > STRATEGY_PROMPT_CONTENT_MAX_LENGTH) {
      throw new Error(`Prompt 内容不能超过 ${STRATEGY_PROMPT_CONTENT_MAX_LENGTH} 个字符。`);
    }
    return content;
  }

  private async readAll(): Promise<StrategyPrompt[]> {
    try {
      const content = await fs.readFile(this.options.filePath, "utf8");
      return JSON.parse(content) as StrategyPrompt[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeAll(prompts: StrategyPrompt[]): Promise<void> {
    const directory = path.dirname(this.options.filePath);
    const tempFilePath = path.join(directory, `${path.basename(this.options.filePath)}.${randomUUID()}.tmp`);
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(tempFilePath, JSON.stringify(prompts, null, 2), "utf8");
      await fs.rename(tempFilePath, this.options.filePath);
    } finally {
      await fs.rm(tempFilePath, { force: true }).catch(() => undefined);
    }
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
