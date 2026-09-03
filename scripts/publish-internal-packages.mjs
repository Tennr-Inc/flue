#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
	assertNonStagingDistTag,
	assertSafeReleaseDirectory,
	assertValidSemver,
	INTERNAL_PACKAGES,
	parseNpmDistTagList,
} from './prepare-internal-packages.mjs';

const DEFAULT_RELEASE_DIRECTORY = '.internal-release';
const INTERNAL_REGISTRY = 'https://npm.pkg.github.com';

function usage() {
	return 'Usage: node scripts/publish-internal-packages.mjs [--release-dir <directory>] [--tag <dist-tag>] [--dry-run]';
}

function parseArguments(arguments_) {
	let dryRun = false;
	let releaseDirectory = DEFAULT_RELEASE_DIRECTORY;
	let tag = 'internal';

	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === '--release-dir') {
			releaseDirectory = arguments_[index + 1];
			index += 1;
			continue;
		}
		if (argument === '--tag') {
			tag = arguments_[index + 1];
			index += 1;
			continue;
		}
		if (argument === '--dry-run') {
			dryRun = true;
			continue;
		}
		throw new Error(`Unknown argument: ${argument}\n${usage()}`);
	}

	if (!releaseDirectory || !tag) throw new Error(usage());
	if (!/^[A-Za-z][0-9A-Za-z._-]*$/.test(tag)) {
		throw new Error(`Invalid npm dist-tag: ${tag}`);
	}

	return { dryRun, releaseDirectory, tag };
}

function runNpm(arguments_, { allowFailure = false } = {}) {
	const result = spawnSync('npm', arguments_, {
		encoding: 'utf8',
		env: process.env,
		maxBuffer: 10 * 1024 * 1024,
	});

	if (!allowFailure && result.status !== 0) {
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		throw new Error(`npm ${arguments_[0]} failed with exit code ${result.status ?? 'unknown'}.`);
	}

	return result;
}

function parseJsonOutput(result, command) {
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new Error(`Could not parse JSON output from ${command}.`);
	}
}

async function packPackages(releaseDirectory, release) {
	const tarballDirectory = path.join(releaseDirectory, 'tarballs');
	await rm(tarballDirectory, { force: true, recursive: true });
	await mkdir(tarballDirectory, { recursive: true });

	const packedPackages = [];
	for (const package_ of release.packages) {
		const packageDirectory = path.join(releaseDirectory, package_.directory);
		const result = runNpm([
			'pack',
			packageDirectory,
			'--pack-destination',
			tarballDirectory,
			'--json',
		]);
		const [packed] = parseJsonOutput(result, `npm pack ${package_.name}`);
		if (!packed || packed.name !== package_.name || packed.version !== release.version) {
			throw new Error(`npm packed unexpected metadata for ${package_.name}.`);
		}
		packedPackages.push({
			...package_,
			integrity: packed.integrity,
			tarball: path.join(tarballDirectory, packed.filename),
		});
	}

	return packedPackages;
}

function getPublishedIntegrity(name, version) {
	const result = runNpm(
		['view', `${name}@${version}`, 'dist.integrity', '--registry', INTERNAL_REGISTRY, '--json'],
		{ allowFailure: true },
	);

	if (result.status === 0) {
		return parseJsonOutput(result, `npm view ${name}@${version}`);
	}

	const output = `${result.stdout}\n${result.stderr}`;
	if (/E404|404 Not Found/i.test(output)) return undefined;

	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	throw new Error(`Could not check ${name}@${version} in the internal registry.`);
}

async function getPublishedDistTags(name) {
	const retryDelays = [0, 1_000, 2_000, 4_000, 8_000];
	let lastResult;
	let lastError;
	for (const retryDelay of retryDelays) {
		if (retryDelay > 0) {
			await new Promise((resolve) => setTimeout(resolve, retryDelay));
		}
		lastResult = runNpm(['dist-tag', 'ls', name, '--registry', INTERNAL_REGISTRY], {
			allowFailure: true,
		});
		if (lastResult.status !== 0) continue;
		try {
			return parseNpmDistTagList(lastResult.stdout, name);
		} catch (error) {
			lastError = error;
		}
	}

	if (lastResult?.stdout) process.stdout.write(lastResult.stdout);
	if (lastResult?.stderr) process.stderr.write(lastResult.stderr);
	throw new Error(
		lastError instanceof Error
			? `${lastError.message} The registry did not expose stable tag metadata after ${retryDelays.length} attempts.`
			: `Could not read dist-tags for ${name} after ${retryDelays.length} attempts.`,
	);
}

async function main() {
	const {
		dryRun,
		releaseDirectory: releaseDirectoryArgument,
		tag,
	} = parseArguments(process.argv.slice(2));
	// packPackages replaces the tarballs/ child recursively. Apply the same
	// repository boundary as preparation so a mistyped --release-dir can never
	// target an arbitrary directory outside this checkout.
	const releaseDirectory = await assertSafeReleaseDirectory(
		process.cwd(),
		releaseDirectoryArgument,
	);
	const release = JSON.parse(await readFile(path.join(releaseDirectory, 'release.json'), 'utf8'));

	if (release.registry !== INTERNAL_REGISTRY || release.repository !== 'Tennr-Inc/flue') {
		throw new Error('Refusing to publish a release not prepared for Tennr-Inc/flue.');
	}
	if (!Array.isArray(release.packages) || release.packages.length !== 4) {
		throw new Error('The internal release must contain exactly four packages.');
	}
	assertValidSemver(release.version);
	const stagingTag = assertNonStagingDistTag(tag, release.version);
	for (const [index, expected] of INTERNAL_PACKAGES.entries()) {
		const actual = release.packages[index];
		if (
			actual?.directory !== expected.directory ||
			actual?.name !== expected.publishName ||
			actual?.sourceName !== expected.sourceName
		) {
			throw new Error(
				'The internal release package list does not match the supported package set.',
			);
		}
	}

	const packedPackages = await packPackages(releaseDirectory, release);
	if (dryRun) {
		for (const package_ of packedPackages) {
			console.log(`${package_.name}@${release.version}: ${package_.integrity}`);
		}
		console.log(`Packed and validated all internal package tarballs for ${release.version}.`);
		return;
	}

	console.log('Validating every tarball before publishing anything...');
	for (const package_ of packedPackages) {
		runNpm([
			'publish',
			package_.tarball,
			'--dry-run',
			'--tag',
			stagingTag,
			'--access',
			'restricted',
			'--registry',
			INTERNAL_REGISTRY,
		]);
	}
	const pending = [];
	for (const package_ of packedPackages) {
		const publishedIntegrity = getPublishedIntegrity(package_.name, release.version);
		if (publishedIntegrity === undefined) {
			pending.push(package_);
			continue;
		}
		if (publishedIntegrity !== package_.integrity) {
			throw new Error(
				`${package_.name}@${release.version} already exists with different contents. Choose a new version.`,
			);
		}
		console.log(`${package_.name}@${release.version} is already published with matching contents.`);
	}

	for (const package_ of pending) {
		console.log(`Publishing ${package_.name}@${release.version}...`);
		runNpm([
			'publish',
			package_.tarball,
			'--tag',
			stagingTag,
			'--access',
			'restricted',
			'--registry',
			INTERNAL_REGISTRY,
		]);
	}

	// Uploads use a release-specific staging tag so a failure cannot advance
	// the consumer-facing channel for only a prefix of the package set. Verify
	// every immutable version before promoting the requested tag.
	for (const package_ of packedPackages) {
		const publishedIntegrity = getPublishedIntegrity(package_.name, release.version);
		if (publishedIntegrity !== package_.integrity) {
			throw new Error(
				`${package_.name}@${release.version} was not fully available after publication; refusing to promote ${tag}.`,
			);
		}
	}

	const priorTags = new Map();
	for (const package_ of packedPackages) {
		priorTags.set(package_.name, (await getPublishedDistTags(package_.name))[tag]);
	}
	const attemptedPromotions = [];
	try {
		for (const package_ of packedPackages) {
			attemptedPromotions.push(package_);
			runNpm([
				'dist-tag',
				'add',
				`${package_.name}@${release.version}`,
				tag,
				'--registry',
				INTERNAL_REGISTRY,
			]);
		}
	} catch (error) {
		console.error(`Failed to promote ${tag}; restoring its previous package versions.`);
		for (const package_ of attemptedPromotions.reverse()) {
			const priorVersion = priorTags.get(package_.name);
			const rollback = priorVersion
				? ['dist-tag', 'add', `${package_.name}@${priorVersion}`, tag]
				: ['dist-tag', 'rm', package_.name, tag];
			const result = runNpm([...rollback, '--registry', INTERNAL_REGISTRY], {
				allowFailure: true,
			});
			if (result.status !== 0) {
				console.error(`Could not restore ${package_.name}'s ${tag} dist-tag; rerun the release.`);
			}
		}
		throw error;
	}
	for (const package_ of packedPackages) {
		runNpm(['dist-tag', 'rm', package_.name, stagingTag, '--registry', INTERNAL_REGISTRY], {
			allowFailure: true,
		});
	}

	console.log(`Published all internal packages at ${release.version} with dist-tag ${tag}.`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
