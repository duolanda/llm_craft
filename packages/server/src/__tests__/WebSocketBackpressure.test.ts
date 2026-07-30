import { describe, expect, it } from "vitest";
import {
  MAX_WEBSOCKET_BUFFERED_BYTES,
  shouldDeferLatestProjection,
} from "../WebSocketBackpressure";

describe("WebSocketBackpressure", () => {
  it("defers replaceable projections once the socket queue reaches its cap", () => {
    expect(shouldDeferLatestProjection(0)).toBe(false);
    expect(shouldDeferLatestProjection(MAX_WEBSOCKET_BUFFERED_BYTES - 1)).toBe(false);
    expect(shouldDeferLatestProjection(MAX_WEBSOCKET_BUFFERED_BYTES)).toBe(true);
    expect(shouldDeferLatestProjection(Number.POSITIVE_INFINITY)).toBe(true);
  });
});
