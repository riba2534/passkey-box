import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export type ProcessInfo = { pid: number; logFile: string; marker: string };

/**
 * Starts a long-running process that outlives the Playwright worker which spawned it
 * (setup and teardown may run in different workers). Output goes to `logFile`.
 */
export function startDetached(
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

export function isAlive(pid: number): boolean {
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

export function logTail(logFile: string, lines = 40): string {
  try {
    return fs.readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

export async function waitForHealthy(url: string, info: ProcessInfo, timeoutMs = 20_000): Promise<void> {
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

export function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Runs a build step synchronously; throws with the tail of its output on failure. */
export function runStep(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd().split('\n').slice(-60).join('\n');
    throw new Error(`\`${command} ${args.join(' ')}\` failed (status ${result.status}, ${result.error ?? 'no error'}):\n${output}`);
  }
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
