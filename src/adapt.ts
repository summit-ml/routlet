import fs from 'node:fs';
import path from 'node:path';

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
// CLIs that ignore the PORT environment variable and need an explicit flag. The
// flag is only valid on their server commands: `vite`, `vite dev`, `astro preview`.
// Something like `vite build` would reject it, so it is left alone.
const NEEDS_PORT_FLAG = /(^|[\s/])(vite|astro)(\s+(dev|serve|preview|start))?(\s+-\S+)*\s*$/;

/**
 * The text of what will actually run: the package.json script when the command
 * is `npm run dev` (or a pnpm/yarn/bun equivalent), otherwise the command itself.
 */
function effectiveScript(command: string[], cwd: string): { text: string; viaManager?: string } {
  const [bin, ...rest] = command;
  const manager = path.basename(bin);
  if (PACKAGE_MANAGERS.has(manager)) {
    const scriptName = rest[0] === 'run' || rest[0] === 'run-script' ? rest[1] : rest[0];
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
      const script = pkg?.scripts?.[scriptName];
      if (typeof script === 'string') return { text: script, viaManager: manager };
    } catch {
      // no readable package.json: fall through
    }
  }
  return { text: command.join(' ') };
}

/**
 * Make an unmodified app listen on the given port. Every app gets PORT in its
 * environment. Frameworks that ignore PORT also get a port flag appended.
 */
export function adaptCommand(command: string[], port: number, cwd: string): string[] {
  if (command.includes('--port')) return command;
  const { text, viaManager } = effectiveScript(command, cwd);
  // A compound script would receive the flags on its last command only, so leave it alone.
  if (!NEEDS_PORT_FLAG.test(text) || /&&|\|\||;|\bconcurrently\b/.test(text)) return command;
  if (/--port[\s=]/.test(text)) return command;

  const flags = ['--port', String(port), '--strictPort'];
  // npm needs `--` before arguments meant for the script; the others forward them as is.
  if (viaManager === 'npm' && !command.includes('--')) return [...command, '--', ...flags];
  return [...command, ...flags];
}
