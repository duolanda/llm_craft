import { ExitCode } from "../io/errors.js";
import { printJson } from "../io/json.js";

function isFailedResponse(value: unknown): value is { ok: false; error?: unknown } {
  return typeof value === "object"
    && value !== null
    && (value as Record<string, unknown>).ok === false;
}

export function printBatchResult(tick: number, results: unknown[]): void {
  const failed = results.find(isFailedResponse);
  printJson({
    ok: !failed,
    tick,
    kind: "batch_result",
    data: { results },
    ...(failed
      ? {
          error: failed.error ?? {
            code: "batch_action_failed",
            message: "One or more batched actions failed",
          },
        }
      : {}),
  });
  if (failed) {
    process.exit(ExitCode.BackendFailure);
  }
}
