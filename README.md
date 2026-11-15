# Routlet

**A stable private URL for every dev server.**

```diff
- http://devbox.<tailnet>.ts.net:8443     # which app was that again?
+ https://api.<tailnet>.ts.net            # always the API, from any of your devices
```

Routlet starts your app, picks its port, and gives it an HTTPS address on your
[Tailscale](https://tailscale.com) network that works from any of your devices and never changes:

```bash
routlet run --name api npm run dev
# routlet: api is live at https://api.<tailnet>.ts.net
```

Your app needs no changes: no dependency, no config file, no code. Run it from outside the project,
or put the command in the project's own scripts.

> Status: pre-release, Tailscale only. The process, port, proxy, and registry layers are covered by
> automated tests. The Tailscale path has been checked by hand on a real tailnet but has no automated
> tests yet.

## Why not `tailscale serve`, or Portless?

`tailscale serve` and [Portless](https://portless.sh)'s `--tailscale` option both
publish apps under the *machine's* name, so every app after the first gets a port
(`devbox.<tailnet>.ts.net:8443`), and which port depends on what started first. If that is fine for
you, they need less setup than Routlet.

Routlet is for when each service should have its own permanent address: so a frontend can be
configured with the API's URL once, an agent can be told where a service lives, and two apps never
share cookies because they share a hostname. It does this with
[Tailscale Services](https://tailscale.com/docs/features/tailscale-services), and automates the parts
of that feature you would otherwise do by hand for every service.

## Install

```bash
npm install -g @summitml/routlet
```

Requires Node.js 24 or later, on macOS or Linux.

## One-time Tailscale setup

In the Tailscale admin console:

1. **Enable HTTPS certificates** (DNS page). MagicDNS must be on too.
2. **Create a tag for Routlet.** In the policy file, add:
   ```json
   "tagOwners": { "tag:routlet": ["autogroup:admin"] },
   ```
3. **Create an OAuth client** (Settings → Trust credentials) with **write** access to these three
   scopes, each limited to `tag:routlet`:
   - General → **Services**
   - Devices → **Core**
   - Keys → **Auth Keys**
4. **Save the client secret** (it starts with `tskey-client-`). Copy it, then run:
   ```bash
   routlet auth
   ```
   and paste it at the prompt. It is stored in your system keychain.

5. **Recommended: stop tagged devices from starting connections.** A new tailnet's policy lets every
   device reach every other one. Routlet's gateway only ever receives connections, so you can limit
   who may start them to devices that belong to a person. In the policy file, change the default rule
   ```json
   {"src": ["*"], "dst": ["*"], "ip": ["*"]},
   ```
   to
   ```json
   {"src": ["autogroup:member"], "dst": ["*"], "ip": ["*"]},
   ```
   Then, if the secret were ever stolen, a device added with it could not reach your machines. This
   applies to every tagged device on the tailnet, so skip it or adapt it if you have tagged servers
   that need to connect out.

Run `routlet setup` to check steps 1 to 4; it reports what is missing and where to fix it.

The credential can only create and manage things carrying `tag:routlet`; it cannot touch
your own devices, users, or policy.

### Where the secret is kept

`routlet auth` stores the secret in your system keychain: macOS Keychain, or the Secret Service on
Linux (needs `secret-tool`). It is not written to a file. `routlet auth --clear` removes it.

On a machine with no keychain, such as a server, provide it in the `ROUTLET_TS_KEY` environment
variable instead. That variable also takes priority when both are present.

## Using it in a shared repo

Routlet can sit in a project's own scripts:

```json
"dev": "routlet run --name my-app vite dev"
```

On a machine with the Tailscale setup above, that gives a tailnet URL. On a machine without it, the
same command falls back to a fixed `http://127.0.0.1:<port>` URL and says so, so contributors who
don't use Tailscale are not blocked.

## Commands

```bash
routlet run --name <name> [options] <command...>   # start an app under a stable URL
routlet list [--json]                              # all services
routlet inspect <name> [--json]                    # one service in detail
routlet url <name>                                 # just the URL, for scripts and agents
routlet stop <name>                                # stop a running service
routlet rm <name>                                  # forget a service and free its name
routlet setup                                      # check the Tailscale setup and say what is missing
routlet auth                                       # save the Tailscale OAuth client secret
```

Options for `run`:

| Option | Meaning |
|---|---|
| `--env KEY=VALUE` | Set an environment variable for the app. Repeatable. |
| `--env KEY=@name` | Set it to another service's URL. `@self` is this service's own URL. |
| `--ingress local` | Skip Tailscale and use a fixed `http://127.0.0.1:<port>` URL instead. |
| `--ingress tailscale` | Require a tailnet URL, and fail if Tailscale is not set up. |
| `--port <n>` | Use this app port instead of a free one. |
| `--cwd <dir>` | Directory to run the command in. |
| `--replace` | Take over a name that is running or owned elsewhere. |

Routlet's options go before your command. If your command needs a flag that Routlet also has, put
`--` in front of the command: `routlet run --name api -- serve --port 8080`.

### Wiring services together

Apps find each other through the environment variables they already read:

```bash
routlet run --name api npm run dev
routlet run --name web --env VITE_API_URL=@api npm run dev
```

A referenced service does not need to have run yet: its URL is predictable.

## Node.js API

```js
import { run, list, inspect, url, stop, remove } from '@summitml/routlet';

const api = await run({ name: 'api', command: ['npm', 'run', 'dev'], cwd: '/path/to/api' });
const web = await run({
  name: 'web',
  command: ['npm', 'run', 'dev'],
  cwd: '/path/to/web',
  urlEnv: { VITE_API_URL: 'api' },
});

console.log(web.url, web.port);
await web.stop();
```

`run` resolves once the app is listening and reachable through its URL. Errors are `RoutletError`s
with a `code` such as `already_running`, `name_owned`, `name_conflict`, or `app_exited`.

## How it works

- **Ports.** Routlet picks a free port and passes it as `PORT`. Vite and Astro ignore `PORT`, so their
  dev commands also get `--port <n> --strictPort` appended. If an app picks its own port anyway,
  Routlet finds it by looking at what the app's process tree is listening on.
- **The gateway.** The first `routlet run` on a machine starts a small background process, the
  gateway. It joins your tailnet once as a single tagged device (`routlet-<machine>`) and is shared by
  every service on that machine. It exits on its own about ten minutes after the last service stops
  (`ROUTLET_GATEWAY_IDLE_SECONDS` changes that).
- **Services.** For each name, Routlet defines a Tailscale Service through the API, has the gateway
  host it, and approves the gateway as its host. The gateway terminates HTTPS and reverse-proxies to
  the app on localhost, including WebSockets, with the original `Host` header preserved.
- **Names.** A name belongs to the directory that first used it. A second run of a live name, a
  different directory using the name, a name that is already a device on the tailnet, or a service
  being served from another machine all fail with an explicit error. Routlet never falls back to a
  different URL.
- **State.** Everything lives in `~/.local/state/routlet/`, wherever the command is run from. The
  Tailscale secret is in the system keychain.

## Things to know

- **The URL is `<name>.<tailnet>.ts.net`.** You choose the first part. The tailnet name comes from
  Tailscale; custom domains are not supported.
- **One device, many services.** Routlet adds one device per machine to your tailnet, however many
  services run there. Services are listed on the admin console's Services page.
- **Service limits are Tailscale's.** Tailscale has said plans include up to 10 services, with more
  available on request. Check your plan if you expect to run more.
- **First start of a new name takes up to a minute** while its HTTPS certificate is issued. Later
  starts take a couple of seconds.
- **Names are public.** Each service gets its own certificate, which makes its hostname visible in
  public Certificate Transparency logs. Don't put secrets in service names.
- **A stopped service is unreachable**, not a "not running" page. The name stays reserved until
  `routlet rm`.
- **Everyone your tailnet policy allows can reach a service.** With the default allow-all policy that
  is every device on the tailnet.
- **One name, one port.** `routlet run` wraps a single server. In a monorepo where one command starts
  several, put `routlet run` in each app's own dev script instead of around the task runner.

## Development

Building from source needs Go as well as Node.js, for the helper binary:

```bash
npm install
npm run build && npm run build:helper
npm test
npm link            # optional: use this checkout as the global `routlet`
```

Tests use the `local` ingress, so they need no Tailscale account. The gateway logs to
`~/.local/state/routlet/gateway.log`; set `ROUTLET_DEBUG=1` before it starts for verbose output.

### Releasing

The helper binary ships as one small package per platform (`@summitml/routlet-darwin-arm64` and so
on), listed as optional dependencies of the main package so npm installs only the matching one.

```bash
npm run build:packages     # cross-compile every platform's helper into npm/
```

To release, set the same new version in `version` and in every `optionalDependencies` entry of
`package.json`, commit, and push a tag named `v<version>`. The Release workflow tests, builds, and
publishes the platform packages followed by the main package.
