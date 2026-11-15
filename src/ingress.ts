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
}

/** Drive the helper protocol until the URL is ready. */
function negotiate(channel: Channel): Promise<Ingress> {
  return new Promise<Ingress>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.close();
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new RoutletError('Timed out waiting for the URL to come up.', 'ingress_timeout')),
      channel.timeoutMs,
    );
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
          Promise.resolve(channel.onAdvertised?.(event)).then(
            () => channel.send({ prefetch: true }),
            (err) => fail(err),
          );
          break;
        case 'ready':
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            url: event.url,
            hostname: event.hostname,
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
export function startLocalIngress(listen: string, onLog: Log): Promise<Ingress> {
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
    // Closing stdin tells the helper to exit; the kill covers a helper that is stuck.
    close: () => {
      child.stdin.end();
      child.kill('SIGTERM');
    },
    closed,
    closeDetail: () => stderr.join('\n'),
    onLog,
    timeoutMs: 15_000,
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
async function connectGateway(getAuthKey: () => Promise<string>, onLog: Log): Promise<net.Socket> {
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
  let exited = false;
  child.once('exit', () => (exited = true));
  child.once('error', () => (exited = true));
  child.unref();

  // Joining the tailnet takes a few seconds. If another run started a gateway at
  // the same moment, ours exits and we connect to theirs.
  const deadline = Date.now() + 100_000;
  let exitedAt = 0;
  while (Date.now() < deadline) {
    const socket = await connect();
    if (socket) return socket;
    if (exited && !exitedAt) exitedAt = Date.now();
    if (exitedAt && Date.now() - exitedAt > 3000) break;
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
}

/** An https://<name>.<tailnet>.ts.net address, hosted as a Tailscale Service by the gateway. */
export async function startServiceIngress(opts: ServiceIngressOptions): Promise<Ingress> {
  const socket = await connectGateway(opts.getAuthKey, opts.onLog);
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
  });
}
