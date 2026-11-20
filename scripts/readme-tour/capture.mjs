// Build the real renderer, but never boot the application's host, Git integration or process manager.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { output: { type: 'string' }, 'ui-locale': { type: 'string', default: 'en' }, repo: { type: 'string' } } });
if (!values.output) throw Error('Pass --output with a directory for the raw screenshots.');
const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(values.repo || path.join(dir, '../..'));
const ui = values['ui-locale'];
if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(ui) || !existsSync(path.join(dir, 'ui-' + ui + '.json'))) throw Error('Unsupported UI locator pack: ' + ui);
const output = path.resolve(values.output);
const scratch = mkdtempSync(path.join(tmpdir(), 'goga-readme-tour-'));
const require = createRequire(path.join(root, 'package.json'));
function run(command, args, env, timeout) {
  const result = spawnSync(command, args, { cwd: root, env, timeout, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error('Tour command failed: ' + (result.signal ?? result.status));
}
try {
  const home = path.join(scratch, 'home'), temp = path.join(scratch, 'tmp');
  for (const dest of [home, temp, output]) mkdirSync(dest, { recursive: true });
  // Never pass the user's credentials, Chromium switches or Electron/Node injection flags.
  const env = { HOME: home, TMPDIR: temp, PATH: process.env.PATH, LANG: 'en_US.UTF-8' };
  const renderer = path.join(scratch, 'renderer');
  run(process.execPath, [path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build', '--outDir', renderer, '--emptyOutDir', '--logLevel', 'warn'], env, 120000);
  run(require('electron'), [path.join(dir, 'capture-window.cjs'), scratch, renderer, output, ui], env, 90000);
} finally { rmSync(scratch, { recursive: true, force: true }); }
