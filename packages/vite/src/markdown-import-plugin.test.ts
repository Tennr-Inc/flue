import { type Plugin, parseAstAsync } from 'vite';
import { describe, expect, it } from 'vitest';
import { parserLangForFile } from './agent-scan.ts';
import { markdownImportPlugin } from './markdown-import-plugin.ts';

async function resolveId(plugin: Plugin, source: string, importer: string) {
	const hook = plugin.resolveId;
	if (typeof hook !== 'function') throw new Error('Expected a resolveId hook');
	return hook.call({} as never, source, importer, {} as never);
}

describe('markdown import parsing', () => {
	it.each([
		['view.tsx', 'tsx'],
		['view.jsx', 'jsx'],
		['view.ts', 'ts'],
		['view.js', 'js'],
	] as const)('selects the %s parser dialect', (filePath, expected) => {
		expect(parserLangForFile(filePath)).toBe(expected);
	});

	it('parses a TSX importer containing JSX and type-only imports', async () => {
		const code = `
			import type { Props } from './props';
			import instructions from './instructions.md';
			export const view = <div>{instructions}</div>;
		`;

		await expect(
			parseAstAsync(code, { lang: parserLangForFile('view.tsx') }, 'view.tsx'),
		).resolves.toBeDefined();
	});
});

describe('external skill registries', () => {
	it('delegates SKILL.md edges from the Agents SDK virtual registry', async () => {
		await expect(
			resolveId(
				markdownImportPlugin(),
				'/workspace/src/skills/example/SKILL.md',
				'\0agents:skills:/workspace/src/skills',
			),
		).resolves.toBeNull();
	});

	it('still rejects an untransformed SKILL.md edge from an ordinary importer', async () => {
		await expect(
			resolveId(
				markdownImportPlugin(),
				'/workspace/src/skills/example/SKILL.md',
				'/workspace/src/registry.js',
			),
		).rejects.toThrow('reached resolution untransformed');
	});
});
