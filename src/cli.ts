#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  clearSecret,
  inspect,
  list,
  parseSecret,
  remove,
  run,
  setup,
  stop,
  storeSecret,
  url,
  RoutletError,
  type IngressMode,
} from './index.ts';

const HELP = `routlet - a stable private URL for every dev server

Usage:
  routlet run --name <name> [options] <command...>   Start an app under a stable URL
  routlet list [--json]                              Show all services
  routlet inspect <name> [--json]                    Show one service in detail
  routlet url <name>                                 Print a service's URL
  routlet stop <name>                                Stop a running service
  routlet rm <name>                                  Forget a service and free its name
  routlet setup [--json]                             Check the Tailscale setup and say what is missing
  routlet auth [--clear]                             Save the Tailscale OAuth client secret in the system keychain

Options for run:
  --env KEY=VALUE     Set an environment variable for the app (repeatable)
  --env KEY=@name     Set it to another service's URL (@self for this one)
  --ingress <mode>    tailscale (default) or local
  --port <n>          Use this app port instead of a free one
  --cwd <dir>         Directory to run the command in
  --replace           Take over a name that is running or owned elsewhere
`;

const USAGE_RUN = 'Usage: routlet run --name <name> [options] <command...>';

const say = (message: string) => process.stderr.write(`routlet: ${message}\n`);

const OPTIONS_WITH_VALUE = new Set(['--name', '--env', '--ingress', '--port', '--cwd']);

/**
 * Index where the app's command begins: the first word that is not one of
 * Routlet's options. An explicit `--` also marks it, which is how to give the
 * app a flag that Routlet has too (`routlet run --name api -- serve --port 80`).
 */
function findCommandStart(argv: string[]): number {
  const dashes = argv.indexOf('--');
  if (dashes !== -1) return dashes + 1;
  for (let i = 0; i < argv.length; i++) {
    if (OPTIONS_WITH_VALUE.has(argv[i])) i++;
    else if (!argv[i].startsWith('-')) return i;
  }
  return argv.length;
}

async function cmdRun(argv: string[]): Promise<number> {
  const split = findCommandStart(argv);
  if (split >= argv.length) {
    throw new RoutletError(USAGE_RUN, 'usage');
  }
  const { values, positionals } = parseArgs({
    args: argv.slice(0, split).filter((arg) => arg !== '--'),
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      env: { type: 'string', multiple: true },
      ingress: { type: 'string' },
      port: { type: 'string' },
      cwd: { type: 'string' },
      replace: { type: 'boolean' },
    },
  });
  if (!values.name || positionals.length) throw new RoutletError(USAGE_RUN, 'usage');
  if (values.ingress && values.ingress !== 'tailscale' && values.ingress !== 'local') {
    throw new RoutletError('--ingress must be "tailscale" or "local".', 'usage');
  }

  const env: Record<string, string> = {};
  const urlEnv: Record<string, string> = {};
  for (const pair of values.env ?? []) {
    const eq = pair.indexOf('=');
    if (eq < 1) throw new RoutletError(`--env expects KEY=VALUE, got "${pair}".`, 'usage');
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (value.startsWith('@')) urlEnv[key] = value.slice(1);
    else env[key] = value;
  }

  // The app shares this terminal, so Ctrl-C reaches it directly. Routlet only
  // needs to outlive it long enough to clean up.
  let service: Awaited<ReturnType<typeof run>> | undefined;
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    void service?.stop();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);

  service = await run({
    name: values.name,
    command: argv.slice(split),
    cwd: values.cwd,
    env,
    urlEnv,
    ingress: values.ingress as IngressMode | undefined,
    port: values.port ? Number(values.port) : undefined,
    replace: values.replace,
    onLog: say,
    cli: true,
  });
  if (interrupted) void service.stop();
  say(`${service.name} is live at ${service.url} (app port ${service.port})`);
  return service.exited;
}

function cmdList(argv: string[]): number {
  const services = list();
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(services, null, 2) + '\n');
    return 0;
  }
  if (!services.length) {
    say('no services yet');
    return 0;
  }
  const status = (s: (typeof services)[number]) => (!s.running ? 'stopped' : s.urlOffline ? 'running, URL offline' : 'running');
  const rows = services.map((s) => [s.name, status(s), s.url, s.running ? String(s.port ?? '') : '']);
  const header = ['NAME', 'STATUS', 'URL', 'PORT'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  for (const row of [header, ...rows]) {
    process.stdout.write(row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd() + '\n');
  }
  return 0;
}

async function cmdInspect(argv: string[]): Promise<number> {
  const name = argv.find((a) => !a.startsWith('-'));
  if (!name) throw new RoutletError('Usage: routlet inspect <name>', 'usage');
  const details = await inspect(name);
  if (!details) throw new RoutletError(`Unknown service "${name}".`, 'not_found');
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(details, null, 2) + '\n');
    return 0;
  }
  const lines: Array<[string, string]> = [
    ['name', details.name],
    ['url', details.url],
    [
      'status',
      !details.running
        ? 'stopped'
        : details.urlOffline
          ? 'running, but the URL is offline and being restored'
          : details.healthy
            ? 'running'
            : 'running, not responding',
    ],
    ['ingress', details.ingress],
    ['tailnet', details.approved === undefined ? '' : details.approved ? 'approved to serve' : 'NOT approved to serve (URL is down)'],
    ['app port', details.running ? String(details.port ?? '') : ''],
    ['pid', details.pid ? String(details.pid) : ''],
    ['directory', details.owner],
    ['command', details.command.join(' ')],
    ['last started', details.startedAt ?? ''],
  ];
  for (const [key, value] of lines) if (value) process.stdout.write(`${key.padEnd(13)} ${value}\n`);
  return 0;
}

/** Read the secret from a pipe, or prompt for it without echoing. */
function readSecretInput(): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve) => {
    let text = '';
    if (!stdin.isTTY) {
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => (text += chunk));
      stdin.on('end', () => resolve(text));
      return;
    }
    process.stderr.write('Paste the OAuth client secret (input is hidden), then press Enter: ');
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0003' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          return resolve(ch === '\u0003' ? '' : text);
        }
        text += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function cmdAuth(argv: string[]): Promise<number> {
  if (argv.includes('--clear')) {
    clearSecret();
    say('removed the stored secret');
    return 0;
  }
  const secret = parseSecret(await readSecretInput());
  if (!secret) {
    throw new RoutletError('That is not a Tailscale OAuth client secret. It should start with "tskey-client-".', 'usage');
  }
  storeSecret(secret);
  say('saved to the system keychain');
  say('run "routlet setup" to check it');
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'run':
      return cmdRun(rest);
    case 'list':
    case 'ls':
      return cmdList(rest);
    case 'inspect':
      return cmdInspect(rest);
    case 'url':
      if (!rest[0]) throw new RoutletError('Usage: routlet url <name>', 'usage');
      process.stdout.write(url(rest[0]) + '\n');
      return 0;
    case 'stop':
      if (!rest[0]) throw new RoutletError('Usage: routlet stop <name>', 'usage');
      say((await stop(rest[0])) ? `stopped ${rest[0]}` : `${rest[0]} is not running`);
      return 0;
    case 'rm': {
      if (!rest[0]) throw new RoutletError('Usage: routlet rm <name>', 'usage');
      const result = await remove(rest[0]);
      say(result.serviceDeleted ? `removed ${rest[0]} from this machine and your tailnet` : `removed ${rest[0]}`);
      return 0;
    }
    case 'auth':
      return cmdAuth(rest);
    case 'setup': {
      const checks = await setup();
      if (rest.includes('--json')) {
        process.stdout.write(JSON.stringify(checks, null, 2) + '\n');
      } else {
        const mark = { ok: '✓', fail: '✗', unknown: '?' };
        for (const check of checks) process.stdout.write(`${mark[check.status]} ${check.name}: ${check.detail}\n`);
        const failed = checks.filter((c) => c.status === 'fail').length;
        process.stdout.write(failed ? `\n${failed} thing${failed === 1 ? '' : 's'} to fix. Until then, routlet run gives local URLs only.\n` : '\nReady for tailnet URLs.\n');
      }
      return checks.some((c) => c.status === 'fail') ? 1 : 0;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    default:
      throw new RoutletError(`Unknown command "${command}". Run "routlet help".`, 'usage');
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    say(err instanceof RoutletError ? err.message : String(err?.stack ?? err));
    process.exit(err instanceof RoutletError && err.code === 'usage' ? 2 : 1);
  },
);
