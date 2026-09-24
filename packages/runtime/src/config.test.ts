import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeFlueConfig, parseFlueConfig, resolveFlueProject } from './config.ts';

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe('agentResolver configuration', () => {
	it('validates and merges an optional module path', () => {
		expect(parseFlueConfig({ agentResolver: './resolver.ts' }).agentResolver).toBe('./resolver.ts');
		expect(() => parseFlueConfig({ agentResolver: () => {} })).toThrow('agentResolver');
		expect(() => parseFlueConfig({ agentResolver: '' })).toThrow('Path must not be empty');
		expect(mergeFlueConfig({ agentResolver: 'file.ts' }, {}).agentResolver).toBe('file.ts');
		expect(
			mergeFlueConfig({ agentResolver: 'file.ts' }, { agentResolver: 'inline.ts' }).agentResolver,
		).toBe('inline.ts');
	});

	it('resolves relative to the config without evaluating or auto-discovering the module', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'flue-resolver-config-'));
		directories.push(root);
		const configDirectory = path.join(root, 'config');
		mkdirSync(configDirectory);
		writeFileSync(path.join(root, 'agentResolver.ts'), 'throw new Error("must not be loaded");');
		writeFileSync(
			path.join(configDirectory, 'resolver.ts'),
			'throw new Error("must run in Worker");',
		);
		expect(resolveFlueProject({ root }).agentResolver).toBeUndefined();
		expect(
			resolveFlueProject({
				root,
				configPath: path.join(configDirectory, 'flue.config.ts'),
				config: { agentResolver: './resolver.ts' },
			}).agentResolver,
		).toBe(path.join(configDirectory, 'resolver.ts'));
		expect(() => resolveFlueProject({ root, config: { agentResolver: './missing.ts' } })).toThrow(
			'Configured `agentResolver` entry not found',
		);
	});
});
