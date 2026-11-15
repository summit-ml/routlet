import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { adaptCommand } from './adapt.ts';
import { startLocalIngress, startServiceIngress, type Ingress } from './ingress.ts';
import { freePort, isListening, terminateTree, waitForPort } from './ports.ts';
import {
  acquireLock,
  listRecords,
  readLock,
  readRecord,
  releaseLock,
  removeRecord,
  RoutletError,
  updateLock,
  validateName,
  writeRecord,
  type IngressMode,
  type ServiceRecord,
} from './registry.ts';
import {
  approveHost,
  defineService,
  deleteService,
  findDevices,
  getService,
  hasSecret,
  loadSecret,
  mintAuthKey,
  routletTag,
  serviceHosts,
} from './tailscale-api.ts';

export { RoutletError };
export { setup, type SetupCheck } from './setup.ts';
export { clearSecret, parseSecret, storeSecret } from './secret-store.ts';
export type { IngressMode, ServiceRecord };

export interface RunOptions {
  /** Service name. Becomes the hostname, so it must be a valid DNS label. */
  name: string;
  /** The app's normal start command, for example ['npm', 'run', 'dev']. */
  command: string[];
  /** Directory to run in. Also identifies who owns the name. Defaults to the current directory. */
  cwd?: string;
  /** Extra environment variables for the app. */
  env?: Record<string, string>;
  /**
   * Environment variables to fill with service URLs: variable name to service name.
   * Use 'self' for this service's own URL. Example: { API_URL: 'api-workflow-portal' }.
   */
  urlEnv?: Record<string, string>;
  /**
   * 'tailscale' for a tailnet HTTPS hostname, 'local' for a fixed localhost port.
   * Defaults to 'tailscale' when a credential is configured and 'local' otherwise.
   */
  ingress?: IngressMode;
  /** Force a specific app port instead of picking a free one. */
  port?: number;
  /** Take over the name if it is running or owned by another directory. */
  replace?: boolean;
  /** How to wire the app's stdio. Defaults to 'inherit'. */
  stdio?: StdioOptions;
  /** How long to wait for the app to start listening. Defaults to 60 seconds. */
  readyTimeoutMs?: number;
  /** Receives Routlet's own status messages. */
  onLog?: (message: string) => void;
  /** @internal Set by the CLI: the owning process exists only for this service. */
  cli?: boolean;
}

export interface RunningService {
  name: string;
  url: string;
  /** Localhost port the app is listening on. */
  port: number;
  pid: number;
  child: ChildProcess;
  /** Stop the app and take the URL offline. The name and URL stay reserved. */
  stop(): Promise<void>;
  /** Resolves with the app's exit code once everything is cleaned up. */
  exited: Promise<number>;
}

export interface ServiceInfo extends ServiceRecord {
  running: boolean;
  pid?: number;
}

export interface ServiceDetails extends ServiceInfo {
  /** True if the app is accepting connections on its port right now. */
  healthy: boolean;
  /**
   * For a running tailnet service: whether Tailscale currently lets this
   * machine serve it. Undefined when that could not be checked.
   */
  approved?: boolean;
}

const active = new Map<string, RunningService>();

const APPROVAL_CHECK_MS = 120_000;

/**
 * Restore the gateway's approval to host a running service if it has been
 * withdrawn, for example by a policy change. Without this the URL would stay
 * dead, silently, until the service was next restarted.
 */
async function keepApproved(name: string, log: (message: string) => void): Promise<void> {
  try {
    const secret = loadSecret();
    for (const host of await serviceHosts(secret, name)) {
      if (host.approvalLevel.startsWith('approved')) continue;
      await approveHost(secret, name, host.nodeId);
      log(`Tailscale had withdrawn approval for "${name}". Restored it.`);
    }
  } catch {
    // A failed check is not worth interrupting anyone for; the next one will retry.
  }
}

async function openIngress(
  name: string,
  mode: IngressMode,
  prev: ServiceRecord | undefined,
  replace: boolean,
  log: (message: string) => void,
): Promise<Ingress> {
  if (mode === 'local') {
    const port = prev?.ingress === 'local' ? (prev.localPort ?? 0) : 0;
    return startLocalIngress(`127.0.0.1:${port}`, log);
  }

  const secret = loadSecret();
  const conflict = (why: string) => new RoutletError(`The name "${name}" ${why}`, 'name_conflict');

  // The service's hostname shares a namespace with every device on the tailnet.
  const devices = await findDevices(secret, name);
  if (devices.length) {
    throw conflict(`is already a device on your tailnet (${devices[0].name}). Choose another name.`);
  }
  const existing = await getService(secret, name);
  if (existing && !existing.tags?.includes(routletTag())) {
    throw conflict('is already a Tailscale Service that Routlet did not create. Choose another name.');
  }
  if (existing && prev?.ingress !== 'tailscale' && !replace) {
    // Known to the tailnet but not to this machine. Adopt it only if nothing is serving it.
    if ((await serviceHosts(secret, name)).length) {
      throw conflict('is being served from another machine on your tailnet. Stop it there, or use replace to take it over.');
    }
  }
  if (!existing) await defineService(secret, name);

  return startServiceIngress({
    name,
    onLog: log,
    getAuthKey: () => mintAuthKey(secret, 'routlet gateway'),
    approve: async (nodeId) => {
      // A device must be approved to host a service. Tailnets with an
      // autoApprovers rule do this themselves; otherwise approve it here.
      for (let attempt = 0; attempt < 40; attempt++) {
        const host = (await serviceHosts(secret, name)).find((h) => h.nodeId === nodeId);
        if (host?.approvalLevel.startsWith('approved')) return;
        if (host) return approveHost(secret, name, nodeId);
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new RoutletError(`Tailscale never listed this machine as a host for "${name}".`, 'service_failed');
    },
  });
}

function resolveUrl(ref: string, name: string, ingress: Ingress, mode: IngressMode): string {
  if (ref === 'self' || ref === name) return ingress.url;
  const record = readRecord(validateName(ref));
  if (record) return record.url;
  if (mode === 'tailscale') {
    // Tailnet URLs are predictable: same domain, different first label. This lets
    // two services reference each other before either has run.
    const url = new URL(ingress.url);
    url.hostname = ref + url.hostname.slice(name.length);
    return url.origin;
  }
  throw new RoutletError(`Service "${ref}" has no URL yet. Run it once first.`, 'not_found');
}

/** Start an app under a stable URL. Resolves once the app is listening and reachable. */
export async function run(opts: RunOptions): Promise<RunningService> {
  const name = validateName(opts.name);
  if (!opts.command?.length) throw new RoutletError('No command given.', 'usage');
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const log = opts.onLog ?? (() => {});
  // Tailscale when it is set up, otherwise a local address, so the same command
  // works for everyone who runs it. Asking for an ingress by name never falls back.
  let mode = opts.ingress;
  if (!mode) {
    mode = hasSecret() ? 'tailscale' : 'local';
    if (mode === 'local') {
      log('No Tailscale credential found, so this URL only works on this machine. Run "routlet setup" to see how to enable tailnet URLs.');
    }
  }

  const prev = readRecord(name);
  if (prev && prev.owner !== cwd && !opts.replace) {
    throw new RoutletError(
      `The name "${name}" belongs to ${prev.owner}. Choose another name, or use replace to take it over.`,
      'name_owned',
    );
  }
  if (readLock(name)) {
    if (!opts.replace) throw new RoutletError(`"${name}" is already running.`, 'already_running');
    await stop(name);
  }
  acquireLock(name, { pid: process.pid, cli: opts.cli });

  let ingress: Ingress | undefined;
  let child: ChildProcess | undefined;
  try {
    ingress = await openIngress(name, mode, prev, Boolean(opts.replace), log);
    const port = opts.port ?? (await freePort());

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...opts.env,
      PORT: String(port),
      ROUTLET_NAME: name,
      ROUTLET_URL: ingress.url,
      // Vite rejects requests for hostnames it does not know. This is its own
      // opt-in for tools like this one, so no vite.config change is needed.
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ingress.hostname,
    };
    for (const [key, ref] of Object.entries(opts.urlEnv ?? {})) {
      env[key] = resolveUrl(ref, name, ingress, mode);
    }

    const command = adaptCommand(opts.command, port, cwd);
    const proc = spawn(command[0], command.slice(1), { cwd, env, stdio: opts.stdio ?? 'inherit' });
    child = proc;
    const exitCode = new Promise<number>((resolve) => {
      proc.once('exit', (code, signal) =>
        resolve(code ?? 128 + (signal ? (os.constants.signals[signal] ?? 0) : 0)),
      );
    });
    await new Promise<void>((resolve, reject) => {
      proc.once('spawn', resolve);
      proc.once('error', (err) =>
        reject(new RoutletError(`Could not run "${command[0]}": ${err.message}`, 'spawn_failed')),
      );
    });
    const pid = proc.pid!;
    updateLock(name, { pid: process.pid, childPid: pid, cli: opts.cli });

    const abort = exitCode.then((code): never => {
      throw new RoutletError(`The app exited before it started listening (exit code ${code}).`, 'app_exited');
    });
    abort.catch(() => {});
    const actualPort = await waitForPort({
      assigned: port,
      rootPid: pid,
      timeoutMs: opts.readyTimeoutMs ?? 60_000,
      abort,
    });
    ingress.setTarget(actualPort);

    writeRecord({
      name,
      owner: cwd,
      command: opts.command,
      ingress: mode,
      url: ingress.url,
      hostname: ingress.hostname,
      port: actualPort,
      localPort: mode === 'local' ? Number(new URL(ingress.url).port) : undefined,
      startedAt: new Date().toISOString(),
    });

    const live = ingress;
    // The URL can go away while the app is healthy: the gateway may crash or be
    // restarted, or an admin may withdraw the host's approval. Neither is a
    // reason to stop someone's dev server, so bring the URL back behind it.
    let current = live;
    let stopping = false;
    const watch = (ing: Ingress) => {
      void ing.exited.then(async () => {
        if (stopping) return;
        log(`The URL for "${name}" went offline. Reconnecting; the app keeps running.`);
        for (let attempt = 0; !stopping; attempt++) {
          try {
            const next = await openIngress(name, mode, readRecord(name), true, log);
            if (stopping) return next.stop();
            next.setTarget(actualPort);
            current = next;
            log(`${name} is back at ${next.url}`);
            return watch(next);
          } catch (err) {
            if (attempt === 0) log(`Could not reconnect yet (${err instanceof Error ? err.message : err}). Still trying.`);
            await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
          }
        }
      });
    };
    watch(live);

    const approvalCheck =
      mode === 'tailscale' ? setInterval(() => void keepApproved(name, log), APPROVAL_CHECK_MS) : undefined;
    approvalCheck?.unref();

    const exited = exitCode.then((code) => {
      stopping = true;
      clearInterval(approvalCheck);
      current.stop();
      active.delete(name);
      releaseLock(name);
      return code;
    });

    const service: RunningService = {
      name,
      url: ingress.url,
      port: actualPort,
      pid,
      child: proc,
      exited,
      stop: async () => {
        await terminateTree(pid);
        await exited;
      },
    };
    active.set(name, service);
    return service;
  } catch (err) {
    if (child?.pid) await terminateTree(child.pid);
    ingress?.stop();
    releaseLock(name);
    throw err;
  }
}

function toInfo(record: ServiceRecord): ServiceInfo {
  const lock = readLock(record.name);
  return { ...record, running: Boolean(lock), pid: lock?.childPid };
}

/** Every known service, running or not. */
export function list(): ServiceInfo[] {
  return listRecords().map(toInfo);
}

/** Details for one service, or undefined if the name has never been used. */
export async function inspect(name: string): Promise<ServiceDetails | undefined> {
  const record = readRecord(validateName(name));
  if (!record) return undefined;
  const info = toInfo(record);
  const healthy = info.running && record.port !== undefined && (await isListening(record.port));
  let approved: boolean | undefined;
  if (info.running && record.ingress === 'tailscale') {
    try {
      const hosts = await serviceHosts(loadSecret(), record.name);
      approved = hosts.some((h) => h.approvalLevel.startsWith('approved'));
    } catch {
      // leave undefined
    }
  }
  return { ...info, healthy, approved };
}

/** The stable URL of a service. Works whether or not it is running. */
export function url(name: string): string {
  const record = readRecord(validateName(name));
  if (!record) throw new RoutletError(`Unknown service "${name}".`, 'not_found');
  return record.url;
}

/** Stop a running service, including one started by another process. Returns false if it was not running. */
export async function stop(name: string): Promise<boolean> {
  validateName(name);
  const mine = active.get(name);
  if (mine) {
    await mine.stop();
    return true;
  }
  const lock = readLock(name);
  if (!lock) return false;
  if (lock.childPid) await terminateTree(lock.childPid);
  else if (lock.cli) process.kill(lock.pid, 'SIGTERM');
  else throw new RoutletError(`"${name}" is still starting. Try again in a moment.`, 'starting');

  // The owning process releases the lock once it has cleaned up.
  for (let i = 0; i < 100 && readLock(name); i++) await new Promise((r) => setTimeout(r, 100));
  return true;
}

export interface RemoveResult {
  /** True if the service's definition was deleted from the tailnet. */
  serviceDeleted: boolean;
}

/** Forget a service: delete it from the tailnet, release the name, and drop local state. */
export async function remove(name: string): Promise<RemoveResult> {
  validateName(name);
  if (readLock(name)) throw new RoutletError(`"${name}" is running. Stop it first.`, 'already_running');
  const record = readRecord(name);
  const result: RemoveResult = { serviceDeleted: false };

  if (record?.ingress !== 'local') {
    const secret = loadSecret();
    const existing = await getService(secret, name);
    // Only ever delete services Routlet created.
    if (existing?.tags?.includes(routletTag())) {
      await deleteService(secret, name);
      result.serviceDeleted = true;
    } else if (!record) {
      throw new RoutletError(`Unknown service "${name}".`, 'not_found');
    }
  }
  removeRecord(name);
  return result;
}
