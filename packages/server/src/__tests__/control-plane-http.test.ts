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
  it("reads each player's join state without joining or changing the observed match", async () => {
    const state = createServerState(createPresetStore());
    const first = new ControlPlaneMatch({ matchId: "match_lobby_first" });
    const second = new ControlPlaneMatch({ matchId: "match_lobby_second" });
    state.matchRegistry.register(first, { kind: "control", observe: true });
    state.matchRegistry.register(second, { kind: "control" });
    const readLobby = () => request(state, {
      method: "GET", url: "/api/control/matches/match_lobby_first/lobby",
    });
    const join = (playerId: string) => request(state, {
      method: "POST", url: "/api/control/sessions",
      body: JSON.stringify({ playerId, gameId: first.getMatchId() }),
    });
    try {
      const empty = await readLobby();
      expect(empty.statusCode).toBe(200);
      expect(empty.json()).toEqual({
        matchId: first.getMatchId(), status: "waiting_for_players",
        ready: { player_1: false, player_2: false },
      });
      await join(PLAYER_IDS.PLAYER_1);
      expect((await readLobby()).json()).toMatchObject({
        status: "waiting_for_players", ready: { player_1: true, player_2: false },
      });
      state.matchRegistry.observe(second.getMatchId());
      await join(PLAYER_IDS.PLAYER_2);
      expect((await readLobby()).json()).toMatchObject({
        status: "running", ready: { player_1: true, player_2: true },
      });
      expect(state.matchRegistry.getObservedMatchId()).toBe(second.getMatchId());
      const other = await request(state, {
        method: "GET", url: "/api/control/matches/match_lobby_second/lobby",
      });
      expect(other.json()).toMatchObject({
        status: "waiting_for_players", ready: { player_1: false, player_2: false },
      });
      first.stop();
      expect((await readLobby()).json()).toMatchObject({ status: "stopped" });
    } finally {
      first.stop();
      second.stop();
    }
  });

  it("rejects lobby reads for unknown and non-control matches", async () => {
    const state = createServerState(createPresetStore());
    const match = new ControlPlaneMatch({ matchId: "match_not_control" });
    state.matchRegistry.register(match, { kind: "live" });
    const unknown = await request(state, {
      method: "GET", url: "/api/control/matches/missing/lobby",
    });
    const nonControl = await request(state, {
      method: "GET", url: "/api/control/matches/match_not_control/lobby",
    });
    expect(unknown.statusCode).toBe(404);
    expect(nonControl.statusCode).toBe(409);
    match.stop();
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

  it("reuses the active control match when play is requested again", async () => {
    const state = createServerState(createPresetStore());

    const first = await request(state, {
      method: "POST",
      url: "/api/control/start-game",
      body: JSON.stringify({ cpu: "rush" }),
    });
    const second = await request(state, {
      method: "POST",
      url: "/api/control/start-game",
      body: JSON.stringify({ cpu: "rush" }),
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    const firstPayload = first.json<{ data: { matchId: string; decisionIntervalTicks: number } }>();
    const firstMatchId = firstPayload.data.matchId;
    expect(firstPayload.data.decisionIntervalTicks).toBe(10);
    expect(second.json()).toMatchObject({
      data: { matchId: firstMatchId, reused: true, decisionIntervalTicks: 10 },
    });
    expect(state.matchRegistry.list()).toHaveLength(1);
    expect(state.matchRegistry.getObservedMatchId()).toBe(firstMatchId);
  });

  it("binds a control session to the reused active match", async () => {
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
    expect(next.statusCode).toBe(200);
    const firstMatchId = first.json<{ data: { matchId: string } }>().data.matchId;
    const session = await request(state, {
      method: "POST",
      url: "/api/control/sessions",
      body: JSON.stringify({ playerId: PLAYER_IDS.PLAYER_1, gameId: firstMatchId }),
    });

    expect(session.statusCode).toBe(201);
    expect(session.json()).toMatchObject({ data: { gameId: firstMatchId } });
    expect(state.matchRegistry.getObservedMatchId()).toBe(firstMatchId);
  });

  it("lists, observes, saves, and stops a match through registry routes", async () => {
    const state = createServerState(createPresetStore());
    const game = new Game();
    const stop = vi.fn(() => game.stop());
    const saveRecord = vi.fn(async () => "/tmp/match_registry_api.match.json");
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
    expect(save.json()).toMatchObject({ filePath: "/tmp/match_registry_api.match.json" });
    expect(stopResponse.statusCode).toBe(200);
    expect(saveRecord).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("accepts more than 100 HTTP actions without a command quota", async () => {
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
        clientRequestId: "http_large_batch",
        actions: Array.from({ length: 101 }, (_, index) => ({
          tool: "hold_unit",
          args: { unitId: workers[index % 2]!.id },
        })),
      }),
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json<{ data: { results: Array<{ ok: boolean }> } }>();
    expect(payload).toMatchObject({
      ok: true,
      kind: "batch_result",
      data: {
        clientRequestId: "http_large_batch",
        duplicate: false,
        results: expect.arrayContaining([expect.objectContaining({ ok: true })]),
      },
    });
    expect(payload.data.results).toHaveLength(101);
    match.advanceOneTick();
    expect(match.getGame().getState().players[0]!.units.filter((unit) => (
      workers.slice(0, 2).some((worker) => worker.id === unit.id)
      && unit.intent?.type === "hold"
    ))).toHaveLength(2);
    match.stop();
  });
});
