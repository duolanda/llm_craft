import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command, AIStatePackage } from "@llmcraft/shared";

export interface AISandboxResult {
  commands: Command[];
  errorMessage?: string;
}

export const AI_SANDBOX_TIMEOUT_MS = 200;

export class AISandbox {
  private playerId: string;
  private executionTimeoutMs = AI_SANDBOX_TIMEOUT_MS;

  constructor(playerId: string) {
    this.playerId = playerId;
  }

  async executeCode(code: string, state: AIStatePackage): Promise<AISandboxResult> {
    const { modulePath, execArgv } = this.resolveWorkerModule();

    return await new Promise<AISandboxResult>((resolve) => {
      const child = fork(modulePath, [], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        execArgv,
      });
      let stderrOutput = "";

      let settled = false;
      const finish = (result: AISandboxResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (!child.killed) {
          child.kill();
        }
        resolve(result);
      };

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderrOutput += chunk;
      });

      const timeout = setTimeout(() => {
        finish({
          commands: [],
          errorMessage: `Sandbox timed out after ${this.executionTimeoutMs}ms`,
        });
      }, this.executionTimeoutMs);

      child.once("message", (message: any) => {
        finish({
          commands: Array.isArray(message?.commands) ? message.commands : [],
          errorMessage: typeof message?.errorMessage === "string" ? message.errorMessage : undefined,
        });
      });

      child.once("error", (error) => {
        console.error(`AI ${this.playerId} 沙箱进程错误:`, error);
        finish({
          commands: [],
          errorMessage: stderrOutput.trim()
            ? `${error.message}\n${stderrOutput.trim()}`
            : error.message,
        });
      });

      child.once("exit", (code, signal) => {
        if (!settled) {
          const detail = stderrOutput.trim();
          finish({
            commands: [],
            errorMessage: signal
              ? `Sandbox exited with signal ${signal}`
              : detail
                ? `Sandbox exited before returning a result (code ${code ?? "unknown"})\n${detail}`
                : `Sandbox exited before returning a result (code ${code ?? "unknown"})`,
          });
        }
      });

      child.send({
        code,
        state,
        playerId: this.playerId,
      });
    });
  }

  private resolveWorkerModule(): { modulePath: string; execArgv: string[] } {
    const sourceWorker = fileURLToPath(new URL("./AISandboxWorker.cjs", import.meta.url));
    return {
      modulePath: sourceWorker,
      execArgv: [],
    };
  }
}
