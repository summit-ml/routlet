import { execFile } from 'node:child_process';
import { helperPath } from './ingress.ts';
import { readSecret } from './secret-store.ts';
import {
  defineService,
  deleteAuthKey,
  deleteService,
  listDevices,
  listServices,
  mintCheckKey,
  routletTag,
} from './tailscale-api.ts';

export interface SetupCheck {
  name: string;
  /** 'ok', 'fail', or 'unknown' when the check could not be performed. */
  status: 'ok' | 'fail' | 'unknown';
  /** What was found, or what to do about it. */
  detail: string;
}

const CONSOLE = 'https://login.tailscale.com/admin';
const CHECK_SERVICE = 'routlet-setup-check';

function tailscaleStatus(): Promise<any | undefined> {
  return new Promise((resolve) => {
    execFile('tailscale', ['status', '--json'], { encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve(undefined);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(undefined);
      }
    });
  });
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Check everything Routlet needs for tailnet URLs and say what to do about
 * anything missing. Verifying write access means briefly creating and deleting
 * a test service and a 60-second auth key.
 */
export async function setup(): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];
  const add = (name: string, status: SetupCheck['status'], detail: string) => checks.push({ name, status, detail });

  try {
    add('Helper binary', 'ok', helperPath());
  } catch (err) {
    add('Helper binary', 'fail', message(err));
  }

  const status = await tailscaleStatus();
  if (!status) {
    add('Tailscale on this machine', 'unknown', 'The tailscale command was not found, so this machine may not be able to open its own service URLs.');
  } else if (status.BackendState !== 'Running') {
    add('Tailscale on this machine', 'fail', `Tailscale is installed but not connected (${status.BackendState}). Connect it to open service URLs from this machine.`);
  } else {
    add('Tailscale on this machine', 'ok', `Connected to ${status.CurrentTailnet?.Name ?? 'your tailnet'}`);
    add(
      'HTTPS certificates',
      status.CertDomains?.length ? 'ok' : 'fail',
      status.CertDomains?.length ? 'Enabled' : `Enable HTTPS certificates at ${CONSOLE}/dns`,
    );
  }

  let stored: ReturnType<typeof readSecret>;
  try {
    stored = readSecret();
  } catch (err) {
    add('OAuth client secret', 'fail', message(err));
    return checks;
  }
  if (!stored) {
    add(
      'OAuth client secret',
      'fail',
      `Create an OAuth client at ${CONSOLE}/settings/trust-credentials with write access to Services, ` +
        `Devices: Core, and Auth Keys (each limited to ${routletTag()}), then run "routlet auth" to save its secret.`,
    );
    return checks;
  }
  const secret = stored.secret;
  add(
    'OAuth client secret',
    'ok',
    stored.source === 'env' ? 'Provided by the ROUTLET_TS_KEY environment variable' : 'Stored in the system keychain',
  );

  const scopeFix = (scope: string) =>
    `The OAuth client needs write access to ${scope}, limited to ${routletTag()}. Recreate it at ${CONSOLE}/settings/trust-credentials`;

  try {
    await listDevices(secret);
    add('Access to devices', 'ok', 'Can read devices');
  } catch (err) {
    add('Access to devices', 'fail', message(err).includes('(403)') ? scopeFix('Devices: Core') : message(err));
  }

  try {
    const id = await mintCheckKey(secret);
    await deleteAuthKey(secret, id).catch(() => {});
    add(`Auth keys for ${routletTag()}`, 'ok', 'Can create tagged auth keys');
  } catch (err) {
    const text = message(err);
    add(
      `Auth keys for ${routletTag()}`,
      'fail',
      /tag/i.test(text) && !text.includes('(403)')
        ? `Add "tagOwners": { "${routletTag()}": ["autogroup:admin"] } to the policy file at ${CONSOLE}/acls/file, and give the OAuth client that tag.`
        : scopeFix('Auth Keys'),
    );
  }

  try {
    await listServices(secret);
    await defineService(secret, CHECK_SERVICE);
    await deleteService(secret, CHECK_SERVICE);
    add('Access to services', 'ok', 'Can define and delete services');
  } catch (err) {
    // Tailscale answers 404, not 403, when the client lacks the Services scope.
    add('Access to services', 'fail', /\((403|404)\)/.test(message(err)) ? scopeFix('Services') : message(err));
  }

  return checks;
}
