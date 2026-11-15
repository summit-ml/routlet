import os from 'node:os';
import path from 'node:path';

// This location is deliberately fixed and does not follow XDG_STATE_HOME. The
// registry and the gateway's tailnet identity live here, and tools that launch
// Routlet often set their own XDG directories. Following them would make the same
// service look brand new depending on where the command was run from.

/** Persistent state (registry, tailnet node identities). Never inside an app repo. */
export function stateDir(): string {
  return process.env.ROUTLET_STATE_DIR ?? path.join(os.homedir(), '.local', 'state', 'routlet');
}
