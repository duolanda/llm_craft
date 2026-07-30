import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function resolvePackageBin(packageDir, packageName, binName = packageName) {
  const packageRequire = createRequire(join(packageDir, 'package.json'));
  const packageJsonPath = packageRequire.resolve(`${packageName}/package.json`);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const relativeBin = typeof packageJson.bin === 'string'
    ? packageJson.bin
    : packageJson.bin?.[binName];

  if (!relativeBin) {
    throw new Error(`Package ${packageName} does not expose the ${binName} executable`);
  }

  return resolve(dirname(packageJsonPath), relativeBin);
}

const sharedDir = join(rootDir, 'packages', 'shared');
const recordDir = join(rootDir, 'packages', 'record');
const serverDir = join(rootDir, 'packages', 'server');
const clientDir = join(rootDir, 'packages', 'client');
const quietTscWatch = join(rootDir, 'scripts', 'quiet-tsc-watch.mjs');
const serverRequire = createRequire(join(serverDir, 'package.json'));
const serverEnvPath = join(serverDir, '.env');
const serverFileEnv = existsSync(serverEnvPath)
  ? serverRequire('dotenv').parse(readFileSync(serverEnvPath))
  : {};
const serverPort = process.env.PORT || serverFileEnv.PORT || '3101';
const devServerUrl = `http://localhost:${serverPort}`;

const commands = [
  { name: 'shared', cwd: sharedDir, args: [quietTscWatch] },
  { name: 'record', cwd: recordDir, args: [quietTscWatch] },
  {
    name: 'server',
    cwd: serverDir,
    args: [resolvePackageBin(serverDir, 'tsx'), 'watch', 'src/index.ts'],
  },
  {
    name: 'client',
    cwd: clientDir,
    args: [resolvePackageBin(clientDir, 'vite')],
    env: { LLMCRAFT_DEV_SERVER_URL: devServerUrl },
  },
];

let shuttingDown = false;
let shutdownSignal;
let forceExitTimer;
let exitCode = 0;

function pipeWithPrefix(stream, target, prefix) {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    let newlineIndex;
    while ((newlineIndex = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newlineIndex + 1);
      buffered = buffered.slice(newlineIndex + 1);
      target.write(`${prefix} ${line}`);
    }
  });
  stream.on('end', () => {
    if (buffered) target.write(`${prefix} ${buffered}\n`);
  });
}

const children = commands.map((command, index) => {
  const prefix = `[${index}]`;
  const child = spawn(process.execPath, command.args, {
    cwd: command.cwd,
    env: { ...process.env, ...command.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  pipeWithPrefix(child.stdout, process.stdout, prefix);
  pipeWithPrefix(child.stderr, process.stderr, prefix);

  child.on('error', (error) => {
    exitCode = 1;
    process.stderr.write(`${prefix} Failed to start ${command.name}: ${error.message}\n`);
  });

  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      const childExitCode = code ?? (signal ? 1 : 0);
      if (childExitCode !== 0) exitCode = childExitCode;
      process.stderr.write(
        `${prefix} ${command.name} exited with ${signal ? `signal ${signal}` : `code ${code}`}\n`,
      );
    }

    if (children.every(({ exitCode: childCode, signalCode }) => (
      childCode !== null || signalCode !== null
    ))) {
      if (forceExitTimer) clearTimeout(forceExitTimer);
      process.exitCode = shutdownSignal === 'SIGINT' ? 0 : exitCode;
    }
  });

  return child;
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownSignal = signal;

  // Keyboard SIGINT is delivered to every process attached to the console. Sending
  // it again from here can interrupt a child that has already started cleanup.
  if (signal !== 'SIGINT') {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    }
  }

  forceExitTimer = setTimeout(() => {
    process.stderr.write('Development processes did not stop in time; forcing shutdown.\n');
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    process.exitCode = 1;
  }, 15_000);
  forceExitTimer.unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
