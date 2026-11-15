#!/usr/bin/env node
// Builds the per-platform helper packages into npm/<platform>-<arch>/.
//
// The main package lists these as optionalDependencies. Each one declares the
// operating system and CPU it is for, so npm installs only the one that matches
// the machine. Go cross-compiles all of them from any host.
//
//   node scripts/build-packages.mjs            build every platform
//   node scripts/build-packages.mjs --host     build only this machine's platform

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// npm's names for os/cpu on the left, Go's on the right.
const TARGETS = [
  { os: 'darwin', cpu: 'arm64', goos: 'darwin', goarch: 'arm64' },
  { os: 'darwin', cpu: 'x64', goos: 'darwin', goarch: 'amd64' },
  { os: 'linux', cpu: 'x64', goos: 'linux', goarch: 'amd64' },
  { os: 'linux', cpu: 'arm64', goos: 'linux', goarch: 'arm64' },
];

const packageName = (t) => `${pkg.name}-${t.os}-${t.cpu}`;

// The main package must depend on exactly the versions built here.
const expected = Object.fromEntries(TARGETS.map((t) => [packageName(t), pkg.version]));
if (JSON.stringify(pkg.optionalDependencies ?? {}) !== JSON.stringify(expected)) {
  console.error('package.json optionalDependencies are out of date. They should be:');
  console.error(JSON.stringify(expected, null, 2));
  process.exit(1);
}

const hostOnly = process.argv.includes('--host');
const targets = hostOnly ? TARGETS.filter((t) => t.os === process.platform && t.cpu === process.arch) : TARGETS;
if (!targets.length) {
  console.error(`No helper target for ${process.platform}-${process.arch}.`);
  process.exit(1);
}

for (const target of targets) {
  const dir = path.join(root, 'npm', `${target.os}-${target.cpu}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });

  execFileSync(
    'go',
    ['build', '-trimpath', '-ldflags=-s -w', '-o', path.join(dir, 'bin', 'routlet-helper'), '.'],
    {
      cwd: path.join(root, 'helper'),
      env: { ...process.env, CGO_ENABLED: '0', GOOS: target.goos, GOARCH: target.goarch },
      stdio: 'inherit',
    },
  );

  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: packageName(target),
        version: pkg.version,
        description: `The ${target.os} ${target.cpu} helper binary for ${pkg.name}.`,
        license: pkg.license,
        repository: pkg.repository,
        os: [target.os],
        cpu: [target.cpu],
        files: ['bin'],
      },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    `# ${packageName(target)}\n\nThe ${target.os} ${target.cpu} helper binary for [${pkg.name}](https://www.npmjs.com/package/${pkg.name}). ` +
      `It is installed automatically; do not depend on it directly.\n`,
  );
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(dir, 'LICENSE'));

  const size = (fs.statSync(path.join(dir, 'bin', 'routlet-helper')).size / 1e6).toFixed(1);
  console.log(`built ${packageName(target)}@${pkg.version} (${size} MB)`);
}
