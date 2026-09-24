import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { flue } from './flue-plugin.ts';

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

it('rejects a per-instance resolver on the Node target', async () => {
	const root = mkdtempSync(path.join(tmpdir(), 'flue-node-resolver-'));
	directories.push(root);
	writeFileSync(
		path.join(root, 'resolver.ts'),
		'throw new Error("must not be evaluated by config loading");',
	);
	const plugin = flue({ target: 'node', agentResolver: './resolver.ts' }).find(
		(entry) => entry.name === 'flue',
	);
	if (typeof plugin?.config !== 'function') throw new Error('Expected config hook');
	await expect(
		plugin.config.call({} as never, { root }, { command: 'build', mode: 'production' }),
	).rejects.toThrow('agentResolver requires the Cloudflare target');
});
