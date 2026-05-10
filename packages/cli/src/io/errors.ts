export enum ExitCode {
  Success = 0,
  ArgError = 1,
  BackendFailure = 2,
  ConnectionFailure = 3,
  StdinParseError = 4,
}

export function exit(code: ExitCode, message: string): never {
  process.stderr.write(`llmcraft: ${message}\n`);
  process.exit(code);
}
