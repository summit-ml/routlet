import { execFile } from 'node:child_process';
import net from 'node:net';
import { isAlive, RoutletError } from './registry.ts';

/** Ask the OS for a currently free localhost port. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function tryConnect(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** True if something accepts connections on the port over IPv4 or IPv6 loopback. */
export async function isListening(port: number): Promise<boolean> {
  const results = await Promise.all([tryConnect(port, '127.0.0.1'), tryConnect(port, '::1')]);
  return results.some(Boolean);
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8' }, (_err, stdout) => resolve(stdout ?? ''));
  });
}

/** PIDs of a process and all of its descendants. */
export async function processTree(rootPid: number): Promise<number[]> {
  const out = await exec('ps', ['-axo', 'pid=,ppid=']);
  const children = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || Number.isNaN(ppid)) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)!.push(pid);
  }
  const tree: number[] = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift()!;
    tree.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return tree;
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/**
 * Stop a process and all of its descendants: SIGTERM, then SIGKILL for anything
 * still alive after the grace period. Resolves once they are all gone.
 */
export async function terminateTree(rootPid: number, graceMs = 5000): Promise<void> {
  // Capture the tree first: once the root dies its children are re-parented and
  // can no longer be found by walking down from it.
  const tree = (await processTree(rootPid)).reverse();
  signalAll(tree, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!tree.some(isAlive)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  signalAll(tree.filter(isAlive), 'SIGKILL');
}

/** TCP ports the given processes are listening on (requires `lsof`; empty if unavailable). */
export async function listeningPorts(pids: number[]): Promise<number[]> {
  if (!pids.length) return [];
  const out = await exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(','), '-Fn']);
  const ports = new Set<number>();
  for (const line of out.split('\n')) {
    if (!line.startsWith('n')) continue;
    const port = Number(line.slice(line.lastIndexOf(':') + 1));
    if (port > 0) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

export interface WaitForPortOptions {
  /** Port the app was asked to use. */
  assigned: number;
  /** Root PID of the app, used to find the real port if it ignored the request. */
  rootPid: number;
  timeoutMs: number;
  /** Rejects the wait early, for example when the app exits. */
  abort: Promise<never>;
}

/**
 * Wait until the app is listening and return the port it actually chose.
 * Apps that honor the assigned port are detected by connecting to it. Apps that
 * ignore it are detected by inspecting the listening sockets of the process tree.
 */
export async function waitForPort(opts: WaitForPortOptions): Promise<number> {
  const deadline = Date.now() + opts.timeoutMs;
  let candidate: number | undefined;
  let candidateSeen = 0;
  // Stop polling as soon as the wait is abandoned (for example, the app exited).
  let abandoned = false;
  opts.abort.catch(() => {
    abandoned = true;
  });

  const poll = async (): Promise<number> => {
    for (let tick = 0; Date.now() < deadline && !abandoned; tick++) {
      if (await isListening(opts.assigned)) return opts.assigned;
      if (tick % 4 === 3) {
        const ports = await listeningPorts(await processTree(opts.rootPid));
        const other = ports.find((p) => p !== opts.assigned);
        // Require the same port on consecutive checks so a transient socket is not adopted.
        if (other !== undefined && other === candidate) {
          if (++candidateSeen >= 2 && (await isListening(other))) return other;
        } else {
          candidate = other;
          candidateSeen = 0;
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new RoutletError(
      `The app did not start listening within ${Math.round(opts.timeoutMs / 1000)}s.`,
      'port_timeout',
    );
  };

  return Promise.race([poll(), opts.abort]);
}
