import { existsSync } from 'fs';
import { join } from 'path';
import { styleText } from 'node:util';
import { spawnHidden } from '../../shared/spawn.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { marketplaceDirectory } from '../utils/paths.js';

/**
 * The observer (`observer/`) is fork-only tooling — not in package.json's
 * `files` allowlist, so it never ships in the published npm tarball. It only
 * exists in a full git clone, which is what `marketplaceDirectory()` points
 * at for installs that track this fork (see HANDOFF.md).
 */
function observerBinPath(): string {
  return join(marketplaceDirectory(), 'observer', 'bin', 'claude-mem-observer.mjs');
}

export function runObserverAliasCommand(argv: string[] = []): void {
  const binPath = observerBinPath();

  if (!existsSync(binPath)) {
    console.error(styleText('red', `Observer not found at: ${binPath}`));
    console.error(
      "This command only works from a full git clone of the fork (not a plain npm install) — "
      + "the observer/ directory ships in git, not in the published package.",
    );
    process.exit(1);
  }

  const child = spawnHidden(process.execPath, [binPath, ...argv], {
    stdio: 'inherit',
    cwd: join(marketplaceDirectory(), 'observer'),
    env: sanitizeEnv(process.env),
  });

  child.on('error', (error) => {
    console.error(styleText('red', `Failed to start observer: ${error.message}`));
    process.exit(1);
  });

  child.on('close', (exitCode) => {
    process.exit(exitCode ?? 0);
  });
}
