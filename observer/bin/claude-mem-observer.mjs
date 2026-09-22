#!/usr/bin/env node
// CLI for the claude-mem host observer daemon. Mirrors claude-mem's own
// worker CLI vocabulary (start/stop/restart/status, PID file, uptime), scaled
// down for a single dependency-free Node service instead of a Bun+SQLite
// worker with a supervisor.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 37777;
const DEFAULT_HOST = '127.0.0.1';

// Resolve the real project root even when this file is symlinked into
// ~/.local/bin (fileURLToPath + realpath follows the symlink back to source).
const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(path.dirname(scriptPath));

const stateDir = path.join(homedir(), '.claude-mem-host-observer');
const pidFile = path.join(stateDir, 'observer.pid');
const logFile = path.join(stateDir, 'observer.log');

function parseArgs(argv) {
  const result = { command: argv[0], port: DEFAULT_PORT, host: DEFAULT_HOST };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') {
      result.port = Number(argv[++i]);
    } else if (arg.startsWith('--port=')) {
      result.port = Number(arg.slice('--port='.length));
    } else if (arg === '--host') {
      result.host = argv[++i];
    } else if (arg.startsWith('--host=')) {
      result.host = arg.slice('--host='.length);
    }
  }
  return result;
}

function readPidFile() {
  if (!existsSync(pidFile)) return null;
  try {
    return JSON.parse(readFileSync(pidFile, 'utf8'));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function start({ port, host }) {
  mkdirSync(stateDir, { recursive: true });

  const existing = readPidFile();
  if (existing && isAlive(existing.pid)) {
    console.log(`claude-mem-observer already running (pid ${existing.pid}, uptime ${formatUptime(Date.now() - existing.startedAt)})`);
    return;
  }

  const tsxBin = path.join(projectRoot, 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsxBin)) {
    console.error(`tsx not found at ${tsxBin} -- run "npm install" in ${projectRoot} first.`);
    process.exitCode = 1;
    return;
  }

  const logFd = openSync(logFile, 'a');
  const child = spawn(tsxBin, [path.join(projectRoot, 'src', 'server.ts')], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), HOST: host },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();

  const startedAt = Date.now();
  writeFileSync(pidFile, JSON.stringify({ pid: child.pid, startedAt, port, host }, null, 2));

  // Give it a moment to bind (or die immediately, e.g. port already in use)
  // before declaring success -- mirrors claude-mem's boot-probe idea.
  await sleep(600);
  if (!isAlive(child.pid)) {
    console.error(`claude-mem-observer exited immediately -- check ${logFile}`);
    try { unlinkSync(pidFile); } catch { /* already gone */ }
    process.exitCode = 1;
    return;
  }

  console.log(`Started claude-mem-observer (pid ${child.pid}) on http://${host}:${port}`);
  console.log(`  logs: ${logFile}`);
}

async function stop() {
  const info = readPidFile();
  if (!info) {
    console.log('claude-mem-observer is not running.');
    return;
  }
  if (!isAlive(info.pid)) {
    console.log('claude-mem-observer is not running (removing stale PID file).');
    try { unlinkSync(pidFile); } catch { /* already gone */ }
    return;
  }

  process.kill(info.pid, 'SIGTERM');
  const deadlineMs = Date.now() + 5000;
  while (Date.now() < deadlineMs && isAlive(info.pid)) {
    await sleep(150);
  }
  if (isAlive(info.pid)) {
    console.warn(`pid ${info.pid} did not exit after SIGTERM -- sending SIGKILL`);
    process.kill(info.pid, 'SIGKILL');
    await sleep(150);
  }

  try { unlinkSync(pidFile); } catch { /* already gone */ }
  console.log(`Stopped claude-mem-observer (pid ${info.pid})`);
}

function status() {
  const info = readPidFile();
  if (!info || !isAlive(info.pid)) {
    if (info) {
      console.log('claude-mem-observer: not running (stale PID file present)');
    } else {
      console.log('claude-mem-observer: not running');
    }
    process.exitCode = 1;
    return;
  }

  console.log('claude-mem-observer: running');
  console.log(`  pid:       ${info.pid}`);
  console.log(`  uptime:    ${formatUptime(Date.now() - info.startedAt)}`);
  console.log(`  listening: http://${info.host}:${info.port}`);
  console.log(`  log:       ${logFile}`);
}

async function main() {
  const { command, port, host } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'start':
      await start({ port, host });
      break;
    case 'stop':
      await stop();
      break;
    case 'restart':
      await stop();
      await start({ port, host });
      break;
    case 'status':
      status();
      break;
    default:
      console.error('Usage: claude-mem-observer <start|stop|restart|status> [--port 37777] [--host 127.0.0.1]');
      process.exitCode = 1;
  }
}

main();
