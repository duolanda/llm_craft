import { describe, expect, it } from "vitest";
import type { TickDeltaRecord } from "@llmcraft/shared";
import { BackgroundTickDeltaArchive } from "../BackgroundTickDeltaArchive";

function delta(tick: number): TickDeltaRecord {
  return {
    tick,
    players: [],
    newLogs: [],
    aiOutputs: {},
  };
}

describe("BackgroundTickDeltaArchive", () => {
  it("round-trips ordered gzip chunks through the worker", async () => {
    const archive = new BackgroundTickDeltaArchive(2);
    archive.append(delta(1));
    archive.append(delta(2));
    archive.append(delta(3));

    await expect(archive.getAll()).resolves.toEqual([delta(1), delta(2), delta(3)]);
  });

  it("keeps a synchronous compatibility view while compression is pending or complete", async () => {
    const archive = new BackgroundTickDeltaArchive(2);
    archive.append(delta(4));
    archive.append(delta(5));

    expect(Array.from(archive.iterateSync())).toEqual([delta(4), delta(5)]);
    await archive.getAll();
    expect(Array.from(archive.iterateSync())).toEqual([delta(4), delta(5)]);
  });
});
