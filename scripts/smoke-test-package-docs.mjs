#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
let version;

if (args.length > 0) {
	if (args.length !== 2 || args[0] !== '--version' || !args[1]) {
		throw new Error('Usage: pnpm test:package-docs [--version <published-version>]');
	}
	version = args[1];
}

function run(command, commandArgs, options = {}) {
	console.log(`$ ${command} ${commandArgs.join(' ')}`);
	const result = spawnSync(command, commandArgs, {
		cwd: options.cwd ?? repoRoot,
		encoding: 'utf8',
		stdio: options.capture ? 'pipe' : 'inherit',
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		if (options.capture) {
			process.stderr.write(result.stdout);
			process.stderr.write(result.stderr);
		}
		throw new Error(`Command failed with exit code ${result.status}: ${command}`);
	}
	return result.stdout;
}

async function countFiles(root) {
	let count = 0;
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const entryPath = join(root, entry.name);
		if (entry.isDirectory()) count += await countFiles(entryPath);
		else if (entry.isFile()) count++;
	}
	return count;
}

async function assertPackageDocs(projectRoot, name, expectedVersion) {
	const packageRoot = join(projectRoot, 'node_modules/@flue', name);
	const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
	if (expectedVersion && manifest.version !== expectedVersion) {
		throw new Error(`Expected @flue/${name}@${expectedVersion}, installed ${manifest.version}`);
	}

	const docsRoot = join(packageRoot, 'docs');
	const docsStats = await stat(docsRoot).catch(() => undefined);
	if (!docsStats?.isDirectory()) throw new Error(`@flue/${name} does not contain docs/`);

	const fileCount = await countFiles(docsRoot);
	if (fileCount === 0) throw new Error(`@flue/${name}/docs is empty`);

	const sample = join(docsRoot, 'guide/sandboxes.md');
	const sampleStats = await stat(sample).catch(() => undefined);
	if (!sampleStats?.isFile()) throw new Error(`@flue/${name} is missing docs/guide/sandboxes.md`);

	console.log(`✓ @flue/${name}@${manifest.version} contains ${fileCount} documentation files`);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'flue-package-docs-'));
const artifactsRoot = join(temporaryRoot, 'artifacts');
const projectRoot = join(temporaryRoot, 'project');

try {
	await mkdir(artifactsRoot);
	await mkdir(projectRoot);
	await writeFile(join(projectRoot, 'package.json'), '{"private":true,"type":"module"}\n');

	let installSpecs;
	if (version) {
		console.log(`Testing published Flue packages at version ${version}`);
		installSpecs = ['cli', 'runtime', 'sdk'].map((name) => `@flue/${name}@${version}`);
	} else {
		console.log('Testing locally packed Flue packages');
		for (const name of ['runtime', 'sdk', 'vite', 'cli']) {
			run('pnpm', ['--dir', `packages/${name}`, 'pack', '--pack-destination', artifactsRoot], {
				capture: true,
			});
		}
		installSpecs = (await readdir(artifactsRoot))
			.filter((name) => name.endsWith('.tgz'))
			.map((name) => join(artifactsRoot, name));
	}

	run('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock', ...installSpecs], {
		cwd: projectRoot,
		capture: true,
	});

	for (const name of ['cli', 'runtime', 'sdk']) {
		await assertPackageDocs(projectRoot, name, version);
	}

	const flueBin = join(projectRoot, 'node_modules/.bin/flue');
	const output = run(flueBin, ['docs', 'read', 'guide/sandboxes'], {
		cwd: projectRoot,
		capture: true,
	});
	if (!output.startsWith('# Sandboxes\n')) {
		throw new Error('`flue docs read guide/sandboxes` returned unexpected output');
	}
	console.log('✓ flue docs read guide/sandboxes');
	console.log('Package documentation smoke test passed');
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
