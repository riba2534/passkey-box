import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { KEEP_TMP } from './config.ts';

export type ProcessInfo = { pid: number; logFile: string; marker: string };

/**
 * Starts a long-running process that outlives the Playwright worker which spawned it
 * (setup and teardown may run in different workers). Output goes to `logFile`.
 */
function startDetached(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; logFile: string },
): number {
  const fd = fs.openSync(options.logFile, 'a');
  try {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    if (child.pid === undefined) throw new Error(`failed to start ${command}`);
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(fd);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Guards against PID reuse: only signal a process whose command line still contains `marker`. */
function isOurs(pid: number, marker: string): boolean {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(marker);
  } catch {
    // No procfs (e.g. macOS) or the process is gone; fall back to liveness.
    return isAlive(pid);
  }
}

/** SIGTERM by PID, then SIGKILL if it has not exited within `timeoutMs`. */
export async function stopProcess(info: ProcessInfo, timeoutMs = 5_000): Promise<void> {
  const { pid, marker } = info;
  if (!isAlive(pid) || !isOurs(pid, marker)) return;
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await sleep(100);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

function logTail(logFile: string, lines = 40): string {
  try {
    return fs.readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

async function waitForHealthy(url: string, info: ProcessInfo, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(info.pid)) {
      throw new Error(`process ${info.pid} exited before ${url} became healthy:\n${logTail(info.logFile)}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${url}:\n${logTail(info.logFile)}`);
}

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Runs a build step; rejects with the tail of its output on failure. */
export function runStep(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<void> {
  const what = `\`${command} ${args.join(' ')}\``;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.once('error', (err) => reject(new Error(`${what} failed to start: ${err.message}`)));
    child.once('close', (status) => {
      if (status === 0) return resolve();
      const tail = output.trimEnd().split('\n').slice(-60).join('\n');
      reject(new Error(`${what} failed (status ${status}):\n${tail}`));
    });
  });
}

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** Stops an instance recorded in `stateFile` by an earlier run and empties `tmpDir`. */
export async function resetService(stateFile: string, tmpDir: string): Promise<void> {
  const stale = readJsonFile<ProcessInfo>(stateFile);
  if (stale) await stopProcess(stale);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
}

/**
 * Starts a detached service for a setup project, records it in `stateFile` for the teardown
 * project and waits until `healthUrl` answers. A service that never gets healthy is stopped.
 */
export async function startService(options: {
  command: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Port the service listens on, and the variable that overrides it. */
  port: number;
  portVariable: string;
  logFile: string;
  marker: string;
  stateFile: string;
  healthUrl: string;
}): Promise<ProcessInfo> {
  if (await isPortOpen(options.port)) {
    throw new Error(`port ${options.port} is already in use; stop that process or set ${options.portVariable}`);
  }
  const pid = startDetached(options.command, options.args ?? [], options);
  const info: ProcessInfo = { pid, logFile: options.logFile, marker: options.marker };
  writeJsonFile(options.stateFile, info);
  try {
    await waitForHealthy(options.healthUrl, info);
  } catch (err) {
    await stopProcess(info);
    throw err;
  }
  return info;
}

/** Teardown counterpart of resetService/startService. */
export async function stopService(stateFile: string, tmpDir: string): Promise<void> {
  const info = readJsonFile<ProcessInfo>(stateFile);
  if (info) await stopProcess(info);
  if (!KEEP_TMP) fs.rmSync(tmpDir, { recursive: true, force: true });
}
