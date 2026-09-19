import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	DYNAMIC_MODEL_MARKER,
	DYNAMIC_MODEL_TEMPLATE,
	isDynamicModel,
	resetDynamicModelWarnForTests,
	resetModelsForTests,
	resolveModel,
	setProvider,
} from './providers.ts';

function providerWith(providerId: string, models: Model<any>[], template?: unknown): Provider {
	const provider: Provider = {
		id: providerId,
		name: providerId,
		baseUrl: 'https://example.test',
		getModels: () => models,
		stream: () => {
			throw new Error('unused in this test');
		},
	} as unknown as Provider;
	if (template !== undefined) {
		(provider as unknown as Record<symbol, unknown>)[DYNAMIC_MODEL_TEMPLATE] = template;
	}
	return provider;
}

function markerOf(model: Model<Api>): unknown {
	return (model as Model<Api> & { [DYNAMIC_MODEL_MARKER]: true })[DYNAMIC_MODEL_MARKER];
}

afterEach(() => {
	resetModelsForTests();
	resetDynamicModelWarnForTests();
	vi.restoreAllMocks();
});

describe('dynamic model templates', () => {
	it('synthesizes a model marked as dynamic for ids no catalog knows', () => {
		setProvider(
			providerWith('test', [], {
				api: 'anthropic-messages',
				baseUrl: 'https://example.test',
			}),
		);
		const model = resolveModel('test/fresh-model');
		expect(model.id).toBe('fresh-model');
		expect(isDynamicModel(model)).toBe(true);
		expect(markerOf(model)).toBe(true);
	});

	it('keeps a zero cost table so pi-ai can compute usage', () => {
		setProvider(
			providerWith('test', [], {
				api: 'anthropic-messages',
				baseUrl: 'https://example.test',
			}),
		);
		const model = resolveModel('test/fresh-model');
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		// `shouldCompact` treats a non-positive window as unknown.
		expect(model.contextWindow).toBe(0);
		expect(model.maxTokens).toBe(0);
	});

	it('does not mark catalog models', () => {
		setProvider(
			providerWith('test', [
				{
					id: 'known-model',
					name: 'Known Model',
					api: 'anthropic-messages',
					provider: 'test',
					baseUrl: 'https://example.test',
					reasoning: false,
					input: ['text'],
					cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 500,
				},
			]),
		);
		const model = resolveModel('test/known-model');
		expect(isDynamicModel(model)).toBe(false);
		expect(markerOf(model)).toBeUndefined();
	});

	it('warns once per process when the template is used', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		setProvider(
			providerWith('test', [], {
				api: 'anthropic-messages',
				baseUrl: 'https://example.test',
			}),
		);
		resolveModel('test/first-unknown');
		resolveModel('test/second-unknown');
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain('test/first-unknown');
		expect(warn.mock.calls[0]?.[0]).toContain('isDynamicModel');
	});
});
