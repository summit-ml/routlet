import { RoutletError } from './registry.ts';
import { readSecret } from './secret-store.ts';

const API = 'https://api.tailscale.com/api/v2';
/** No Tailscale API call should hang a command on a dead network. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Tag carried by Routlet's gateway device and by every service it defines. */
export function routletTag(): string {
  return process.env.ROUTLET_TS_TAG ?? 'tag:routlet';
}

/** The Tailscale OAuth client secret. Throws a setup hint if none is stored. */
export function loadSecret(): string {
  const found = readSecret();
  if (!found) {
    throw new RoutletError(
      'No Tailscale OAuth client secret found. Run "routlet setup" to see what is needed, ' +
        'then "routlet auth" to save the secret. Or use --ingress local.',
      'no_credentials',
    );
  }
  return found.secret;
}

/** True if a Tailscale OAuth client secret is configured. Throws if the keychain cannot be read. */
export function hasSecret(): boolean {
  // A keychain that cannot be read is an error, not "no secret": let it through.
  return readSecret() !== undefined;
}

/** fetch, with a timeout, reporting a dead or slow network as a RoutletError. */
async function call(url: string, init: RequestInit, what: string): Promise<{ res: Response; text: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return { res, text: await res.text() };
  } catch (err) {
    const why = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : err instanceof Error ? err.message : String(err);
    throw new RoutletError(`Could not reach Tailscale while ${what} (${why}). Check your internet connection.`, 'tailscale_unreachable');
  }
}

const parse = (text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

async function request(secret: string, method: string, route: string, what: string, body?: unknown): Promise<any> {
  const token = await accessToken(secret);
  const { res, text } = await call(
    `${API}${route}`,
    {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    what,
  );
  if (res.status === 404 && method === 'GET') return undefined;
  if (!res.ok) {
    const hint =
      // A missing scope is reported as 403, or as 404 for services.
      res.status === 403 || res.status === 404
        ? ' The OAuth client needs write access to Services, Devices: Core, and Auth Keys.'
        : '';
    throw new RoutletError(`Tailscale API: ${what} failed (${res.status}). ${text}${hint}`.trim(), 'tailscale_api');
  }
  return parse(text);
}

let cachedToken: { secret: string; token: string; expires: number } | undefined;

/** Exchange the long-lived OAuth client secret for a short-lived access token. */
async function accessToken(secret: string): Promise<string> {
  if (cachedToken?.secret === secret && cachedToken.expires > Date.now()) return cachedToken.token;
  // The client ID is the third segment of the secret: tskey-client-<id>-<secret>.
  const clientId = secret.split('-')[2] ?? '';
  const { res, text } = await call(
    `${API}/oauth/token`,
    { method: 'POST', body: new URLSearchParams({ client_id: clientId, client_secret: secret }) },
    'signing in',
  );
  const json: any = parse(text) ?? {};
  if (!res.ok || !json.access_token) {
    throw new RoutletError(
      `Tailscale rejected the OAuth client secret (${res.status}). Save a valid one with "routlet auth".`,
      'tailscale_api',
    );
  }
  cachedToken = { secret, token: json.access_token, expires: Date.now() + 30 * 60_000 };
  return json.access_token;
}

/** Create a single-use, pre-approved, tagged key. Used once, to enroll the gateway device. */
export async function mintAuthKey(secret: string, description: string): Promise<string> {
  const json = await request(secret, 'POST', '/tailnet/-/keys', 'creating an auth key', {
    capabilities: {
      devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: [routletTag()] } },
    },
    expirySeconds: 600,
    description: description.slice(0, 50),
  });
  return json.key;
}

export interface Device {
  id: string;
  nodeId: string;
  /** Fully qualified MagicDNS name. */
  name: string;
  tags?: string[];
}

/** Devices on the tailnet whose MagicDNS name is `<label>.<tailnet>`. */
export async function findDevices(secret: string, label: string): Promise<Device[]> {
  const json = await request(secret, 'GET', '/tailnet/-/devices', 'listing devices');
  return ((json?.devices ?? []) as Device[]).filter((d) => d.name?.split('.')[0] === label);
}

export interface ServiceDefinition {
  name: string;
  addrs?: string[];
  ports?: string[];
  tags?: string[];
  comment?: string;
}

const servicePath = (name: string) => `/tailnet/-/services/${encodeURIComponent(`svc:${name}`)}`;

export function getService(secret: string, name: string): Promise<ServiceDefinition | undefined> {
  return request(secret, 'GET', servicePath(name), 'reading a service');
}

/** Define the service on the tailnet. Its hostname and address exist from this point on. */
export function defineService(secret: string, name: string): Promise<ServiceDefinition> {
  return request(secret, 'PUT', servicePath(name), 'defining a service', {
    name: `svc:${name}`,
    ports: ['tcp:443'],
    tags: [routletTag()],
    comment: 'Managed by Routlet',
  });
}

export async function deleteService(secret: string, name: string): Promise<void> {
  await request(secret, 'DELETE', servicePath(name), 'deleting a service');
}

export interface ServiceHost {
  nodeId: string;
  /** 'not-approved', 'approved:manual', or 'approved:auto'. */
  approvalLevel: string;
}

/** True if Tailscale lets this host serve the service. */
export const isApproved = (host: ServiceHost): boolean => host.approvalLevel.startsWith('approved');

/** Devices currently offering to host the service. */
export async function serviceHosts(secret: string, name: string): Promise<ServiceHost[]> {
  const json = await request(secret, 'GET', `${servicePath(name)}/devices`, 'listing service hosts');
  return (json?.hosts ?? []) as ServiceHost[];
}

export async function approveHost(secret: string, name: string, nodeId: string): Promise<void> {
  await request(
    secret,
    'POST',
    `${servicePath(name)}/device/${encodeURIComponent(nodeId)}/approved`,
    'approving a service host',
    { approved: true },
  );
}

/** Delete an auth key by its ID. */
export async function deleteAuthKey(secret: string, id: string): Promise<void> {
  await request(secret, 'DELETE', `/tailnet/-/keys/${encodeURIComponent(id)}`, 'deleting an auth key');
}

/** Create a short-lived tagged auth key and return its ID. Used to verify the credential's scope and tag. */
export async function mintCheckKey(secret: string): Promise<string> {
  const json = await request(secret, 'POST', '/tailnet/-/keys', 'creating an auth key', {
    capabilities: {
      devices: { create: { reusable: false, ephemeral: false, preauthorized: true, tags: [routletTag()] } },
    },
    expirySeconds: 60,
    description: 'routlet setup check',
  });
  return json.id;
}

export async function listServices(secret: string): Promise<ServiceDefinition[]> {
  const json = await request(secret, 'GET', '/tailnet/-/services', 'listing services');
  return (json?.vipServices ?? []) as ServiceDefinition[];
}

export async function listDevices(secret: string): Promise<Device[]> {
  const json = await request(secret, 'GET', '/tailnet/-/devices', 'listing devices');
  return (json?.devices ?? []) as Device[];
}
