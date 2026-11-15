import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { stateDir } from './paths.ts';
import { RoutletError } from './registry.ts';

/** A stable URL that forwards to whatever localhost port the app currently uses. */
export interface Ingress {
  url: string;
  hostname: string;
  /** Tailnet services only: the ID of the gateway device hosting the name. */
  hostId?: string;
  /** Point the URL at the app. Until this is called, requests get a 503. */
  setTarget(port: number): void;
  /** Take the URL offline. */
  stop(): void;
  /** Resolves when the URL has gone offline, whether asked to or not. */
  exited: Promise<void>;
}

type Log = (message: string) => void;

/** Locate the helper binary: explicit override, platform package, then a local build. */
export function helperPath(): string {
  if (process.env.ROUTLET_HELPER) return process.env.ROUTLET_HELPER;
  const exe = process.platform === 'win32' ? 'routlet-helper.exe' : 'routlet-helper';
  try {
    const require = createRequire(import.meta.url);
    return require.resolve(`@summitml/routlet-${process.platform}-${process.arch}/bin/${exe}`);
  } catch {
    // not installed from npm
  }
  const local = path.resolve(import.meta.dirname, '..', 'helper', 'bin', exe);
  if (fs.existsSync(local)) return local;
  throw new RoutletError(
    `No routlet helper binary for ${process.platform}-${process.arch}. ` +
      'From a source checkout, run "npm run build:helper" (requires Go).',
    'no_helper',
  );
}

interface Channel {
  /** Lines of JSON from the helper. */
  input: NodeJS.ReadableStream;
  send(message: object): void;
  close(): void;
  /** Resolves when the channel is gone. */
  closed: Promise<void>;
  /** Extra detail for the error shown if the channel closes before the URL is up. */
  closeDetail(): string;
  /** Called once the helper has advertised the name and needs it approved. */
  onAdvertised?(event: { fqdn: string; nodeId: string }): Promise<void>;
  onLog: Log;
  timeoutMs: number;
  /** Abandons the negotiation, for example because the service is stopping. */
  signal?: AbortSignal;
}

/** Drive the helper protocol until the URL is ready. */
function negotiate(channel: Channel): Promise<Ingress> {
  return new Promise<Ingress>((resolve, reject) => {
    let settled = false;
    // The signal can outlive many negotiations, so never leave a listener on it.
    const settle = () => {
      settled = true;
      clearTimeout(timer);
      channel.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settle();
      channel.close();
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new RoutletError('Timed out waiting for the URL to come up.', 'ingress_timeout')),
      channel.timeoutMs,
    );
    function onAbort() {
      fail(new RoutletError('Cancelled.', 'cancelled'));
    }
    channel.signal?.addEventListener('abort', onAbort, { once: true });
    if (channel.signal?.aborted) onAbort();
    let hostId: string | undefined;
    void channel.closed.then(() =>
      fail(new RoutletError(`The connection to the helper closed early. ${channel.closeDetail()}`.trim(), 'ingress_failed')),
    );

    readline.createInterface({ input: channel.input }).on('line', (line) => {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      switch (event.event) {
        case 'info':
          channel.onLog(event.message);
          break;
        case 'error':
          fail(new RoutletError(event.message, event.code ?? 'ingress_failed'));
          break;
        case 'advertised':
          hostId = event.nodeId || undefined;
          Promise.resolve(channel.onAdvertised?.(event)).then(
            () => channel.send({ prefetch: true }),
            (err) => fail(err),
          );
          break;
        case 'ready':
          if (settled) return;
          settle();
          resolve({
            url: event.url,
            hostname: event.hostname,
            hostId,
            setTarget: (port) => channel.send({ target: `localhost:${port}` }),
            stop: channel.close,
            exited: channel.closed,
          });
          break;
      }
    });
  });
}

/** A fixed http://127.0.0.1:<port> address, served by a helper process owned by this run. */
export function startLocalIngress(listen: string, onLog: Log, signal?: AbortSignal): Promise<Ingress> {
  const child = spawn(helperPath(), ['--mode', 'local', '--listen', listen], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr: string[] = [];
  readline.createInterface({ input: child.stderr }).on('line', (line) => {
    stderr.push(line);
    if (stderr.length > 5) stderr.shift();
  });
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  });
  return negotiate({
    input: child.stdout,
    send: (message) => child.stdin.write(JSON.stringify(message) + '\n'),
    // Closing stdin tells the helper to exit. It ignores ordinary signals so that
    // a terminal closing does not take the URL down before the app has stopped,
    // so the fallback for a stuck helper has to be SIGKILL.
    close: () => {
      child.stdin.end();
      child.kill('SIGKILL');
    },
    closed,
    closeDetail: () => stderr.join('\n'),
    onLog,
    timeoutMs: 15_000,
    signal,
  });
}

// ---- tailnet gateway ----

const gatewayDir = () => path.join(stateDir(), 'gateway');
const gatewaySocket = () => path.join(stateDir(), 'gateway.sock');
const gatewayLog = () => path.join(stateDir(), 'gateway.log');

/** True once this machine's gateway device has joined the tailnet. */
export function gatewayEnrolled(): boolean {
  return fs.existsSync(path.join(gatewayDir(), 'tailscaled.state'));
}

/** Forget this machine's gateway identity. The device must be removed from the tailnet separately. */
export function resetGateway(): void {
  fs.rmSync(gatewayDir(), { recursive: true, force: true });
}

function gatewayHostname(): string {
  const host = os.hostname().split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  return `routlet-${host || 'gateway'}`.slice(0, 63);
}

function connect(): Promise<net.Socket | undefined> {
  return new Promise((resolve) => {
    const socket = net.connect(gatewaySocket());
    socket.once('connect', () => resolve(socket));
    socket.once('error', () => resolve(undefined));
  });
}

function logTail(): string {
  try {
    return fs.readFileSync(gatewayLog(), 'utf8').trim().split('\n').slice(-3).join('\n');
  } catch {
    return '';
  }
}

/**
 * Connect to this machine's gateway, starting it if it is not running. The
 * gateway is a background process shared by every service; it exits on its own
 * after a period with nothing registered.
 */
async function connectGateway(getAuthKey: () => Promise<string>, onLog: Log, signal?: AbortSignal): Promise<net.Socket> {
  const existing = await connect();
  if (existing) return existing;

  fs.mkdirSync(gatewayDir(), { recursive: true, mode: 0o700 });
  const env = { ...process.env };
  delete env.TS_AUTHKEY;
  if (!gatewayEnrolled()) {
    onLog('Adding this machine\'s Routlet gateway to your tailnet (first time only).');
    env.TS_AUTHKEY = await getAuthKey();
  }
  const log = fs.openSync(gatewayLog(), 'a');
  const child = spawn(
    helperPath(),
    ['--mode', 'gateway', '--dir', gatewayDir(), '--socket', gatewaySocket(), '--hostname', gatewayHostname()],
    { detached: true, stdio: ['ignore', log, log], env },
  );
  fs.closeSync(log);
  // A gateway that exits cleanly lost the race to another one starting at the
  // same moment, which is still coming up: keep waiting for its socket. One
  // that exits with an error is not coming back.
  let exitCode: number | null | undefined;
  child.once('exit', (code) => (exitCode = code));
  child.once('error', () => (exitCode = 1));
  child.unref();

  // Joining the tailnet takes a few seconds.
  const deadline = Date.now() + 100_000;
  let failedAt = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new RoutletError('Cancelled.', 'cancelled');
    const socket = await connect();
    if (socket) return socket;
    if (exitCode !== undefined && exitCode !== 0 && !failedAt) failedAt = Date.now();
    if (failedAt && Date.now() - failedAt > 3000) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new RoutletError(
    `The Routlet gateway did not start. Last lines of ${gatewayLog()}:\n${logTail()}`.trim(),
    'gateway_failed',
  );
}

export interface ServiceIngressOptions {
  name: string;
  /** Provides a key to enroll the gateway device. Only called the first time. */
  getAuthKey: () => Promise<string>;
  /** Makes sure the gateway device is approved to host the service. */
  approve: (nodeId: string) => Promise<void>;
  onLog: Log;
  signal?: AbortSignal;
}

/** An https://<name>.<tailnet>.ts.net address, hosted as a Tailscale Service by the gateway. */
export async function startServiceIngress(opts: ServiceIngressOptions): Promise<Ingress> {
  const socket = await connectGateway(opts.getAuthKey, opts.onLog, opts.signal);
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.once('error', () => resolve());
  });
  const send = (message: object) => {
    if (!socket.destroyed) socket.write(JSON.stringify(message) + '\n');
  };
  send({ register: opts.name });
  return negotiate({
    input: socket,
    send,
    // The gateway withdraws the service when its connection closes.
    close: () => socket.destroy(),
    closed,
    closeDetail: logTail,
    onAdvertised: (event) => opts.approve(event.nodeId),
    onLog: opts.onLog,
    timeoutMs: 240_000,
    signal: opts.signal,
  });
}

// ---- staying up ----

export interface KeepAliveOptions {
  name: string;
  /** The ingress that is up now. */
  first: Ingress;
  /** Opens a replacement. Must give up promptly when the signal aborts. */
  open: (signal: AbortSignal) => Promise<Ingress>;
  onLog: Log;
  /** Told when the URL goes offline and when it comes back. */
  onState?: (online: boolean) => void;
}

/** How long a replacement must stay up before it counts as a success. */
const STABLE_MS = 30_000;
/** A pause before reacting, so an ingress dying as part of a shutdown is not "repaired". */
const GRACE_MS = 300;
const MAX_BACKOFF_MS = 30_000;
const REMIND_EVERY_MS = 5 * 60_000;

/**
 * Wrap an ingress so that it is reopened whenever it goes away for a reason
 * other than stop(): the gateway crashing or being restarted, for instance. The
 * app behind it is left running throughout. Retries back off, an ingress that
 * keeps dying straight after coming up is treated as failing, and a prolonged
 * outage is reported periodically instead of once.
 */
export function keepAlive(opts: KeepAliveOptions): Ingress & { quiesce(): void } {
  const { name } = opts;
  // The caller's callbacks must never be able to break the repair loop.
  const onLog: Log = (message) => {
    try {
      opts.onLog(message);
    } catch {
      // ignore
    }
  };
  const onState = (online: boolean) => {
    try {
      opts.onState?.(online);
    } catch {
      // ignore
    }
  };
  const abort = new AbortController();
  let current = opts.first;
  let target: number | undefined;
  let stopped = false;
  let closed = false;
  let failures = 0;
  let wake: (() => void) | undefined;
  let resolveExited!: () => void;
  const exited = new Promise<void>((resolve) => (resolveExited = resolve));

  // A sleep that stop() can cut short and that never keeps the process alive.
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const watch = (ingress: Ingress, since: number) => {
    void ingress.exited.then(async () => {
      if (stopped) return;
      if (Date.now() - since >= STABLE_MS) failures = 0;
      await sleep(GRACE_MS);
      if (stopped) return;

      onState(false);
      onLog(`The URL for "${name}" went offline. Reconnecting; the app keeps running.`);
      let lastReminder = 0;
      while (!stopped) {
        if (failures > 0) await sleep(Math.min(MAX_BACKOFF_MS, 500 * 2 ** failures));
        if (stopped) return;
        try {
          const next = await opts.open(abort.signal);
          if (stopped) return next.stop();
          if (target !== undefined) next.setTarget(target);
          current = next;
          // Provisional: cleared only if this one stays up for STABLE_MS.
          failures++;
          onState(true);
          onLog(`${name} is back at ${next.url}`);
          return watch(next, Date.now());
        } catch (err) {
          if (stopped) return;
          failures++;
          if (Date.now() - lastReminder >= REMIND_EVERY_MS) {
            lastReminder = Date.now();
            const why = err instanceof Error ? err.message : String(err);
            onLog(`Cannot restore the URL for "${name}" yet: ${why}\nThe app is still running. Routlet will keep trying.`);
          }
        }
      }
    });
  };
  watch(current, Date.now());

  return {
    get url() {
      return current.url;
    },
    get hostname() {
      return current.hostname;
    },
    get hostId() {
      return current.hostId;
    },
    setTarget(port) {
      target = port;
      current.setTarget(port);
    },
    /** Stop repairing, but leave the current ingress up. Used while the app shuts down. */
    quiesce() {
      if (stopped) return;
      stopped = true;
      abort.abort();
      wake?.();
    },
    stop() {
      this.quiesce();
      if (closed) return;
      closed = true;
      current.stop();
      resolveExited();
    },
    exited,
  };
}
