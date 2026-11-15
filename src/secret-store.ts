import { spawnSync } from 'node:child_process';
import { RoutletError } from './registry.ts';

// The Tailscale OAuth client secret is kept in the system keychain (macOS
// Keychain, or the Secret Service on Linux) and nowhere else on disk.
// ROUTLET_TS_KEY overrides it, for automation and for machines with no keychain.

const SERVICE = 'routlet';
const ACCOUNT = 'tailscale-oauth';
const SECRET_RE = /tskey-client-[A-Za-z0-9-]+/;

export type SecretSource = 'env' | 'keychain';

/** Pull a well-formed OAuth client secret out of arbitrary text. */
export function parseSecret(text: string): string | undefined {
  return text.match(SECRET_RE)?.[0];
}

function keychainAvailable(): boolean {
  return !process.env.ROUTLET_NO_KEYCHAIN && (process.platform === 'darwin' || process.platform === 'linux');
}

/** Exit status `security` uses for "no such item", as opposed to "could not look". */
const MACOS_ITEM_NOT_FOUND = 44;

/**
 * Look the secret up in the keychain. Returns undefined when there is none.
 * Throws when the keychain exists but cannot be read (typically locked, as in
 * an SSH session), so that case is never mistaken for "no secret saved".
 */
function keychainRead(): string | undefined {
  if (!keychainAvailable()) return undefined;
  const mac = process.platform === 'darwin';
  const result = mac
    ? spawnSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { encoding: 'utf8', timeout: 5000 })
    : spawnSync('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT], { encoding: 'utf8', timeout: 5000 });

  // The keychain tool is not installed: this machine has no keychain to read.
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined;
  if (result.status === 0) return parseSecret(result.stdout ?? '');

  const notFound = mac ? result.status === MACOS_ITEM_NOT_FOUND : !(result.stderr ?? '').trim() && !result.error;
  if (notFound) return undefined;

  throw new RoutletError(
    'The system keychain could not be read, so Routlet cannot get its Tailscale secret. ' +
      (mac
        ? 'It is probably locked, which is normal in an SSH session. Unlock it with:\n' +
          '  security unlock-keychain ~/Library/Keychains/login.keychain-db\n'
        : 'Make sure a keyring is running and unlocked.\n') +
      'Or provide the secret in the ROUTLET_TS_KEY environment variable, or use --ingress local.',
    'keychain_locked',
  );
}

function keychainWrite(secret: string): boolean {
  if (!keychainAvailable()) return false;
  if (process.platform === 'darwin') {
    // Sent on stdin so the secret never appears in the process list.
    spawnSync('security', ['-i'], {
      input: `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${secret}\n`,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 10_000,
    });
  } else {
    spawnSync('secret-tool', ['store', '--label=Routlet', 'service', SERVICE, 'account', ACCOUNT], {
      input: secret,
      stdio: ['pipe', 'ignore', 'ignore'],
      timeout: 10_000,
    });
  }
  // Trust only what can be read back.
  try {
    return keychainRead() === secret;
  } catch {
    return false;
  }
}

function keychainDelete(): void {
  if (!keychainAvailable()) return;
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]]
      : ['secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT]];
  spawnSync(cmd, args, { stdio: 'ignore', timeout: 5000 });
}

let cached: { secret: string; source: SecretSource } | undefined;

/** The stored secret and where it came from, or undefined if there is none. */
export function readSecret(): { secret: string; source: SecretSource } | undefined {
  const fromEnv = parseSecret(process.env.ROUTLET_TS_KEY ?? '');
  if (fromEnv) return { secret: fromEnv, source: 'env' };
  if (cached) return cached;
  const fromKeychain = keychainRead();
  if (fromKeychain) return (cached = { secret: fromKeychain, source: 'keychain' });
  return undefined;
}

/** Save the secret in the system keychain. Throws if this machine has no usable keychain. */
export function storeSecret(secret: string): void {
  cached = undefined;
  if (!keychainWrite(secret)) {
    throw new RoutletError(
      'Could not save to the system keychain' +
        (process.platform === 'linux' ? ' (is secret-tool installed, and a keyring unlocked?)' : ' (is it locked?)') +
        '. On a machine without a keychain, provide the secret in the ROUTLET_TS_KEY environment variable instead.',
      'no_keychain',
    );
  }
}

/** Remove the secret from the keychain. */
export function clearSecret(): void {
  cached = undefined;
  keychainDelete();
}
