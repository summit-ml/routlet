#!/usr/bin/env node
// Runs before `npm publish` of the main package. The platform helper packages
// are added to package.json at release time (build-packages --stamp), not kept
// in the repository. Publishing without them would ship a package that installs
// no helper binary and cannot run, under a version number that can never be reused.

import fs from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'));
const deps = pkg.optionalDependencies ?? {};
const names = Object.keys(deps).filter((name) => name.startsWith(`${pkg.name}-`));
const wrong = names.filter((name) => deps[name] !== pkg.version);

if (names.length === 0 || wrong.length) {
  console.error(
    names.length === 0
      ? 'Refusing to publish: package.json has no platform helper packages in optionalDependencies.'
      : `Refusing to publish: these do not match version ${pkg.version}: ${wrong.join(', ')}`,
  );
  console.error('Run "npm run build:packages -- --stamp" first, and publish the platform packages before this one.');
  process.exit(1);
}
