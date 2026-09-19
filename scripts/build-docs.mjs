#!/usr/bin/env node

import { cp, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const docsSource = join(repoRoot, 'apps/docs/src/content/docs');
const docsTargets = new Map([
	['cli', join(repoRoot, 'packages/cli/docs')],
	['runtime', join(repoRoot, 'packages/runtime/docs')],
	['sdk', join(repoRoot, 'packages/sdk/docs')],
]);
const requestedTargets = process.argv.slice(2);
const targetNames = requestedTargets.length > 0 ? requestedTargets : [...docsTargets.keys()];

for (const name of targetNames) {
	if (!docsTargets.has(name)) {
		throw new Error(
			`Unknown documentation target: ${name}. Expected one of: ${[...docsTargets.keys()].join(', ')}`,
		);
	}
}

async function countFiles(root) {
	let count = 0;
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			count += await countFiles(join(root, entry.name));
		} else if (entry.isFile()) {
			count++;
		}
	}
	return count;
}

const sourceStats = await stat(docsSource).catch(() => undefined);
if (!sourceStats?.isDirectory()) {
	throw new Error(`Documentation source directory not found: ${docsSource}`);
}

const sourceFileCount = await countFiles(docsSource);
if (sourceFileCount === 0) {
	throw new Error(`Documentation source directory is empty: ${docsSource}`);
}

for (const name of targetNames) {
	const target = docsTargets.get(name);
	await rm(target, { recursive: true, force: true });
	await cp(docsSource, target, { recursive: true });

	const targetFileCount = await countFiles(target);
	if (targetFileCount !== sourceFileCount) {
		throw new Error(
			`Documentation copy is incomplete: expected ${sourceFileCount} files in ${target}, found ${targetFileCount}`,
		);
	}

	console.log(`Copied ${targetFileCount} documentation files to ${target}`);
}
