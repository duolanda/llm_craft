import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StrategyPrompt } from "@llmcraft/shared";
import { PromptPanel } from "../src/components/PromptPanel";
import { PromptSelector } from "../src/components/PromptSelector";
import { formatPromptVersionDate } from "../src/lib/promptPresentation";
import { PromptVersionOrigin } from "../src/components/PromptVersionOrigin";

const prompt: StrategyPrompt = {
  id: "44993e07-test",
  name: "稳健装甲推进",
  activeVersionId: "version-2",
  createdAt: "2026-09-05T02:32:46.486Z",
  updatedAt: "2026-09-05T08:57:30.443Z",
  versions: [
    { id: "version-1", version: 1, content: "first strategy", source: "reflection", createdAt: "2026-09-05T02:32:46.486Z" },
    { id: "version-2", version: 2, content: "current strategy", source: "reflection", basedOnVersionId: "version-1", createdAt: "2026-09-05T08:55:44.435Z" },
  ],
};
const other: StrategyPrompt = { ...prompt, id: "another-prompt", name: "另一份策略" };
const noop = () => undefined;

test("strategy titles are used directly without appending an id or timestamp", () => {
  const before = structuredClone(prompt);
  for (const item of [prompt, { ...prompt, id: "231dc2cf-test" }]) {
    const html = renderToStaticMarkup(<PromptSelector side="red" value={item.id} prompts={[item]} disabled={false} onChange={noop} onView={noop} />);
    assert.match(html, />稳健装甲推进 · 当前使用 v2<\/option>/);
  }
  assert.deepEqual(prompt, before);
});

test("custom names, including dates and model names, are not shortened", () => {
  for (const name of ["快速装甲推进", "2026/09/05 经济试验", "mimo-v2.5 的进攻策略", "红方 AI 复盘 · 自定义名称"]) {
    const html = renderToStaticMarkup(<PromptSelector side="red" value={prompt.id} prompts={[{ ...prompt, name }]} disabled={false} onChange={noop} onView={noop} />);
    assert.ok(html.includes(`>${name} · 当前使用 v2</option>`));
  }
});

test("version time uses the local 24-hour clock without a visible timezone suffix", () => {
  const date = prompt.versions[1]!.createdAt;
  assert.equal(formatPromptVersionDate(date, "Asia/Shanghai"), "2026/09/05 16:55");
  assert.equal(formatPromptVersionDate(date, "UTC"), "2026/09/05 08:55");
  assert.equal(formatPromptVersionDate(date, "America/Los_Angeles"), "2026/09/05 01:55");
  assert.equal(formatPromptVersionDate("2026-09-04T16:00:00Z", "Asia/Shanghai"), "2026/09/05 00:00");
  assert.equal(formatPromptVersionDate("not-a-date"), "时间未知");
});

test("selection shows the active version, not the newest unused reflection", () => {
  const withCandidate = { ...prompt, versions: [...prompt.versions, { ...prompt.versions[1]!, id: "version-3", version: 3 }] };
  const html = renderToStaticMarkup(<PromptSelector side="red" value={prompt.id} prompts={[withCandidate]} disabled={false} onChange={noop} onView={noop} />);
  assert.match(html, /稳健装甲推进 · 当前使用 v2/);
  assert.doesNotMatch(html, /2026\/09\/05|mimo-v2.5|v3/);
  assert.match(html, /value="44993e07-test" selected=""/);
});

test("a locked match shows its frozen version and can still open that strategy", () => {
  const html = renderToStaticMarkup(<PromptSelector
    side="red" value={prompt.id} prompts={[prompt]} disabled
    frozenPrompt={{ promptId: prompt.id, promptName: prompt.name, versionId: "version-1", version: 1 }}
    onChange={noop} onView={noop}
  />);
  assert.match(html, /本局固定 v1/);
  assert.match(html, /<select[^>]*disabled=""/);
  assert.doesNotMatch(html.match(/<button[^>]*>/)?.[0] ?? "", /disabled/);
});

test("default and missing strategies cannot open an unrelated library item", () => {
  for (const value of ["", "missing"]) {
    const html = renderToStaticMarkup(<PromptSelector side="blue" value={value} prompts={[prompt]} disabled={false} onChange={noop} onView={noop} />);
    assert.match(html, /不使用自定义策略/);
    assert.match(html.match(/<button[^>]*>/)?.[0] ?? "", /disabled=""/);
  }
});

const panelActions = {
  onRefresh: noop,
  onCreate: async () => prompt,
  onUpdate: async () => prompt,
  onActivateVersion: async () => prompt,
  onDelete: async () => undefined,
};

test("library opens the requested strategy even when it is not first in the list", () => {
  const html = renderToStaticMarkup(<PromptPanel
    prompts={[other, prompt]} initialSelection={{ promptId: prompt.id, versionId: "version-2" }}
    loading={false} error={null} {...panelActions}
  />);
  assert.match(html, /value="44993e07-test" selected=""/);
  assert.match(html, /value="稳健装甲推进"/);
  assert.match(html, /datetime="2026-09-05T08:55:44.435Z"/i);
  assert.match(html, /datetime="2026-09-05T02:32:46.486Z"/i);
  assert.doesNotMatch(html, /待采用|用户保存/);
  assert.match(html, /其他版本/);
  assert.match(html, /当前版本内容 · v2/);
});

test("library distinguishes the match's frozen revision from its current editable version", () => {
  const html = renderToStaticMarkup(<PromptPanel
    prompts={[prompt]} initialSelection={{ promptId: prompt.id, versionId: "version-1" }}
    loading={false} error={null} {...panelActions}
  />);
  assert.match(html, /对局配置使用 v1；策略库当前使用 v2/);
  assert.match(html, /<details[^>]*open=""/);
  assert.match(html, /<textarea[^>]*>current strategy<\/textarea>/);
});

test("edited versions identify their originating AI and link the exact replay without leaving the editor", () => {
  const html = renderToStaticMarkup(<PromptVersionOrigin version={{ ...prompt.versions[1]!, source: "user" }} loading={false} provenance={{
    sourceVersionId: "version-1", sourceVersion: 1, model: "original-model", playerId: "player_2",
    recordFileName: "match-source-file.match.json",
  }} />);
  assert.match(html, /基于 v1 编辑/);
  assert.match(html, /原复盘模型：original-model/);
  assert.match(html, /蓝方/);
  assert.match(html, /href="\/\?replay=match-source-file.match.json"/);
  assert.match(html, /target="_blank"/);
});

test("missing recordings and unknown models are explicit, without inventing an origin", () => {
  const html = renderToStaticMarkup(<PromptVersionOrigin version={{ ...prompt.versions[1]!, matchId: "match-missing" }} loading={false} />);
  assert.match(html, /生成模型：未记录/);
  assert.match(html, /未找到录像/);
  assert.doesNotMatch(html, /href=/);
});

test("a failed provenance request is not confused with a missing recording", () => {
  const html = renderToStaticMarkup(<PromptVersionOrigin version={{ ...prompt.versions[1]!, matchId: "match-missing" }} loading={false} unavailable />);
  assert.match(html, /暂时无法加载/);
  assert.doesNotMatch(html, /未找到录像|未记录/);
});
