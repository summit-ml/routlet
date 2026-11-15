#!/usr/bin/env node
// Sets the release version in package.json and the lockfile. The platform
// packages take their version from here when they are built.
//
//   npm run set-version 0.2.0

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('Usage: npm run set-version <version>   (for example 0.2.0)');
  process.exit(1);
}

const file = path.resolve(import.meta.dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const previous = pkg.version;
pkg.version = version;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');

// Keep the lockfile in step.
execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], { cwd: path.dirname(file), stdio: 'ignore' });

console.log(`${previous} -> ${version}`);
console.log(`Next: commit, push, then tag it:  git tag v${version} && git push origin v${version}`);
