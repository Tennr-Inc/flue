import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
	assertNonStagingDistTag,
	assertSafeReleaseDirectory,
	assertValidSemver,
	INTERNAL_PACKAGES,
	parseNpmDistTagList,
	prepareInternalPackages,
	resolveOutput,
	resolvePublishedEntryPaths,
} from './prepare-internal-packages.mjs';

const TEST_VERSION = '2.0.3-tennr.1';
const TEST_OUTPUT = '.internal-release/test';

test('accepts release semver and rejects malformed versions', () => {
	assert.doesNotThrow(() => assertValidSemver(TEST_VERSION));
	assert.doesNotThrow(() => assertValidSemver('3.0.0'));
	assert.throws(() => assertValidSemver('v2.0.3'));
	assert.throws(() => assertValidSemver('2.0.3-01'));
});

test('reserves the release-specific staging dist-tag', () => {
	assert.equal(assertNonStagingDistTag('internal', TEST_VERSION), `flue-staging-${TEST_VERSION}`);
	assert.throws(
		() => assertNonStagingDistTag(`flue-staging-${TEST_VERSION}`, TEST_VERSION),
		/reserved for publication staging/,
	);
});

test('parses npm dist-tag listings and rejects incomplete registry output', () => {
	assert.deepEqual(
		parseNpmDistTagList(
			'internal: 2.0.3-tennr.1\nflue-staging-2.0.3-tennr.2: 2.0.3-tennr.2\n',
			'@tennr-inc/flue-runtime',
		),
		{
			internal: '2.0.3-tennr.1',
			'flue-staging-2.0.3-tennr.2': '2.0.3-tennr.2',
		},
	);
	assert.throws(
		() => parseNpmDistTagList('', '@tennr-inc/flue-runtime'),
		/No dist-tags were returned/,
	);
});

test('keeps destructive release staging inside a safe repository child', () => {
	const repositoryRoot = process.cwd();
	assert.equal(
		resolveOutput(repositoryRoot, '.internal-release'),
		path.join(repositoryRoot, '.internal-release'),
	);
	assert.equal(
		resolveOutput(repositoryRoot, '.internal-release/test'),
		path.join(repositoryRoot, '.internal-release/test'),
	);
	assert.throws(() => resolveOutput(repositoryRoot, '.'));
	assert.throws(() => resolveOutput(repositoryRoot, '..'));
	assert.throws(() => resolveOutput(repositoryRoot, 'apps'));
	assert.throws(() => resolveOutput(repositoryRoot, 'packages/internal-release'));
});

test('rejects a symlink escape inside the release directory', async () => {
	const repositoryRoot = process.cwd();
	const link = path.join(repositoryRoot, '.internal-release/symlink-test');
	await mkdir(path.dirname(link), { recursive: true });
	await rm(link, { force: true, recursive: true });
	try {
		await symlink('/tmp', link);
		await assert.rejects(
			assertSafeReleaseDirectory(repositoryRoot, '.internal-release/symlink-test'),
			/symbolic links/,
		);
	} finally {
		await rm(link, { force: true, recursive: true });
	}
});

test('rejects package files entries that escape source or staging roots', () => {
	const root = process.cwd();
	const source = path.join(root, 'packages/runtime');
	const destination = path.join(root, '.internal-release/runtime');
	const package_ = INTERNAL_PACKAGES[0];
	assert.throws(() =>
		resolvePublishedEntryPaths(root, source, destination, package_, '../../package.json'),
	);
	assert.throws(() =>
		resolvePublishedEntryPaths(root, source, destination, package_, '/tmp/external'),
	);
	assert.deepEqual(resolvePublishedEntryPaths(root, source, destination, package_, 'dist'), {
		source: path.join(source, 'dist'),
		destination: path.join(destination, 'dist'),
	});
});

test('stages all internal packages without changing their import names', async () => {
	const repositoryRoot = process.cwd();
	const outputDirectory = path.join(repositoryRoot, TEST_OUTPUT);

	try {
		const prepared = await prepareInternalPackages({
			root: repositoryRoot,
			output: TEST_OUTPUT,
			version: TEST_VERSION,
		});

		assert.equal(prepared.releaseManifest.packages.length, INTERNAL_PACKAGES.length);
		for (const package_ of INTERNAL_PACKAGES) {
			const manifest = JSON.parse(
				await readFile(path.join(outputDirectory, package_.directory, 'package.json'), 'utf8'),
			);
			assert.equal(manifest.name, package_.publishName);
			assert.equal(manifest.version, TEST_VERSION);
			assert.equal(manifest.publishConfig.registry, 'https://npm.pkg.github.com');
			assert.equal(manifest.devDependencies, undefined);
			assert.equal(manifest.scripts, undefined);
		}

		const viteManifest = JSON.parse(
			await readFile(path.join(outputDirectory, 'vite/package.json'), 'utf8'),
		);
		assert.equal(
			viteManifest.dependencies['@flue/runtime'],
			`npm:@tennr-inc/flue-runtime@${TEST_VERSION}`,
		);

		const telemetryManifest = JSON.parse(
			await readFile(path.join(outputDirectory, 'opentelemetry/package.json'), 'utf8'),
		);
		assert.equal(
			telemetryManifest.peerDependencies['@flue/runtime'],
			`npm:@tennr-inc/flue-runtime@${TEST_VERSION}`,
		);

		await readFile(path.join(outputDirectory, 'runtime/docs/guide/tools.md'), 'utf8');
		await readFile(path.join(outputDirectory, 'sdk/docs/flue-client.md'), 'utf8');
		const packedRuntime = spawnSync(
			'npm',
			['pack', path.join(outputDirectory, 'runtime'), '--dry-run', '--json'],
			{
				encoding: 'utf8',
				env: { ...process.env, npm_config_cache: '/tmp/flue-internal-release-npm-cache' },
			},
		);
		assert.equal(packedRuntime.status, 0, packedRuntime.stderr);
		const [runtimeTarball] = JSON.parse(packedRuntime.stdout);
		assert.ok(
			runtimeTarball.files.some((file) => file.path === 'docs/guide/tools.md'),
			'Runtime tarball must include its declared documentation.',
		);
	} finally {
		await rm(outputDirectory, { force: true, recursive: true });
	}
});
