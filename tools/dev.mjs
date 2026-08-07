import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const processes = [
  spawn(process.execPath, ['src/server/server.mjs'], {
    cwd: root,
    env: { ...process.env, KA_PROMPT_STUDIO_PORT: '4174' },
    stdio: 'inherit',
    windowsHide: true
  }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true
  })
];

let stopping = false;
const stop = (exitCode = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of processes) {
    if (!child.killed) child.kill();
  }
  process.exitCode = exitCode;
};

for (const child of processes) {
  child.once('error', (error) => {
    console.error(error.message);
    stop(1);
  });
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`开发服务意外退出（${signal ?? code ?? 'unknown'}）`);
      stop(code || 1);
    }
  });
}

process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
