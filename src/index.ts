import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { adaptCommand } from './adapt.ts';
import { keepAlive, startLocalIngress, startServiceIngress, type Ingress } from './ingress.ts';
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
  type Lock,
  type ServiceRecord,
} from './registry.ts';
import {
  approveHost,
  defineService,
  deleteService,
  findDevices,
  getService,
  hasSecret,
  isApproved,
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
  /** True while the app is running but its URL is down and being restored. */
  urlOffline?: boolean;
}

export interface ServiceDetails extends ServiceInfo {
  /** True if the app is accepting connections on its port right now. */
  healthy: boolean;
  /**
   * For a running tailnet service: whether Tailscale currently lets this
   * machine's gateway serve it. Undefined when that is not known: the check
   * failed, or the gateway is not hosting the name at the moment.
   */
  approved?: boolean;
}

const active = new Map<string, RunningService>();

const APPROVAL_CHECK_MS = 120_000;

/** This machine's entry among the devices offering to host a service, if any. */
async function findHost(secret: string, name: string, hostId: string) {
  return (await serviceHosts(secret, name)).find((h) => h.nodeId === hostId);
}

/**
 * Make sure this machine's gateway is approved to host a service, approving it
 * through the API if it is not. Only ever touches the given host: another
 * machine's approval is that machine's, or an admin's, business.
 * Returns true if it had to approve.
 */
async function ensureApproved(secret: string, name: string, hostId: string): Promise<boolean> {
  const host = await findHost(secret, name, hostId);
  if (!host) throw new RoutletError(`Tailscale does not list this machine as a host for "${name}".`, 'service_failed');
  if (isApproved(host)) return false;
  await approveHost(secret, name, hostId);
  return true;
}

/**
 * Restore approval for a running service if it has been withdrawn, for example
 * by a policy change. Without this the URL would stay dead, silently, until the
 * service was next restarted.
 */
async function keepApproved(name: string, hostId: string | undefined, log: (message: string) => void): Promise<void> {
  if (!hostId) return;
  try {
    if (await ensureApproved(loadSecret(), name, hostId)) {
      log(`Tailscale had withdrawn approval for "${name}". Restored it.`);
    }
  } catch {
    // A failed check is not worth interrupting anyone for; the next one will retry.
  }
}

/**
 * Claim a name on the tailnet for this machine: check nothing else has it and
 * define the service if it is new. Done once, when a service starts.
 */
async function claimName(name: string, prev: ServiceRecord | undefined, replace: boolean): Promise<void> {
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
}

interface AttachOptions {
  name: string;
  mode: IngressMode;
  /** Local mode: the fixed port to listen on, or 0 to pick one. */
  localPort: number;
  /**
   * False when re-attaching a service that was already up. Approval was granted
   * when it started and is watched separately, so a failure to confirm it (the
   * Tailscale API being unreachable, say) must not stop the URL coming back
   * after a purely local gateway restart.
   */
  mustApprove: boolean;
  log: (message: string) => void;
  signal?: AbortSignal;
}

/** Bring up the URL for a name this machine has already claimed. */
function attach(opts: AttachOptions): Promise<Ingress> {
  const { name, log, signal } = opts;
  if (opts.mode === 'local') return startLocalIngress(`127.0.0.1:${opts.localPort}`, log, signal);

  const secret = loadSecret();
  return startServiceIngress({
    name,
    onLog: log,
    getAuthKey: () => mintAuthKey(secret, 'routlet gateway'),
    signal,
    approve: async (nodeId) => {
      // A device must be approved to host a service. Tailnets with an
      // autoApprovers rule do this themselves; otherwise approve it here.
      // Tailscale takes a moment to list a host that has just advertised, and
      // a slow network is worth a retry too.
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) throw new RoutletError('Cancelled.', 'cancelled');
        try {
          await ensureApproved(secret, name, nodeId);
          return;
        } catch (err) {
          const retryable =
            err instanceof RoutletError && (err.code === 'service_failed' || err.code === 'tailscale_unreachable');
          if (retryable && attempt < 40) {
            await new Promise((r) => setTimeout(r, 500).unref());
            continue;
          }
          if (!opts.mustApprove) return;
          throw err;
        }
      }
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
  const lock: Lock = { pid: process.pid, cli: opts.cli };
  acquireLock(name, lock);

  let ingress: Ingress | undefined;
  let child: ChildProcess | undefined;
  try {
    // The URL can go away while the app is healthy: the gateway may crash or be
    // restarted. That is no reason to stop someone's dev server, so the ingress
    // is wrapped to bring the URL back behind the running app.
    if (mode === 'tailscale') await claimName(name, prev, Boolean(opts.replace));
    const first = await attach({
      name,
      mode,
      localPort: prev?.ingress === 'local' ? (prev.localPort ?? 0) : 0,
      mustApprove: true,
      log,
    });
    // A replacement must come up at the address the app was told about, which
    // for a local service is the port the first one actually got.
    const localPort = mode === 'local' ? Number(new URL(first.url).port) : 0;
    const live = keepAlive({
      name,
      first,
      open: (signal) => attach({ name, mode, localPort, mustApprove: false, log, signal }),
      onLog: log,
      onState: (online) => {
        lock.offline = !online;
        lock.hostId = live.hostId;
        updateLock(name, lock);
      },
    });
    ingress = live;
    lock.hostId = live.hostId;
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
    lock.childPid = pid;
    updateLock(name, lock);

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

    const approvalCheck =
      mode === 'tailscale'
        ? setInterval(() => void keepApproved(name, live.hostId, log), APPROVAL_CHECK_MS)
        : undefined;
    approvalCheck?.unref();

    // Shutting down has two steps. Repairs stop at once, so a helper dying as
    // part of the shutdown is not mistaken for an outage. The URL itself stays
    // up until the app has exited, so requests in flight are not cut off.
    const beginShutdown = () => {
      clearInterval(approvalCheck);
      live.quiesce();
    };
    const exited = exitCode.then((code) => {
      beginShutdown();
      live.stop();
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
        beginShutdown();
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

function withLock(record: ServiceRecord): { info: ServiceInfo; hostId?: string } {
  const lock = readLock(record.name);
  return {
    info: { ...record, running: Boolean(lock), pid: lock?.childPid, urlOffline: lock?.offline || undefined },
    hostId: lock?.hostId,
  };
}

function toInfo(record: ServiceRecord): ServiceInfo {
  return withLock(record).info;
}

/** Every known service, running or not. */
export function list(): ServiceInfo[] {
  return listRecords().map(toInfo);
}

async function approvalOf(name: string, hostId: string): Promise<boolean | undefined> {
  const check = (async () => {
    const host = await findHost(loadSecret(), name, hostId);
    return host ? isApproved(host) : undefined;
  })().catch(() => undefined);
  const timeout = new Promise<undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 4000);
    timer.unref();
  });
  return Promise.race([check, timeout]);
}

/** Details for one service, or undefined if the name has never been used. */
export async function inspect(name: string): Promise<ServiceDetails | undefined> {
  const record = readRecord(validateName(name));
  if (!record) return undefined;
  const { info, hostId } = withLock(record);
  // Both checks at once, and the network one is bounded, so a dead connection
  // cannot hold up what is otherwise a local status command.
  const [healthy, approved] = await Promise.all([
    info.running && record.port !== undefined ? isListening(record.port) : false,
    info.running && record.ingress === 'tailscale' && hostId ? approvalOf(record.name, hostId) : undefined,
  ]);
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
