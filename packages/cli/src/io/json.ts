export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

export function printError(message: string): void {
  process.stderr.write(`llmcraft: ${message}\n`);
}
