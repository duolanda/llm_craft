import http from "node:http";
import { describe, expect, it } from "vitest";
import { PLAYER_IDS } from "@llmcraft/shared";
import {
  createPresetStore,
  createServerState,
  handleHttpRequest,
} from "../index";

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

  it("rejects a second control game while the current game is still active", async () => {
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
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      error: "已有活跃对局。请先结束当前对局。",
    });
  });

  it("releases a finished control game before starting the next one", async () => {
    const state = createServerState(createPresetStore());

    const first = await request(state, {
      method: "POST",
      url: "/api/control/start-game",
      body: "{}",
    });
    expect(first.statusCode).toBe(201);

    const previousMatch = state.controlMatch;
    expect(previousMatch).not.toBeNull();

    const game = previousMatch?.getGame();
    (game as unknown as { winner: typeof PLAYER_IDS.PLAYER_1 }).winner = PLAYER_IDS.PLAYER_1;

    const next = await request(state, {
      method: "POST",
      url: "/api/control/start-game",
      body: "{}",
    });

    expect(next.statusCode).toBe(201);
    expect(state.controlMatch).not.toBe(previousMatch);
  });
});
