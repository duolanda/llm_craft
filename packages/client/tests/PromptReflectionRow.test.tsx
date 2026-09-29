import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServerPromptReflectionStatusMessage } from "@llmcraft/shared";
import { PromptReflectionRow } from "../src/components/PromptReflectionRow";

const noop = () => undefined;
const running: ServerPromptReflectionStatusMessage = {
  type: "prompt_reflection_status", matchId: "match-1", playerId: "player_1",
  status: "running", canCancel: true, message: "连接中断；4 秒后重试（2/3）…",
};
function render(reflection?: ServerPromptReflectionStatusMessage, connected = true) {
  return renderToStaticMarkup(<PromptReflectionRow
    playerId="player_1" reflection={reflection} connected={connected} autoRequested={false}
    onGenerate={noop} onCancel={noop}
  />);
}

test("running reflection shows retry progress and a side-specific cancel action, not generate", () => {
  const html = render(running);
  assert.match(html, /role="status"/);
  assert.match(html, /4 秒后重试（2\/3）/);
  assert.match(html, /aria-label="取消红方策略沉淀"/);
  assert.doesNotMatch(html, /disabled|生成策略/);
});

test("cancelling or saving cannot be cancelled again, and completed reflection has no action", () => {
  for (const reflection of [{ ...running, canCancel: false }, { ...running, status: "completed" as const }]) {
    assert.doesNotMatch(render(reflection), /<button/);
  }
});

test("cancelled and failed reflections can retry; a new reflection can generate", () => {
  for (const status of ["cancelled", "failed"] as const) {
    const html = render({ ...running, status, canCancel: false });
    assert.match(html, /aria-label="重试红方策略沉淀"/);
    assert.doesNotMatch(html, /aria-label="取消/);
  }
  assert.match(render(), /生成策略/);
});

test("all available actions are disabled while disconnected", () => {
  for (const reflection of [undefined, running, { ...running, status: "cancelled" as const }]) {
    assert.match(render(reflection, false).match(/<button[^>]*>/)?.[0] ?? "", /disabled=""/);
  }
});
