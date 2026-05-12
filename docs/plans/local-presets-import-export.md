# Local Presets + Import/Export Implementation Plan

> **For Claude Code:** Implement this plan step by step.

**Goal:** Remove server-side preset storage (API keys never touch the server), store presets in browser localStorage, add import/export as JSON files.

**Architecture:**
- Presets are stored in `localStorage` on the frontend (under key `llmcraft_presets`)
- When starting a match, the **full `MatchPlayerLLMConfig`** (including apiKey) is sent over WebSocket
- Backend removes `PresetStore`, `crypto.ts`, preset HTTP API routes, and all presetId lookups
- Frontend adds import/export buttons to download/upload all presets as a single JSON file

**Tech Stack:** TypeScript, React, Node.js, localStorage API

---

## Phase 1：更新 Shared 类型

### Task 1: 扩展 WebSocket 消息类型，携带完整配置

**Objective:** Change `start`, `prepare`, `reset` WebSocket messages from preset ID lookup to inline config.

**Files:**
- Modify: `packages/shared/src/types.ts` (around lines 7-25 and preset-related types)

**Analysis:**

Currently the WebSocket messages carry `player1PresetId: string` and `player2PresetId: string`. The server uses these to look up the config in PresetStore. We need to change this so the client sends the full `MatchPlayerLLMConfig` inline.

The WebSocket message types are not in a shared type definition — they're typed inline in both frontend and backend. Let's add proper shared types for the client→server messages.

Add to `packages/shared/src/types.ts`:

```typescript
// === WebSocket Client→Server Message Types ===

export interface StartMatchMessage {
  type: "start";
  player1: MatchPlayerLLMConfig;
  player2: MatchPlayerLLMConfig;
  debug?: MatchDebugOptions;
}

export interface PrepareMatchMessage {
  type: "prepare";
  player1: MatchPlayerLLMConfig;
  player2: MatchPlayerLLMConfig;
  debug?: MatchDebugOptions;
  warmup?: { player_1?: boolean; player_2?: boolean };
}

export interface ResetMatchMessage {
  type: "reset";
  player1: MatchPlayerLLMConfig;
  player2: MatchPlayerLLMConfig;
  debug?: MatchDebugOptions;
}

export interface StartBenchmarkMessage {
  type: "start_benchmark";
  player: MatchPlayerLLMConfig;
  cpuStrategy: CPUStrategyType;
  rounds: number;
  recordReplay: boolean;
  decisionIntervalTicks: number;
  debug?: MatchDebugOptions;
}

// Remove preset fields from TestLLMPresetRequest (keep the type, just make it self-contained)
// Currently has: presetId?: string — remove this field
```

**Verification:** `pnpm typecheck` passes after the changes.

### Task 2: Update LLMPresetSummary and related types for client-side use

**Objective:** Make preset types suitable for localStorage (no server-generated IDs).

**Files:**
- Modify: `packages/shared/src/types.ts`

The `LLMPresetSummary` type is currently what the server returns after storing a preset (includes server-generated `id`, `createdAt`, `updatedAt`). We need a client-side equivalent.

Add a `LocalPreset` type:

```typescript
export interface LocalPreset {
  id: string;              // client-generated (crypto.randomUUID())
  name: string;
  providerType: "openai-compatible";
  baseURL: string;
  model: string;
  apiKey: string;          // only in localStorage, never sent to server for storage
  rpm?: number | null;
  reasoningEffort?: OpenAICompatibleReasoningEffort | null;
  extraRequestParams?: Record<string, unknown> | null;
  createdAt: string;       // ISO date
  updatedAt: string;       // ISO date
}
```

---

## Phase 2：前端 localStorage 预设管理

### Task 3: 创建 `localPresets.ts` 工具模块

**Objective:** Pure client-side CRUD for presets in localStorage.

**Files:**
- Create: `packages/client/src/lib/localPresets.ts`

```typescript
const STORAGE_KEY = "llmcraft_presets";

export interface LocalPreset {
  id: string;
  name: string;
  providerType: "openai-compatible";
  baseURL: string;
  model: string;
  apiKey: string;
  rpm?: number | null;
  reasoningEffort?: string | null;
  extraRequestParams?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export function loadPresets(): LocalPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as LocalPreset[];
  } catch {
    return [];
  }
}

export function savePreset(preset: LocalPreset): void {
  const presets = loadPresets();
  const idx = presets.findIndex((p) => p.id === preset.id);
  if (idx >= 0) {
    presets[idx] = { ...preset, updatedAt: new Date().toISOString() };
  } else {
    presets.push({
      ...preset,
      id: preset.id || crypto.randomUUID(),
      createdAt: preset.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

export function deletePreset(id: string): void {
  const presets = loadPresets().filter((p) => p.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

export function exportPresets(): string {
  const presets = loadPresets();
  // Strip apiKey from the export? No — user asked for full export so they can restore.
  // But warn: exporting includes API keys.
  return JSON.stringify(presets, null, 2);
}

export function importPresets(json: string): { imported: number; skipped: number } {
  const incoming = JSON.parse(json) as LocalPreset[];
  if (!Array.isArray(incoming)) throw new Error("无效的预设文件格式");
  
  const existing = loadPresets();
  const existingIds = new Set(existing.map((p) => p.id));
  let imported = 0;
  let skipped = 0;
  
  for (const preset of incoming) {
    if (existingIds.has(preset.id)) {
      // Overwrite existing
      const idx = existing.findIndex((p) => p.id === preset.id);
      existing[idx] = { ...preset, updatedAt: new Date().toISOString() };
      imported++;
    } else {
      existing.push({
        ...preset,
        id: preset.id || crypto.randomUUID(),
        createdAt: preset.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      imported++;
    }
  }
  
  localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
  return { imported, skipped };
}
```

### Task 4: 重构 `SettingsPanel.tsx` 为纯前端

**Objective:** Remove server API calls from SettingsPanel, use localStorage directly.

**Files:**
- Modify: `packages/client/src/components/SettingsPanel.tsx`

Changes:
1. Remove props: `onRefresh`, `onCreate`, `onUpdate`, `onDelete` (server callbacks)
2. Add props: `onPresetsChange: (presets: LocalPreset[]) => void` (notify parent of changes)
3. Internal state reads from `loadPresets()` on mount
4. Create/Update/Delete mutations go through `savePreset()` / `deletePreset()`
5. Add import/export buttons:
   - **Export:** `exportPresets()` → create Blob → trigger `<a download>`
   - **Import:** `<input type="file" accept=".json">` → read file → `importPresets()` → refresh list

**Key UI changes:**
- The "保存到服务器" button becomes "保存到本地"
- No more "测试连接" button (or keep it but call the test endpoint with the full config)
- Add "导出预设" and "导入预设" buttons at bottom of preset list

### Task 5: 重构 `App.tsx` 预-登管理

**Objective:** Remove server preset fetching, use localStorage + send full config over WebSocket.

**Files:**
- Modify: `packages/client/src/App.tsx`
- Remove: `import { createPreset, deletePreset, listPresets, testPreset, updatePreset } from "./lib/settingsApi";`
- Remove: `refreshPresets()` function (replaced by loading from localStorage)
- Remove: `presetError` state (no more API fetch errors)

Changes:
1. Replace `presets` state initialization:
```typescript
const [presets, setPresets] = useState<LLMPresetSummary[]>([]);
// becomes:
const [presets, setPresets] = useState<LocalPreset[]>(() => loadPresets());
```

2. Replace `handleCreatePreset`, `handleUpdatePreset`, `handleDeletePreset`:
```typescript
const handleCreatePreset = async (input: CreateLLMPresetRequest) => {
  // ...call createPreset API...
  await refreshPresets();
};
// becomes:
const handleCreatePreset = (input: CreateLLMPresetRequest) => {
  const newPreset: LocalPreset = {
    id: crypto.randomUUID(),
    name: input.name,
    providerType: "openai-compatible",
    baseURL: input.baseURL,
    model: input.model,
    apiKey: input.apiKey,
    rpm: input.rpm ?? null,
    reasoningEffort: null,
    extraRequestParams: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  savePreset(newPreset);
  setPresets(loadPresets());
};
```

3. Replace `startLiveMatch`, `handleRestart`, `handlePrepare` — send `MatchPlayerLLMConfig` inline:
```typescript
const startLiveMatch = () => {
  if (!player1PresetId || !player2PresetId) return;
  clearServerMessage();
  setPrepareMessage(null);
  setStartPending(true);
  setStartBaselineTick(state?.tick ?? -1);
  setIsPlaying(false);
  
  const p1 = presets.find(p => p.id === player1PresetId);
  const p2 = presets.find(p => p.id === player2PresetId);
  if (!p1 || !p2) return;
  
  send({
    type: "start",
    player1: { providerType: "openai-compatible", apiKey: p1.apiKey, baseURL: p1.baseURL, model: p1.model, rpm: p1.rpm ?? null, reasoningEffort: null, extraRequestParams: null },
    player2: { providerType: "openai-compatible", apiKey: p2.apiKey, baseURL: p2.baseURL, model: p2.model, rpm: p2.rpm ?? null, reasoningEffort: null, extraRequestParams: null },
    debug: buildMatchDebugOptions(recordLLMTranscript),
  });
};
```

4. Similarly for `handleRestart`, `handlePrepare`, and `handleStartBenchmark`.

5. Remove `useEffect` that starts `refreshPresets()`:
```typescript
// Remove:
useEffect(() => {
  void fetchRecordEntries();
  void refreshPresets();
}, []);
// Keep only:
useEffect(() => {
  void fetchRecordEntries();
}, []);
```

6. Update the SettingsPanel props:
```typescriptx
<SettingsPanel
  presets={presets}
  loading={false}        // no more loading from server
  error={null}           // no more preset fetch error
  onRefresh={() => setPresets(loadPresets())}
  onCreate={handleCreatePreset}
  onUpdate={handleUpdatePreset}
  onDelete={handleDeletePreset}
  onTest={handleTestPreset}  // keep this, it calls the test API endpoint
/>
```

7. Update the select options for player presets — currently uses `preset.id` as value and `preset.name` as display. This stays the same since LocalPreset has both fields.

### Task 6: 移除/简化 `settingsApi.ts`

**Objective:** Remove unused API calls.

**Files:**
- Modify: `packages/client/src/lib/settingsApi.ts`

Keep only `testPreset` (for testing a preset without starting a match). Remove `listPresets`, `createPreset`, `updatePreset`, `deletePreset`.

---

## Phase 3：后端移除 Preset 存储

### Task 7: 移除 `crypto.ts`

**Objective:** No longer needed since we don't encrypt API keys.

**Files:**
- Delete: `packages/server/src/crypto.ts`
- Remove any imports of `crypto.ts` in `PresetStore.ts` and `index.ts`

### Task 8: 移除 `PresetStore.ts`

**Objective:** No more preset persistence on server. Remove the entire file.

**Files:**
- Delete: `packages/server/src/PresetStore.ts`
- Remove import and usage from `index.ts`

### Task 9: 移除预设 HTTP API 路由

**Objective:** Remove all preset-related REST endpoints from the server.

**Files:**
- Modify: `packages/server/src/index.ts`

Remove these route handlers:
- `GET /api/presets` (list presets)
- `POST /api/presets` (create preset)
- `PUT /api/presets/:presetId` (update preset)
- `DELETE /api/presets/:presetId` (delete preset)
- `POST /api/presets/test` (test preset)

Remove these functions:
- `resolvePresetSecret()`
- `createPresetStore()`
- `validateCreatePresetRequest()`
- `validateUpdatePresetRequest()`
- `validateTestPresetRequest()`
- `normalizePresetRpm()`
- `normalizeReasoningEffort()`
- `normalizeExtraRequestParams()`
- `parsePresetId()`
- `buildMatchSignature()`
- `getDefaultPresetPaths()`

Remove constants:
- `PRESETS_FILE`
- `BUILTIN_PRESET_SECRET`
- `SERVER_PACKAGE_DIR`

Remove the `test_preset` WebSocket handler.

Change `ServerState` interface: remove `presetStore` field.

### Task 10: 修改 WebSocket handler，接收内联配置

**Objective:** Instead of `message.player1PresetId → presetStore.getRuntimeConfig()`, use `message.player1` directly.

**Files:**
- Modify: `packages/server/src/index.ts`

For `prepare` handler:
```typescript
// Before:
const player1 = await state.presetStore.getRuntimeConfig(message.player1PresetId);
const player2 = await state.presetStore.getRuntimeConfig(message.player2PresetId);

// After:
const player1 = message.player1;  // MatchPlayerLLMConfig
const player2 = message.player2;  // MatchPlayerLLMConfig
```

Similarly for `start`, `reset`, and `start_benchmark` handlers.

For `start_benchmark`:
```typescript
// Before:
const llmConfig = await state.presetStore.getRuntimeConfig(message.presetId);

// After:
const llmConfig = message.player;  // MatchPlayerLLMConfig
```

### Task 11: 移除 data/llm-presets.json

**Objective:** Clean up any existing data file.

**Files:**
- Delete: `packages/server/data/llm-presets.json` (if exists)

### Task 12: 更新 server 测试文件

**Objective:** Tests that reference PresetStore or preset API routes need updating.

**Files:**
- Modify: `packages/server/src/__tests__/serverSettings.test.ts` (if it tests preset API)
- Modify: `packages/server/src/__tests__/PresetStore.test.ts` — delete this file (PresetStore removed)
- Modify: `packages/server/src/__tests__/GameOrchestrator.test.ts` — update to pass inline config instead of presetId

---

## Verification

```bash
# Typecheck
pnpm typecheck

# Run server tests
pnpm test

# Build
pnpm build

# Verify no crypto.ts or PresetStore references remain
rg "PresetStore" packages/
rg "crypto\.ts" packages/
rg "presetStore" packages/
rg "llm-presets" packages/
rg "presetId" packages/server/
```

---

## 回顾

- ✅ API keys no longer stored on server
- ✅ Presets stored in localStorage only
- ✅ Full `MatchPlayerLLMConfig` sent over WebSocket
- ✅ Import/export presets as JSON file
- ✅ No server-side encryption needed
- ✅ `crypto.ts` and `PresetStore.ts` removed
