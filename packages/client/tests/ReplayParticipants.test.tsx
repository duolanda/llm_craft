import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GameRecord, GameState } from "@llmcraft/shared";
import { StatsPanel } from "../src/components/StatsPanel";

type RecordedPlayers = GameRecord["metadata"]["players"];

const state: GameState = {
  tick: 0, tiles: [], logs: [], winner: null,
  players: [
    { id: "player_1", units: [], buildings: [], resources: { credits: 800 } },
    { id: "player_2", units: [], buildings: [], resources: { credits: 800 } },
  ],
};

function renderReplay(players?: RecordedPlayers) {
  return renderToStaticMarkup(<StatsPanel state={state} recordedPlayers={players ?? []} />);
}

test("replay models are associated by player id even when metadata lists blue first", () => {
  const players: RecordedPlayers = [
    { playerId: "player_2", model: "blue-model", baseURL: "https://private-provider.example/v1" },
    { playerId: "player_1", model: "red-model" },
  ];
  const before = structuredClone(players);
  const html = renderReplay(players);
  assert.match(html, /title="red-model" aria-label="红方对战模型">red-model<\/div>/);
  assert.match(html, /title="blue-model" aria-label="蓝方对战模型">blue-model<\/div>/);
  assert.doesNotMatch(html, /private-provider/);
  assert.deepEqual(players, before);
});

test("missing or legacy model metadata remains explicitly unknown for each side", () => {
  for (const players of [
    undefined,
    [],
    [{ playerId: "player_1", model: "legacy-record" }, { playerId: "player_2", model: "unknown" }],
    [{ playerId: "player_1", model: "  " }],
  ] satisfies Array<RecordedPlayers | undefined>) {
    const html = renderReplay(players);
    assert.equal(html.match(/title="模型未记录"/g)?.length, 2);
  }
});

test("a missing opponent does not inherit the other player's model", () => {
  const html = renderReplay([{ playerId: "player_2", model: "blue-model" }]);
  assert.match(html, /aria-label="红方对战模型">模型未记录<\/div>/);
  assert.match(html, /aria-label="蓝方对战模型">blue-model<\/div>/);
});

test("long model ids and recorded controller names retain their full text and hover title", () => {
  const model = "provider/a-very-long-model-name-with-version-and-reasoning";
  const html = renderReplay([
    { playerId: "player_1", model },
    { playerId: "player_2", model: "builtin-cpu:rush" },
  ]);
  assert.ok(html.includes(`title="${model}"`));
  assert.ok(html.includes(`>${model}</div>`));
  assert.match(html, /title="builtin-cpu:rush"/);
});
