import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

// State must be isolated before the library reads it.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routlet-test-'));
process.env.ROUTLET_STATE_DIR = stateDir;
// No Tailscale credential is visible to the tests, whatever the developer has set up.
delete process.env.ROUTLET_TS_KEY;
process.env.ROUTLET_NO_KEYCHAIN = '1';

const { adaptCommand } = await import('../src/adapt.ts');
const { helperPath } = await import('../src/ingress.ts');
const { validateName, RoutletError } = await import('../src/registry.ts');
const routlet = await import('../src/index.ts');

const fixture = path.resolve(import.meta.dirname, 'fixtures', 'server.mjs');
const app = ['node', fixture];
const started: Array<{ stop(): Promise<void> }> = [];

/** Signal a helper started by this test run, and never anyone else's. */
function signalHelper(signal: string, pattern: string): void {
  spawnSync('pkill', [signal, '-P', String(process.pid), '-f', pattern]);
}

async function start(name: string, extra: Partial<Parameters<typeof routlet.run>[0]> = {}) {
  const service = await routlet.run({ name, command: app, ingress: 'local', stdio: 'ignore', ...extra });
  started.push(service);
  return service;
}

before(() => {
  helperPath(); // fails with a clear message if the helper has not been built
});

after(async () => {
  await Promise.all(started.map((s) => s.stop()));
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('names must be DNS labels', () => {
  assert.equal(validateName('api-workflow-portal'), 'api-workflow-portal');
  for (const bad of ['', 'Has-Caps', 'under_score', '-lead', 'trail-', 'a.b', 'x'.repeat(64)]) {
    assert.throws(() => validateName(bad), RoutletError, bad);
  }
});

test('port flags are added only where the framework needs them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routlet-adapt-'));
  const write = (scripts: Record<string, string>) =>
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts }));

  write({ dev: 'vite dev', api: 'node server.js', both: 'vite && node x.js', fixed: 'vite --port 3000', build: 'vite build', open: 'vite --open' });
  assert.deepEqual(adaptCommand(['npm', 'run', 'build'], 4100, dir), ['npm', 'run', 'build']);
  assert.deepEqual(adaptCommand(['npm', 'run', 'open'], 4100, dir), ['npm', 'run', 'open', '--', '--port', '4100', '--strictPort']);
  assert.deepEqual(adaptCommand(['npx', 'vite', 'build'], 4100, dir), ['npx', 'vite', 'build']);
  assert.deepEqual(adaptCommand(['npm', 'run', 'dev'], 4100, dir), ['npm', 'run', 'dev', '--', '--port', '4100', '--strictPort']);
  assert.deepEqual(adaptCommand(['pnpm', 'dev'], 4100, dir), ['pnpm', 'dev', '--port', '4100', '--strictPort']);
  assert.deepEqual(adaptCommand(['npx', 'vite'], 4100, dir), ['npx', 'vite', '--port', '4100', '--strictPort']);
  // Left alone: reads PORT itself, compound script, or already has a port.
  assert.deepEqual(adaptCommand(['npm', 'run', 'api'], 4100, dir), ['npm', 'run', 'api']);
  assert.deepEqual(adaptCommand(['npm', 'run', 'both'], 4100, dir), ['npm', 'run', 'both']);
  assert.deepEqual(adaptCommand(['npm', 'run', 'fixed'], 4100, dir), ['npm', 'run', 'fixed']);
  fs.rmSync(dir, { recursive: true });
});

test('two services run at once on different ports, each behind its own URL', async () => {
  const web = await start('web', { env: { LABEL: 'web' } });
  const api = await start('api', { env: { LABEL: 'api' } });
  assert.notEqual(web.port, api.port);
  assert.notEqual(web.url, api.url);

  const viaWeb = await (await fetch(`${web.url}/hello?x=1`)).json();
  const viaApi = await (await fetch(api.url)).json();
  assert.equal(viaWeb.label, 'web');
  assert.equal(viaWeb.path, '/hello?x=1');
  assert.equal(viaWeb.port, web.port);
  assert.equal(viaApi.label, 'api');
  // The app sees the public hostname, not localhost:<app port>.
  assert.equal(viaWeb.host, new URL(web.url).host);

  const listed = routlet.list();
  assert.deepEqual(listed.map((s) => [s.name, s.running]), [['api', true], ['web', true]]);
  assert.equal(routlet.url('web'), web.url);
  assert.equal((await routlet.inspect('web'))?.healthy, true);
});

test('WebSocket upgrades pass through', async () => {
  const service = await start('sockets');
  const { port } = new URL(service.url);
  const echoed = await new Promise<string>((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
    req.on('upgrade', (_res, socket) => {
      socket.once('data', (data) => {
        socket.destroy();
        resolve(data.toString());
      });
      socket.write('ping');
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(echoed, 'ping');
});

test('an app that ignores PORT is found on the port it actually chose', async () => {
  const service = await start('stubborn', { env: { IGNORE_PORT: '1' } });
  const seen = await (await fetch(service.url)).json();
  assert.equal(seen.port, service.port);
});

test('the URL survives a restart and stays known while stopped', async () => {
  const first = await start('restart');
  const firstUrl = first.url;
  await first.stop();
  assert.equal(await first.exited, 128 + os.constants.signals.SIGTERM);
  assert.equal(routlet.list().find((s) => s.name === 'restart')?.running, false);
  assert.equal(routlet.url('restart'), firstUrl);

  const second = await start('restart');
  assert.equal(second.url, firstUrl);
  assert.equal((await fetch(second.url)).status, 200);
});

test('services receive each other\'s URLs through their own env vars', async () => {
  const backend = await start('backend');
  const frontend = await start('frontend', { urlEnv: { API_URL: 'backend', SELF_URL: 'self' } });
  const seen = await (await fetch(frontend.url)).json();
  assert.equal(seen.apiUrl, backend.url);
  assert.equal(seen.selfUrl, frontend.url);
  // The app can really reach the other service at that URL.
  assert.equal((await fetch(seen.apiUrl)).status, 200);
  await assert.rejects(start('lost', { urlEnv: { API_URL: 'never-ran' } }), { code: 'not_found' });
});

test('name collisions fail instead of silently sharing or renaming', async () => {
  await start('taken');
  await assert.rejects(start('taken'), { code: 'already_running' });
  await assert.rejects(start('taken', { cwd: os.tmpdir() }), { code: 'name_owned' });

  // An explicit takeover is allowed and keeps the URL.
  const before = routlet.url('taken');
  const replaced = await start('taken', { replace: true });
  assert.equal(replaced.url, before);
});

test('a command that fails to start reports why and leaves nothing behind', async () => {
  await assert.rejects(start('broken', { command: ['node', '-e', 'process.exit(3)'] }), { code: 'app_exited' });
  await assert.rejects(start('missing', { command: ['definitely-not-a-real-binary'] }), { code: 'spawn_failed' });
  assert.equal(routlet.list().some((s) => s.name === 'broken' || s.name === 'missing'), false);
  // The name is free again straight away.
  const retry = await start('broken');
  assert.equal((await fetch(retry.url)).status, 200);
});

test('without a Tailscale credential the default is a local URL, but an explicit request fails', async () => {
  const logs: string[] = [];
  const service = await start('fallback', { ingress: undefined, onLog: (m) => logs.push(m) });
  assert.match(service.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(service.url)).status, 200);
  assert.ok(logs.some((m) => m.includes('only works on this machine')));
  await assert.rejects(start('insists', { ingress: 'tailscale' }), { code: 'no_credentials' });
  assert.equal(routlet.list().some((s) => s.name === 'insists'), false);
});

test('the secret is recognised by its format and can be supplied by environment variable', async () => {
  const store = await import('../src/secret-store.ts');
  const secret = 'tskey-client-kABC123CNTRL-notARealSecret0123456789';
  assert.equal(store.parseSecret(`TS_KEY=${secret}\n`), secret);
  assert.equal(store.parseSecret('tskey-auth-kABC-nope'), undefined);

  assert.equal(store.readSecret(), undefined);
  process.env.ROUTLET_TS_KEY = secret;
  try {
    assert.deepEqual(store.readSecret(), { secret, source: 'env' });
  } finally {
    delete process.env.ROUTLET_TS_KEY;
  }
  // With no keychain there is nowhere to save it, and that is an error, not a silent file.
  assert.throws(() => store.storeSecret(secret), { code: 'no_keychain' });
});

test('the URL comes back by itself if its helper dies, and the app keeps running', async () => {
  // Run once so the service has a fixed port, which makes its helper identifiable.
  const first = await start('resilient');
  const url = first.url;
  await first.stop();

  const logs: string[] = [];
  const service = await start('resilient', { onLog: (m) => logs.push(m) });
  assert.equal(service.url, url);
  const helper = `routlet-helper --mode local --listen ${new URL(url).host}`;
  signalHelper('-9', helper);

  let status = 0;
  for (let i = 0; i < 100 && status !== 200; i++) {
    await new Promise((r) => setTimeout(r, 100));
    status = await fetch(url).then((r) => r.status, () => 0);
  }
  assert.equal(status, 200);
  assert.ok(logs.some((m) => m.includes('went offline')));
  assert.ok(logs.some((m) => m.includes('is back at')));
  // Same app process throughout: it was never restarted.
  assert.equal(routlet.list().find((s) => s.name === 'resilient')?.pid, service.pid);
});

test('a URL that cannot be restored is reported, and stopping does not wait on the retries', async (t) => {
  const first = await start('stuck');
  const url = first.url;
  await first.stop();

  const logs: string[] = [];
  const service = await start('stuck', { onLog: (m) => logs.push(m) });
  const { host, port } = new URL(url);
  const helper = `routlet-helper --mode local --listen ${host}`;

  // Signals a terminal sends on the way out must not take the helper down.
  signalHelper('-HUP', helper);
  signalHelper('-TERM', helper);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await fetch(url)).status, 200);
  assert.equal(logs.some((m) => m.includes('went offline')), false);

  // Kill it for real and take its port, so it cannot come back.
  signalHelper('-9', helper);
  const blocker = net.createServer();
  t.after(() => blocker.close());
  await new Promise<void>((resolve, reject) => {
    const tryListen = (attempt: number) => {
      blocker.once('error', (err) => (attempt < 50 ? setTimeout(() => tryListen(attempt + 1), 5) : reject(err)));
      blocker.listen(Number(port), '127.0.0.1', () => resolve());
    };
    tryListen(0);
  });

  for (let i = 0; i < 60 && !logs.some((m) => m.includes('Cannot restore')); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(logs.some((m) => m.includes('Cannot restore')), logs.join(' | '));
  const info = routlet.list().find((s) => s.name === 'stuck');
  assert.equal(info?.running, true);
  assert.equal(info?.urlOffline, true);

  const started = Date.now();
  await service.stop();
  assert.ok(Date.now() - started < 3000, `stop took ${Date.now() - started}ms`);
});

test('the URL stays up until the app has finished shutting down', async () => {
  const service = await start('graceful', { env: { SLOW_EXIT: '1200' } });
  const stopping = service.stop();
  await new Promise((r) => setTimeout(r, 400));
  // Still answering while the app is on its way out.
  assert.equal(await fetch(service.url).then((r) => r.status, () => 0), 200);
  await stopping;
  assert.equal(await fetch(service.url).then((r) => r.status, () => 0), 0);
});

test('a helper that dies while a new app is still starting comes back on the same port', async () => {
  const logs: string[] = [];
  const starting = start('early', { env: { SLOW_START: '2000' }, onLog: (m) => logs.push(m) });
  // The helper is up almost at once; the app is not listening for two seconds.
  await new Promise((r) => setTimeout(r, 700));
  // Helpers started by this test run that are still waiting for a port. Every
  // earlier service is on a fixed port by now or has stopped, so the only one
  // left listening on port 0 with no recorded service is this one's.
  const known = new Set(routlet.list().map((s) => new URL(s.url).port));
  const mine = spawnSync('pgrep', ['-P', String(process.pid), '-f', 'routlet-helper --mode local'], { encoding: 'utf8' })
    .stdout.trim().split('\n').filter(Boolean).map(Number);
  const target = mine.find((pid) => {
    const ports = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid), '-Fn'], { encoding: 'utf8' }).stdout;
    const port = ports.match(/:(\d+)\s*$/m)?.[1];
    return port !== undefined && !known.has(port);
  });
  assert.ok(target, 'could not identify the starting service\'s helper');
  process.kill(target, 'SIGKILL');

  const service = await starting;
  for (let i = 0; i < 50 && !logs.some((m) => m.includes('is back at')); i++) await new Promise((r) => setTimeout(r, 100));
  const seen = await (await fetch(service.url)).json();
  // The app was told one URL at launch; that is still the URL that works.
  assert.equal(seen.host, new URL(service.url).host);
  assert.ok(logs.some((m) => m.includes(`is back at ${service.url}`)), logs.join(' | '));
});

test('the CLI runs a service that another process can list, stop, and remove', async () => {
  const cli = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
  const proc = spawn('node', [cli, 'run', '--name', 'from-cli', '--ingress', 'local', ...app], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exit = new Promise<number | null>((resolve) => proc.once('exit', resolve));
  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.includes('is live at')) resolve();
    });
    void exit.then((code) => reject(new Error(`CLI exited early (${code}): ${stderr}`)));
  });

  const info = routlet.list().find((s) => s.name === 'from-cli');
  assert.equal(info?.running, true);
  assert.equal((await fetch(info!.url)).status, 200);

  assert.equal(await routlet.stop('from-cli'), true);
  assert.equal(await exit, 128 + os.constants.signals.SIGTERM);
  assert.equal(routlet.list().find((s) => s.name === 'from-cli')?.running, false);
  assert.equal(await routlet.stop('from-cli'), false);

  await routlet.remove('from-cli');
  assert.equal(await routlet.inspect('from-cli'), undefined);
});
