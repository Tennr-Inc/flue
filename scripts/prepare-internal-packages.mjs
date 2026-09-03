#!/usr/bin/env node

import { access, cp, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const INTERNAL_PACKAGES = [
	{
		directory: 'runtime',
		sourceName: '@flue/runtime',
		publishName: '@tennr-inc/flue-runtime',
	},
	{
		directory: 'sdk',
		sourceName: '@flue/sdk',
		publishName: '@tennr-inc/flue-sdk',
	},
	{
		directory: 'vite',
		sourceName: '@flue/vite',
		publishName: '@tennr-inc/flue-vite',
	},
	{
		directory: 'opentelemetry',
		sourceName: '@flue/opentelemetry',
		publishName: '@tennr-inc/flue-opentelemetry',
	},
];

const INTERNAL_RUNTIME_NAME = '@tennr-inc/flue-runtime';
const DEFAULT_OUTPUT = '.internal-release';
const REPOSITORY_URL = 'https://github.com/Tennr-Inc/flue.git';
const REGISTRY_URL = 'https://npm.pkg.github.com';

function usage() {
	return 'Usage: node scripts/prepare-internal-packages.mjs --version <semver> [--output <directory>]';
}

export function parseArguments(arguments_) {
	let version;
	let output = DEFAULT_OUTPUT;

	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === '--version') {
			version = arguments_[index + 1];
			index += 1;
			continue;
		}
		if (argument === '--output') {
			output = arguments_[index + 1];
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${argument}\n${usage()}`);
	}

	if (!version || !output) {
		throw new Error(usage());
	}

	return { output, version };
}

export function assertValidSemver(version) {
	const match =
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
			version,
		);
	if (!match) {
		throw new Error(`Internal package version must be valid semver: ${version}`);
	}

	const prerelease = match[4];
	if (
		prerelease
			?.split('.')
			.some((identifier) => /^\d+$/.test(identifier) && /^0\d+/.test(identifier))
	) {
		throw new Error(`Numeric prerelease identifiers cannot have leading zeroes: ${version}`);
	}
}

export function internalStagingTag(version) {
	assertValidSemver(version);
	return `flue-staging-${version.replaceAll('+', '-')}`;
}

export function assertNonStagingDistTag(tag, version) {
	const stagingTag = internalStagingTag(version);
	if (tag === stagingTag) {
		throw new Error(
			`The requested dist-tag "${tag}" is reserved for publication staging. Choose another tag.`,
		);
	}
	return stagingTag;
}

export function parseNpmDistTagList(output, packageName) {
	const tags = {};
	for (const line of output.trim().split('\n')) {
		if (line.trim() === '') continue;
		const match = /^([^:\s]+):\s+([^\s]+)$/.exec(line.trim());
		if (!match) {
			throw new Error(`Could not parse a dist-tag returned for ${packageName}: ${line}`);
		}
		tags[match[1]] = match[2];
	}
	if (Object.keys(tags).length === 0) {
		throw new Error(`No dist-tags were returned for ${packageName}.`);
	}
	return tags;
}

function isWithin(parent, candidate) {
	const relative = path.relative(parent, candidate);
	return (
		relative !== '' &&
		!relative.startsWith(`..${path.sep}`) &&
		relative !== '..' &&
		!path.isAbsolute(relative)
	);
}

export function resolveOutput(root, output) {
	const resolved = path.resolve(root, output);
	const releaseRoot = path.join(root, DEFAULT_OUTPUT);
	if (resolved !== releaseRoot && !isWithin(releaseRoot, resolved)) {
		throw new Error('The output directory must be .internal-release or one of its children.');
	}

	return resolved;
}

export async function assertSafeReleaseDirectory(root, output) {
	const resolved = resolveOutput(root, output);
	let current = root;
	for (const segment of path.relative(root, resolved).split(path.sep)) {
		current = path.join(current, segment);
		try {
			if ((await lstat(current)).isSymbolicLink()) {
				throw new Error('The internal release directory cannot contain symbolic links.');
			}
		} catch (error) {
			if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') break;
			throw error;
		}
	}
	return resolved;
}

async function exists(filePath) {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function copyIfPresent(source, destination) {
	if (!(await exists(source))) return;
	await cp(source, destination, { recursive: true });
}

async function copyRequired(source, destination, label) {
	if (!(await exists(source)))
		throw new Error(`${label} is declared for publication but is missing.`);
	await cp(source, destination, { recursive: true });
}

function publishedEntrySource(repositoryRoot, sourceDirectory, package_, entry) {
	if (entry !== 'docs') return path.join(sourceDirectory, entry);
	if (package_.sourceName === '@flue/runtime') {
		return path.join(repositoryRoot, 'apps/docs/src/content/docs');
	}
	if (package_.sourceName === '@flue/sdk') {
		return path.join(repositoryRoot, 'apps/docs/src/content/docs/sdk');
	}
	return path.join(sourceDirectory, entry);
}

export function resolvePublishedEntryPaths(
	repositoryRoot,
	sourceDirectory,
	destinationDirectory,
	package_,
	entry,
) {
	if (
		typeof entry !== 'string' ||
		entry.length === 0 ||
		path.isAbsolute(entry) ||
		entry.split(/[\\/]/).includes('..')
	) {
		throw new Error(`${package_.sourceName} has an unsafe files entry: ${String(entry)}`);
	}
	const source = path.resolve(
		publishedEntrySource(repositoryRoot, sourceDirectory, package_, entry),
	);
	const destination = path.resolve(destinationDirectory, entry);
	const allowedSourceRoot = entry === 'docs' ? repositoryRoot : sourceDirectory;
	if (!isWithin(allowedSourceRoot, source) || !isWithin(destinationDirectory, destination)) {
		throw new Error(`${package_.sourceName} files entry escapes its package: ${entry}`);
	}
	return { source, destination };
}

function assertNoWorkspaceProtocols(manifest) {
	for (const dependencyKind of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
		for (const [name, range] of Object.entries(manifest[dependencyKind] ?? {})) {
			if (typeof range === 'string' && range.startsWith('workspace:')) {
				throw new Error(`${manifest.name} still has a workspace protocol for ${name}.`);
			}
		}
	}
}

function collectExportTargets(value, targets = []) {
	if (typeof value === 'string') {
		if (value.startsWith('./')) targets.push(value.slice(2));
		return targets;
	}
	if (!value || typeof value !== 'object') return targets;
	for (const child of Object.values(value)) collectExportTargets(child, targets);
	return targets;
}

async function assertPublishedFilesExist(packageDirectory, manifest) {
	const targets = new Set([
		...collectExportTargets(manifest.exports),
		...(typeof manifest.main === 'string' ? [manifest.main.replace(/^\.\//, '')] : []),
		...(typeof manifest.types === 'string' ? [manifest.types.replace(/^\.\//, '')] : []),
	]);

	for (const target of targets) {
		if (!(await exists(path.join(packageDirectory, target)))) {
			throw new Error(`${manifest.name} references a missing published file: ${target}`);
		}
	}
}

function createInternalManifest(sourceManifest, package_, version) {
	if (sourceManifest.name !== package_.sourceName) {
		throw new Error(
			`Expected packages/${package_.directory}/package.json to be ${package_.sourceName}, found ${sourceManifest.name}.`,
		);
	}

	const manifest = structuredClone(sourceManifest);
	manifest.name = package_.publishName;
	manifest.version = version;
	manifest.repository = {
		type: 'git',
		url: REPOSITORY_URL,
		directory: `packages/${package_.directory}`,
	};
	manifest.publishConfig = {
		access: 'restricted',
		registry: REGISTRY_URL,
	};

	delete manifest.devDependencies;
	delete manifest.scripts;

	const runtimeAlias = `npm:${INTERNAL_RUNTIME_NAME}@${version}`;
	if (package_.sourceName === '@flue/vite') {
		if (!manifest.dependencies?.['@flue/runtime']) {
			throw new Error('@flue/vite must declare @flue/runtime as a dependency.');
		}
		manifest.dependencies['@flue/runtime'] = runtimeAlias;
	}
	if (package_.sourceName === '@flue/opentelemetry') {
		if (!manifest.peerDependencies?.['@flue/runtime']) {
			throw new Error('@flue/opentelemetry must declare @flue/runtime as a peer dependency.');
		}
		manifest.peerDependencies['@flue/runtime'] = runtimeAlias;
	}

	assertNoWorkspaceProtocols(manifest);
	return manifest;
}

export async function prepareInternalPackages({ root = process.cwd(), output, version }) {
	assertValidSemver(version);

	const repositoryRoot = path.resolve(root);
	const outputDirectory = await assertSafeReleaseDirectory(
		repositoryRoot,
		output ?? DEFAULT_OUTPUT,
	);
	const sourcePackages = path.join(repositoryRoot, 'packages');

	for (const package_ of INTERNAL_PACKAGES) {
		const sourceDirectory = path.join(sourcePackages, package_.directory);
		if (!(await exists(path.join(sourceDirectory, 'dist')))) {
			throw new Error(`Build output is missing for ${package_.sourceName}; run its build first.`);
		}
	}

	await rm(outputDirectory, { force: true, recursive: true });
	await mkdir(outputDirectory, { recursive: true });

	const releasePackages = [];
	for (const package_ of INTERNAL_PACKAGES) {
		const sourceDirectory = path.join(sourcePackages, package_.directory);
		const destinationDirectory = path.join(outputDirectory, package_.directory);
		const sourceManifest = JSON.parse(
			await readFile(path.join(sourceDirectory, 'package.json'), 'utf8'),
		);
		const manifest = createInternalManifest(sourceManifest, package_, version);

		await mkdir(destinationDirectory, { recursive: true });
		for (const entry of sourceManifest.files ?? []) {
			const paths = resolvePublishedEntryPaths(
				repositoryRoot,
				sourceDirectory,
				destinationDirectory,
				package_,
				entry,
			);
			await copyRequired(
				paths.source,
				paths.destination,
				`${sourceManifest.name} files entry "${entry}"`,
			);
		}
		await copyIfPresent(
			path.join(sourceDirectory, 'README.md'),
			path.join(destinationDirectory, 'README.md'),
		);
		await copyIfPresent(
			path.join(repositoryRoot, 'LICENSE'),
			path.join(destinationDirectory, 'LICENSE'),
		);
		await writeFile(
			path.join(destinationDirectory, 'package.json'),
			`${JSON.stringify(manifest, null, '\t')}\n`,
		);
		await assertPublishedFilesExist(destinationDirectory, manifest);

		releasePackages.push({
			directory: package_.directory,
			name: package_.publishName,
			sourceName: package_.sourceName,
		});
	}

	const releaseManifest = {
		registry: REGISTRY_URL,
		repository: 'Tennr-Inc/flue',
		version,
		packages: releasePackages,
	};
	await writeFile(
		path.join(outputDirectory, 'release.json'),
		`${JSON.stringify(releaseManifest, null, '\t')}\n`,
	);

	return { outputDirectory, releaseManifest };
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const { outputDirectory, releaseManifest } = await prepareInternalPackages(options);
	console.log(`Prepared ${releaseManifest.packages.length} packages at ${outputDirectory}`);
	for (const package_ of releaseManifest.packages) {
		console.log(`- ${package_.sourceName} -> ${package_.name}@${releaseManifest.version}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
