import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const packageRequire = createRequire(join(process.cwd(), 'package.json'));
const tsc = packageRequire.resolve('typescript/bin/tsc');
const child = spawn(process.execPath, [tsc, '--watch', '--pretty', 'false'], {
  stdio: ['inherit', 'pipe', 'inherit'],
});

const quietStatus = [
  /Starting compilation in watch mode/,
  /File change detected\. Starting incremental compilation/,
  /Found 0 errors\. Watching for file changes/,
];

let buffered = '';

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffered += chunk;
  const lines = buffered.split(/(?<=\n)/);
  buffered = lines.pop() ?? '';

  for (const line of lines) {
    if (line.trim() && !quietStatus.some((pattern) => pattern.test(line))) {
      process.stdout.write(line);
    }
  }
});

child.stdout.on('end', () => {
  if (buffered && !quietStatus.some((pattern) => pattern.test(buffered))) {
    process.stdout.write(buffered);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => {
  console.error(`Failed to start TypeScript watch: ${error.message}`);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
