import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createLocalAgentRun } from './run-local.ts';

it('refuses to bypass a configured Cloudflare agent resolver', async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), 'flue-run-resolver-'));
	writeFileSync(
		path.join(cwd, 'flue.config.mjs'),
		'export default { target: "cloudflare", agentResolver: "./resolver.ts" };',
	);
	writeFileSync(path.join(cwd, 'agent.ts'), "'use agent'; export function Support() {}");
	const run = createLocalAgentRun({ cwd, modulePath: './agent.ts', message: 'Hello' });
	try {
		await expect(run.start()).rejects.toThrow('cannot be used with flue run');
	} finally {
		await run.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});
