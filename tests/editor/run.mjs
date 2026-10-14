// Bundles the editor and popup tests with esbuild (so src/ imports and the
// obsidian stand-ins resolve), then runs them with Node's test runner.
import esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', '..', '.test-build');

const suites = [
	{ entry: 'editor.spec.ts', mock: 'obsidian-mock.ts', out: 'editor.test.cjs' },
	{ entry: 'modal.spec.ts', mock: 'obsidian-modal-mock.ts', out: 'modal.test.cjs' },
];

const outfiles = [];
for (const suite of suites) {
	const outfile = path.join(outDir, suite.out);
	await esbuild.build({
		entryPoints: [path.join(here, suite.entry)],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node18',
		outfile,
		alias: { obsidian: path.join(here, suite.mock) },
		external: ['jsdom'],
		logLevel: 'warning',
	});
	outfiles.push(outfile);
}

const result = spawnSync(process.execPath, ['--test', ...outfiles], { stdio: 'inherit' });
process.exit(result.status ?? 1);
