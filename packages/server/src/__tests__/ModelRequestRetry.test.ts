import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyModelRequestError, retryModelRequest } from "../agent/ModelRequestRetry";

const connectionError = new OpenAI.APIConnectionError({
  cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
});

afterEach(() => { vi.useRealTimers(); });

describe("model request retry", () => {
  it("recognizes a real SDK connection error whose status property is undefined", () => {
    expect("status" in connectionError).toBe(true);
    expect(connectionError.status).toBeUndefined();
    expect(classifyModelRequestError(connectionError)).toBe("network");
    expect(classifyModelRequestError(new OpenAI.APIConnectionTimeoutError())).toBe("timeout");
    expect(classifyModelRequestError({ status: NaN, cause: { code: "EPIPE" } })).toBe("network");
  });

  it("uses three bounded retries at 2, 4 and 8 seconds, with waiting and retrying progress", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(connectionError);
    const onRetry = vi.fn();
    const failed = expect(retryModelRequest(request, { onRetry })).rejects.toBe(connectionError);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8000);
    await failed;
    expect(request.mock.calls).toEqual([[1], [2], [3], [4]]);
    expect(onRetry.mock.calls.map(([progress]) => [progress.attempt, progress.maxAttempts, progress.phase, progress.delayMs])).toEqual([
      [1, 3, "waiting", 2000], [1, 3, "retrying", 0],
      [2, 3, "waiting", 4000], [2, 3, "retrying", 0],
      [3, 3, "waiting", 8000], [3, 3, "retrying", 0],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([408, 409, 429, 500, 503, 524])("retries HTTP %s and stops immediately after recovery", async (status) => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValueOnce({ status }).mockResolvedValueOnce("recovered");
    const result = retryModelRequest(request);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe("recovered");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    { status: 400, message: "invalid messages" },
    { status: 401, message: "invalid key" },
    { status: 403 },
    { status: 400, message: "context length exceeded" },
    { status: 429, error: { type: "GoUsageLimitError" } },
    { status: 429, error: { type: "FreeUsageLimitError" } },
    { status: 429, error: { code: "insufficient_quota" } },
    { status: 429, error: { code: "credit_balance_exhausted" } },
    { status: 429, error: { code: "organization_spend_limit_exceeded" } },
    { status: 429, error: { code: "project_spend_limit_exceeded" } },
    { status: 429, error: { code: "organization_usage_limit_exceeded" } },
    new Error("Monthly usage limit reached. Enable available balance."),
    new Error("unexpected programming error"),
    new OpenAI.APIUserAbortError(),
  ])("does not retry permanent, quota or abort failures: %j", async (error) => {
    const request = vi.fn().mockRejectedValue(error);
    const onRetry = vi.fn();
    await expect(retryModelRequest(request, { onRetry })).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("cancels the backoff immediately without another request or a retained timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = vi.fn().mockRejectedValue(connectionError);
    const failed = expect(retryModelRequest(request, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await failed;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("makes no request after cancellation, even if it occurs in a retry callback", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn().mockRejectedValue(connectionError);
    await expect(retryModelRequest(request, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
    const retryController = new AbortController();
    await expect(retryModelRequest(request, { signal: retryController.signal, onRetry: () => retryController.abort() }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
