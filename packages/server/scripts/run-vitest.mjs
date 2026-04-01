import { spawn } from 'node:child_process';

const forwardedArgs = process.argv.slice(2);
const vitestArgs = ['--config', 'vitest.config.ts', '--passWithNoTests', '--run'];

for (let index = 0; index < forwardedArgs.length; index += 1) {
  const argument = forwardedArgs[index];

  if (argument === '--run') {
    continue;
  }

  if (argument === '--grep') {
    const pattern = forwardedArgs[index + 1];

    if (pattern !== undefined) {
      vitestArgs.push('--testNamePattern', pattern);
      index += 1;
    }

    continue;
  }

  if (argument.startsWith('--grep=')) {
    vitestArgs.push('--testNamePattern', argument.slice('--grep='.length));
    continue;
  }

  vitestArgs.push(argument);
}

const child = spawn(process.platform === 'win32' ? 'vitest.cmd' : 'vitest', vitestArgs, {
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
