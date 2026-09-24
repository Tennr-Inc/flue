import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { generateCloudflareEntry } from './cloudflare-entry.ts';

// Compile and evaluate the generated Worker against small host stubs. This
// verifies actual module wiring and exports rather than matching source text.
async function worker(resolverSource?: string) {
	const modules: Record<string, string> = {
		'cloudflare:workers': 'export const env = {};',
		agents: 'export class Agent {} export function getAgentByName() {}',
		'@flue/runtime/internal': `
			export function configureFlueRuntime() {}
			export function createCloudflareAgentRuntime(options) { return options; }
			export function createFlueContext(options) { return options; }
			export function hasProvider() { return true; }
			export function installDevLifecycleLogger() {}
			export function registerFlueAgents() {}
			export function resolveModel() {}
			export function setProvider() {}
		`,
		'@flue/runtime/cloudflare/internal': `
			export function createCloudflareWorkerConfig() { return {}; }
			export function createFlueAgentClass(options) { return options; }
			export function runWithCloudflareContext(context, fn) { return fn(); }
		`,
		'virtual:flue/providers': '',
		'/app.ts': 'export default { fetch() {} };',
		'/agent.ts': 'export function Support() {}',
		'/resolver.ts': resolverSource ?? '',
		'/test-worker.ts': generateCloudflareEntry({
			appEntry: '/app.ts',
			cloudflareEntry: undefined,
			agentResolver: resolverSource === undefined ? undefined : '/resolver.ts',
			providers: [],
			tracing: false,
			agents: [
				{
					filePath: '/agent.ts',
					exportName: 'Support',
					identity: 'Support',
					className: 'FlueSupport',
					bindingName: 'FLUE_SUPPORT',
				},
			],
		}),
	};
	const output = await build({
		configFile: false,
		logLevel: 'silent',
		plugins: [
			{
				name: 'test-worker-modules',
				enforce: 'pre',
				resolveId(id) {
					if (id in modules) return `\0${id}`;
				},
				load(id) {
					return modules[id.slice(1)];
				},
			},
		],
		build: {
			write: false,
			minify: true,
			lib: { entry: '/test-worker.ts', formats: ['cjs'], fileName: 'worker' },
		},
	});
	if ('close' in output) throw new Error('Unexpected watch build');
	const bundle = (Array.isArray(output) ? output[0] : output)?.output.find(
		(entry) => entry.type === 'chunk',
	);
	if (bundle?.type !== 'chunk') throw new Error('Expected a Worker bundle');
	const exports: {
		FlueSupport?: { runtime: { resolveAgentForInstance?: (context: unknown) => Promise<unknown> } };
	} = {};
	new Function('exports', bundle.code)(exports);
	if (!exports.FlueSupport) throw new Error('Expected a generated agent class');
	return exports.FlueSupport.runtime;
}

describe('generated Cloudflare resolver wiring', () => {
	it('omits the hook unless explicitly configured', async () => {
		expect((await worker()).resolveAgentForInstance).toBeUndefined();
	});

	it('imports the default resolver and passes it to the runtime', async () => {
		const runtime = await worker(`
			export default async function resolve({ agentName, instance }) {
				return agentName + ':' + instance.env.release + ':' + instance.name;
			}
		`);
		expect(
			await runtime.resolveAgentForInstance?.({
				agentName: 'Support',
				instance: { name: 'alice', env: { release: 'v1' } },
			}),
		).toBe('Support:v1:alice');
	});

	it('rejects an invalid resolver export at Worker initialization', async () => {
		await expect(worker('export default {};')).rejects.toThrow(
			'must default-export a resolver function',
		);
	});
});
