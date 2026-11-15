import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './paths.ts';

export class RoutletError extends Error {
  code: string;
  constructor(message: string, code = 'error') {
    super(message);
    this.name = 'RoutletError';
    this.code = code;
  }
}

export type IngressMode = 'tailscale' | 'local';

/** What Routlet remembers about a service between runs. */
export interface ServiceRecord {
  name: string;
  /** Absolute directory that claimed the name. A different directory cannot reuse it. */
  owner: string;
  command: string[];
  ingress: IngressMode;
  /** Stable URL. Kept while the service is stopped so other services can reference it. */
  url: string;
  hostname: string;
  /** Port the app listened on during its most recent run. */
  port?: number;
  /** Fixed listener port for the `local` ingress. */
  localPort?: number;
  startedAt?: string;
}

/** Held while a service is running. */
export interface Lock {
  /** Process that owns the run (the CLI, or a program using the library). */
  pid: number;
  /** The app's root process, once spawned. */
  childPid?: number;
  /** True when the owner is `routlet run`, which is safe to signal directly. */
  cli?: boolean;
  /** Tailnet services: the gateway device hosting the name. */
  hostId?: string;
  /** True while the app is running but its URL is down and being restored. */
  offline?: boolean;
  /** True while Tailscale is not letting this machine serve the name. */
  unapproved?: boolean;
}

// A single DNS label, because the name becomes the hostname.
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new RoutletError(
      `Invalid service name "${name}". Use lowercase letters, digits, and hyphens (max 63 characters).`,
      'invalid_name',
    );
  }
  return name;
}

function servicesDir(): string {
  const dir = path.join(stateDir(), 'services');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const recordPath = (name: string) => path.join(servicesDir(), `${name}.json`);
const lockPath = (name: string) => path.join(servicesDir(), `${name}.lock`);

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function readRecord(name: string): ServiceRecord | undefined {
  return readJson<ServiceRecord>(recordPath(name));
}

export function writeRecord(record: ServiceRecord): void {
  writeJsonAtomic(recordPath(record.name), record);
}

export function removeRecord(name: string): void {
  fs.rmSync(recordPath(name), { force: true });
}

export function listRecords(): ServiceRecord[] {
  return fs
    .readdirSync(servicesDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson<ServiceRecord>(path.join(servicesDir(), f)))
    .filter((r): r is ServiceRecord => r !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The live lock for a service, or undefined. Stale locks (dead owner) are cleared. */
export function readLock(name: string): Lock | undefined {
  const lock = readJson<Lock>(lockPath(name));
  if (!lock) return undefined;
  if (!isAlive(lock.pid)) {
    fs.rmSync(lockPath(name), { force: true });
    return undefined;
  }
  return lock;
}

export function acquireLock(name: string, lock: Lock): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath(name), JSON.stringify(lock), { flag: 'wx' });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // readLock removes the file if its owner is dead, so the retry can succeed.
      if (readLock(name)) break;
    }
  }
  throw new RoutletError(`"${name}" is already running.`, 'already_running');
}

export function updateLock(name: string, lock: Lock): void {
  writeJsonAtomic(lockPath(name), lock);
}

export function releaseLock(name: string): void {
  const lock = readJson<Lock>(lockPath(name));
  if (lock?.pid === process.pid) fs.rmSync(lockPath(name), { force: true });
}
