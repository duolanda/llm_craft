import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ServerStateMessage } from "@llmcraft/shared";
import { Game } from "../Game";
import { PresetStore } from "../PresetStore";
import { createServer, createServerState } from "../index";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function createFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llmcraft-end-notification-"));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const state = createServerState(new PresetStore({ filePath: path.join(dir, "presets.json"), encryptionSecret: "record-notification-test-secret" }));
  state.liveEnabled = false;
  const game = new Game();
  const filePath = path.join(dir, "finished.match.zst");
  let finishSave!: (value: string) => void;
  const saveRecord = vi.fn(() => new Promise<string>((resolve) => { finishSave = resolve; }));
  state.matchRegistry.register({
    getMatchId: () => "match_control_end",
    getGame: () => game,
    getMatchStatus: () => "finished",
    stop: () => game.stop(),
    saveRecord,
  }, { kind: "control", observe: true });
  const { server, wss } = createServer(state);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    for (const client of wss.clients) client.terminate();
    await Promise.all([
      new Promise<void>((resolve) => wss.close(() => resolve())),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ]);
  });
  const port = (server.address() as { port: number }).port;

  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: ServerStateMessage[] = [];
    const waiters = new Set<() => void>();
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "state") {
        messages.push(message);
        for (const wake of waiters) wake();
      }
    });
    await once(ws, "open");
    const waitFor = (predicate: (message: ServerStateMessage) => boolean): Promise<ServerStateMessage> => {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { waiters.delete(wake); reject(new Error("Missing record-save state notification")); }, 3_000);
        const wake = () => {
          const result = messages.find(predicate);
          if (result) { clearTimeout(timeout); waiters.delete(wake); resolve(result); }
        };
        waiters.add(wake);
      });
    };
    return { ws, messages, waitFor };
  }
  return { state, game, filePath, saveRecord, finishSave: () => finishSave(filePath), connect };
}

describe("match end record notification", () => {
  it("pushes asynchronous save progress without another tick and restores it on reconnect", async () => {
    const fixture = await createFixture();
    const client = await fixture.connect();
    const initial = await client.waitFor((message) => message.observedMatch?.recordSave.status === "idle");
    const saving = await client.waitFor((message) => message.observedMatch?.recordSave.status === "saving");
    fixture.finishSave();
    const saved = await client.waitFor((message) => message.observedMatch?.recordSave.status === "saved");
    expect(saved.observedMatch).toMatchObject({ matchId: "match_control_end", kind: "control", recordSave: { status: "saved", filePath: fixture.filePath } });
    expect(saved.frame?.metadata.simulationTick).toBe(initial.frame?.metadata.simulationTick);
    expect(saving.frame?.metadata.simulationTick).toBe(initial.frame?.metadata.simulationTick);

    const reconnected = await fixture.connect();
    const restored = await reconnected.waitFor((message) => message.observedMatch?.recordSave.status === "saved");
    expect(restored.observedMatch?.recordSave).toEqual(saved.observedMatch?.recordSave);
    expect(fixture.saveRecord).toHaveBeenCalledTimes(1);
  });

  it("projects the observed match's save failure without carrying a different match's path", async () => {
    const fixture = await createFixture();
    fixture.saveRecord.mockRejectedValueOnce(new Error("disk full"));
    const client = await fixture.connect();
    const failed = await client.waitFor((message) => message.observedMatch?.recordSave.status === "failed");
    expect(failed.observedMatch?.recordSave).toEqual({ status: "failed", error: "disk full" });

    fixture.state.matchRegistry.register({
      getMatchId: () => "match_other",
      getGame: () => fixture.game,
      getMatchStatus: () => "running",
      stop: vi.fn(),
      saveRecord: vi.fn(),
    }, { kind: "live", observe: true, terminalPolicy: "none" });
    const switched = await client.waitFor((message) => message.observedMatch?.matchId === "match_other");
    expect(switched.observedMatch?.recordSave).toEqual({ status: "disabled" });
  });
});
