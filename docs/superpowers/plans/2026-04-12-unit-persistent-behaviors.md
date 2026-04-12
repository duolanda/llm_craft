# Unit Persistent Behaviors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `attackMoveTo` and `harvestLoop` so units can keep executing high-level intent across ticks.

**Architecture:** Extend the shared intent shape and sandbox command surface, then let `Game` resolve two new persistent intents each tick by reusing existing pathfinding, attack, and worker economy systems. Keep phase 1 flat and unit-level: no squad abstraction and no intent stacking.

**Tech Stack:** TypeScript, Vitest, Node.js, monorepo shared/server packages

---

### Task 1: Shared Contracts

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `docs/ai-api-contract.md`

- [ ] Add `attack_move` and `harvest_loop` to unit intent shapes and document the new AI API methods.

### Task 2: Sandbox Command Surface

**Files:**
- Modify: `packages/server/src/APIBridge.ts`
- Modify: `packages/server/src/AISandboxWorker.cjs`
- Modify: `packages/server/src/__tests__/AISandbox.test.ts`
- Modify: `packages/server/src/SystemPrompt.ts`

- [ ] Expose `unit.attackMoveTo()` and `unit.harvestLoop()` in both runtime bridges.
- [ ] Add sandbox tests that assert the emitted command payloads are plain serializable objects.
- [ ] Update prompt guidance so the model prefers these higher-level behaviors where appropriate.

### Task 3: Persistent Game Intents

**Files:**
- Modify: `packages/server/src/Game.ts`
- Modify: `packages/server/src/__tests__/Game.test.ts`

- [ ] Accept `attack_move` and `harvest_loop` commands in `processCommand()`.
- [ ] Add per-tick processors for harvest loop and attack-move.
- [ ] Preserve simple override rules: later commands replace previous intent.
- [ ] Add game tests for sustained movement/combat and sustained harvesting/delivery.

### Task 4: Reality Docs

**Files:**
- Modify: `docs/current-mvp-reality.md`

- [ ] Document the new high-level APIs and explain that they are sustained by game-side tick logic rather than repeated LLM micromanagement.

### Task 5: Verification

**Files:**
- Modify: none

- [ ] Run targeted tests for `AISandbox.test.ts` and `Game.test.ts`.
- [ ] Run type-aware verification if needed.
