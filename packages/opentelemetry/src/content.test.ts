import type { FlueEventContext, FlueObservation } from '@flue/runtime';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { expect, it } from 'vitest';
import { createOpenTelemetryInstrumentation } from './index.ts';

it('exports valid message arrays for unshrinkable and unserializable tool histories', async () => {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	const instrumentation = createOpenTelemetryInstrumentation({
		tracer: provider.getTracer('test'),
	});
	const ctx: FlueEventContext = {
		id: 'instance_1',
		agentName: 'TestAgent',
		env: {},
		req: undefined,
		log: { info() {}, warn() {}, error() {} },
	};
	try {
		for (const [index, args] of [
			Object.fromEntries(Array.from({ length: 4_000 }, (_, i) => [`k${i}`, i])),
			{ value: 1n },
		].entries()) {
			const event: FlueObservation = {
				type: 'turn_request',
				v: 3,
				eventIndex: index,
				timestamp: '2026-09-13T00:00:00.000Z',
				turnId: `turn_${index}`,
				purpose: 'agent',
				request: {
					providerId: 'openai',
					providerName: 'openai',
					requestedModel: 'test-model',
					api: 'openai-responses',
					input: {
						messages: [
							{
								role: 'assistant',
								content: [{ type: 'toolCall', id: 'call_1', name: 'lookup', arguments: args }],
							},
						],
					},
				},
			};
			await instrumentation.observe(event, ctx);
			await instrumentation.observe(
				{
					...event,
					type: 'turn',
					durationMs: 1,
					isError: false,
					response: {
						finishReason: 'stop',
						output: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
					},
				},
				ctx,
			);
		}
		await provider.forceFlush();
		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(2);
		for (const span of spans) {
			expect(span.name).toBe('chat test-model');
			const value = span.attributes['gen_ai.input.messages'];
			expect(value).toBeTypeOf('string');
			const messages = JSON.parse(value as string);
			expect(messages).toEqual([
				{
					role: 'flue',
					parts: [{ type: 'text', content: expect.stringContaining('[flue]') }],
				},
			]);
			expect(JSON.parse(span.attributes['gen_ai.output.messages'] as string)).toEqual([
				{
					role: 'assistant',
					parts: [{ type: 'text', content: 'Done.' }],
					finish_reason: 'stop',
				},
			]);
		}
	} finally {
		instrumentation.dispose();
		await provider.shutdown();
	}
});
