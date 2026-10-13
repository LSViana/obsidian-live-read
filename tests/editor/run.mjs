// Bundles the editor test with esbuild (so src/ imports and the obsidian
// stand-in resolve), then runs it with Node's test runner.
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, '..', '..', '.test-build', 'editor.test.cjs');

await esbuild.build({
	entryPoints: [path.join(here, 'editor.spec.ts')],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node18',
	outfile,
	alias: { obsidian: path.join(here, 'obsidian-mock.ts') },
	external: ['jsdom'],
	logLevel: 'warning',
});

const result = spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' });
process.exit(result.status ?? 1);
