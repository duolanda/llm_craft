import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { Game } from "../Game";
import { PLAYER_IDS } from "@llmcraft/shared";
import {
  createPresetStore,
  createServerState,
  handleHttpRequest,
} from "../index";
import { ControlPlaneMatch } from "../control/ControlPlaneMatch";

function createRequest({
  method,
  url,
  body,
}: {
  method: string;
  url: string;
  body?: string;
}) {
  const req = Object.assign([], {
    method,
    url,
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) {
        yield Buffer.from(body);
      }
    },
  });

  return req as unknown as http.IncomingMessage;
}

function createResponseCapture() {
  let statusCode = 200;
  let payload = "";

  const res = {
    setHeader() {
      return res;
    },
    writeHead(nextStatusCode: number) {
      statusCode = nextStatusCode;
      return res;
    },
    end(chunk?: string) {
      payload = chunk ?? "";
      return res;
    },
  };

  return {
    res: res as unknown as http.ServerResponse,
    get statusCode() {
      return statusCode;
    },
    get payload() {
      return payload;
    },
    json<T = Record<string, unknown>>(): T {
      return JSON.parse(payload) as T;
    },
  };
}

async function request(
  state: ReturnType<typeof createServerState>,
  input: { method: string; url: string; body?: string },
) {
  const capture = createResponseCapture();
  await handleHttpRequest(createRequest(input), capture.res, state);
  return capture;
}

describe("control plane HTTP routes", () => {
  it("previews storage cleanup unless apply=true is explicit", async () => {
    const state = createServerState(createPresetStore());
    const inspect = vi.fn(async ({ apply = false }: { apply?: boolean } = {}) => ({
      generatedAt: "2026-07-16T00:00:00.000Z",
      applied: apply,
      groups: [],
      deleteCount: 2,
      deleteBytes: 128,
      failures: [],
    }));
    state.artifactRetention = { inspect } as any;

    const preview = await request(state, {
      method: "POST",
      url: "/api/control/storage/cleanup",
      body: "{}",
    });
    const applied = await request(state, {
      method: "POST",
      url: "/api/control/storage/cleanup",
      body: JSON.stringify({ apply: true }),
    });

    expect(preview.json()).toMatchObject({ applied: false, deleteCount: 2 });
    expect(applied.json()).toMatchObject({ applied: true, deleteCount: 2 });
    expect(inspect).toHaveBeenNthCalledWith(1, { apply: false });
    expect(inspect).toHaveBeenNthCalledWith(2, { apply: true });
  });

  it("returns 400 for malformed JSON when creating a control session", async () => {
    const state = createServerState(createPresetStore());

    const response = await request(state, {
      method: "POST",
      url: "/api/control/sessions",
      body: "{bad-json",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "请求体 JSON 格式错误。",
    });
  });

  it("creates multiple control matches with stable identities", async () => {
    const state = createServerState(createPresetStore());

    const first = await request(state, {
      method: "POST",
      url: "/api/control/start-game",
      body: "{}",
    });
    const second = await request(state, {
      method: "POST",
      url: "/api/control/start-game",
      body: "{}",
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const firstMatchId = first.json<{ data: { matchId: string } }>().data.matchId;
    const secondMatchId = second.json<{ data: { matchId: string } }>().data.matchId;
    expect(secondMatchId).not.toBe(firstMatchId);
    expect(state.matchRegistry.list()).toHaveLength(2);
    expect(state.matchRegistry.getObservedMatchId()).toBe(secondMatchId);
  });

  it("binds a control session to the requested match instead of a global singleton", async () => {
    const state = createServerState(createPresetStore());

    const first = await request(state, {
      method: "POST",
      url: "/api/control/start-game",
      body: "{}",
    });
    expect(first.statusCode).toBe(201);

    const next = await request(state, {
      method: "POST",
      url: "/api/control/start-game",
      body: "{}",
    });
    expect(next.statusCode).toBe(201);
    const firstMatchId = first.json<{ data: { matchId: string } }>().data.matchId;
    const session = await request(state, {
      method: "POST",
      url: "/api/control/sessions",
      body: JSON.stringify({ playerId: PLAYER_IDS.PLAYER_1, gameId: firstMatchId }),
    });

    expect(session.statusCode).toBe(201);
    expect(session.json()).toMatchObject({ data: { gameId: firstMatchId } });
    expect(state.matchRegistry.getObservedMatchId()).toBe(
      next.json<{ data: { matchId: string } }>().data.matchId,
    );
  });

  it("lists, observes, saves, and stops a match through registry routes", async () => {
    const state = createServerState(createPresetStore());
    const game = new Game();
    const stop = vi.fn(() => game.stop());
    const saveRecord = vi.fn(async () => "/tmp/match_registry_api.trace.json");
    state.matchRegistry.register({
      getMatchId: () => "match_registry_api",
      getGame: () => game,
      stop,
      saveRecord,
    }, { kind: "live" });

    const list = await request(state, { method: "GET", url: "/api/control/matches" });
    const observe = await request(state, {
      method: "POST",
      url: "/api/control/matches/match_registry_api/observe",
    });
    const save = await request(state, {
      method: "POST",
      url: "/api/control/matches/match_registry_api/save-record",
    });
    const stopResponse = await request(state, {
      method: "POST",
      url: "/api/control/matches/match_registry_api/stop",
    });

    expect(list.json()).toMatchObject({
      observedMatchId: "match_registry_api",
      matches: [expect.objectContaining({ matchId: "match_registry_api", kind: "live" })],
    });
    expect(observe.statusCode).toBe(200);
    expect(save.json()).toMatchObject({ filePath: "/tmp/match_registry_api.trace.json" });
    expect(stopResponse.statusCode).toBe(200);
    expect(saveRecord).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("accepts one HTTP action batch and records one multi-command envelope", async () => {
    const state = createServerState(createPresetStore());
    const started = await request(state, {
      method: "POST",
      url: "/api/control/start-game",
      body: "{}",
    });
    const matchId = started.json<{ data: { matchId: string } }>().data.matchId;
    const player1 = await request(state, {
      method: "POST",
      url: "/api/control/sessions",
      body: JSON.stringify({ playerId: PLAYER_IDS.PLAYER_1, gameId: matchId }),
    });
    await request(state, {
      method: "POST",
      url: "/api/control/sessions",
      body: JSON.stringify({ playerId: PLAYER_IDS.PLAYER_2, gameId: matchId }),
    });
    const sessionId = player1.json<{ data: { sessionId: string } }>().data.sessionId;
    const match = state.matchRegistry.require(matchId).handle as ControlPlaneMatch;
    const workers = match.getGame().getState().players[0]!.units.filter((unit) => unit.type === "worker");

    const response = await request(state, {
      method: "POST",
      url: `/api/control/sessions/${sessionId}/actions`,
      body: JSON.stringify({
        clientRequestId: "http_atomic_batch",
        actions: workers.slice(0, 2).map((worker) => ({
          tool: "hold_unit",
          args: { unitId: worker.id },
        })),
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      kind: "batch_result",
      data: { clientRequestId: "http_atomic_batch", duplicate: false },
    });
    const submissions = [];
    for await (const submission of match.getMatchRuntime().getJournal().readCommandSubmissions()) {
      submissions.push(submission);
    }
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      envelope: { clientRequestId: "http_atomic_batch", commands: [{ type: "hold" }, { type: "hold" }] },
    });
    match.stop();
  });
});
