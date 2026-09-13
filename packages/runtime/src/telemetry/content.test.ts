import { describe, expect, it } from 'vitest';
import type { FlueObservation, LlmMessage } from '../types.ts';
import {
	CONTENT_BUDGET_BYTES,
	contentAttribute,
	createContentLedger,
	drawContentAttribute,
	OUTPUT_CONTENT_RESERVE_BYTES,
} from './content.ts';
import { inputMessages, outputMessages } from './projection.ts';
import { CONTENT_ATTR } from './semconv.ts';
import { CONTENT_TRANSFORM_FAILED, CONTENT_UNSERIALIZABLE, truncateContent } from './truncate.ts';

const event: FlueObservation = {
	type: 'idle',
	v: 3,
	eventIndex: 0,
	timestamp: '2026-09-13T00:00:00.000Z',
};
const inputOptions = { key: CONTENT_ATTR.inputMessages, contentType: 'input_messages' } as const;

function toolCall(args: Record<string, unknown>): LlmMessage[] {
	return [
		{
			role: 'assistant',
			content: [{ type: 'toolCall', id: 'call_1', name: 'lookup', arguments: args }],
		},
	];
}

// Check the envelope and the part types Flue projects, separately from JSON
// syntax. An array of strings parses successfully but is not a message array.
function parseMessages(value: string | undefined, output = false) {
	const messages = JSON.parse(requireValue(value));
	expect(Array.isArray(messages)).toBe(true);
	for (const message of messages) {
		expect(message).toBeTypeOf('object');
		expect(message.role).toBeTypeOf('string');
		expect(Array.isArray(message.parts)).toBe(true);
		if (output) expect(message.finish_reason).toBeTypeOf('string');
		for (const part of message.parts) {
			expect(['text', 'reasoning', 'tool_call', 'tool_call_response']).toContain(part.type);
			if (part.type === 'text' || part.type === 'reasoning') {
				expect(part.content).toBeTypeOf('string');
			} else if (part.type === 'tool_call') {
				expect(part.name).toBeTypeOf('string');
			} else {
				expect(part).toHaveProperty('response');
			}
		}
	}
	return messages;
}

function requireValue(value: string | undefined): string {
	expect(value).toBeTypeOf('string');
	if (value === undefined) throw new Error('Expected a content attribute.');
	return value;
}

function draw(messages: LlmMessage[]) {
	const ledger = createContentLedger();
	const result = drawContentAttribute(
		ledger,
		undefined,
		() => inputMessages(messages),
		event,
		inputOptions,
	);
	const bytes = Buffer.byteLength(requireValue(result.value));
	expect(bytes + Buffer.byteLength(inputOptions.key)).toBeLessThanOrEqual(
		CONTENT_BUDGET_BYTES - OUTPUT_CONTENT_RESERVE_BYTES,
	);
	expect(ledger.remaining).toBe(CONTENT_BUDGET_BYTES - bytes - Buffer.byteLength(inputOptions.key));
	return result.value;
}

describe('GenAI message content', () => {
	it('preserves text, reasoning, tool calls, and tool responses', () => {
		const messages: LlmMessage[] = [
			{ role: 'user', content: 'Find "café"\n🙂' },
			{
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'Look it up.' },
					{ type: 'toolCall', id: 'call_1', name: 'lookup', arguments: { query: 'café' } },
				],
			},
			{
				role: 'toolResult',
				toolCallId: 'call_1',
				toolName: 'lookup',
				content: [{ type: 'text', text: 'Found it.' }],
				isError: false,
			},
		];
		expect(parseMessages(draw(messages))).toEqual(inputMessages(messages));
	});

	it('drops older messages before newer ones and retains a message-shaped omission marker', () => {
		const messages = parseMessages(
			draw([
				{ role: 'user', content: 'old'.repeat(30_000) },
				{ role: 'user', content: 'latest' },
			]),
		);
		expect(messages).toEqual([
			{
				role: 'flue',
				parts: [{ type: 'text', content: expect.stringContaining('1 messages omitted') }],
			},
			{ role: 'user', parts: [{ type: 'text', content: 'latest' }] },
		]);
	});

	it.each(['x', '🙂"\n'])(
		'keeps oversized %j text as a message within the shared budget',
		(text) => {
			const messages: LlmMessage[] = [{ role: 'user', content: text.repeat(100_000) }];
			const original = structuredClone(messages);
			const value = draw(messages);
			parseMessages(value);
			expect(value).toContain('[flue:truncated,');
			expect(messages).toEqual(original);
		},
	);

	it.each([
		toolCall(Object.fromEntries(Array.from({ length: 4_000 }, (_, i) => [`k${i}`, i]))),
		[{ role: 'user', content: Array.from({ length: 2_000 }, () => ({ type: 'text', text: 'x' })) }],
		toolCall({ ignored: () => {}, text: 'x'.repeat(100_000) }),
	] satisfies LlmMessage[][])(
		'retains message shape when the last message cannot shrink (%#)',
		(...messages) => {
			const value = draw(messages);
			parseMessages(value);
			expect(value).toContain('[flue]');
		},
	);

	it.each(['input_messages', 'output_messages'] as const)(
		'keeps %s fallbacks valid at the 128-byte floor',
		(contentType) => {
			const messages =
				contentType === 'input_messages'
					? inputMessages([{ role: 'user', content: 'x'.repeat(10_000) }])
					: outputMessages(
							{ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(10_000) }] },
							'stop',
						);
			const value = contentAttribute(undefined, messages, event, {
				contentType,
				maxBytes: 128,
			}).value;
			parseMessages(value, contentType === 'output_messages');
			expect(Buffer.byteLength(requireValue(value))).toBeLessThanOrEqual(128);
			expect(value).toContain('[flue]');
		},
	);

	it('keeps a depleted input ledger schema-valid', () => {
		const value = drawContentAttribute(
			{ remaining: OUTPUT_CONTENT_RESERVE_BYTES },
			undefined,
			() => inputMessages([{ role: 'user', content: 'x'.repeat(10_000) }]),
			event,
			inputOptions,
		).value;
		parseMessages(value);
		expect(Buffer.byteLength(requireValue(value))).toBeLessThanOrEqual(128);
	});

	it.each(['bigint', 'circular'])(
		'encodes an unserializable %s argument inside a message',
		(kind) => {
			const args: Record<string, unknown> = { value: 1n };
			if (kind === 'circular') args.value = args;
			const value = draw(toolCall(args));
			parseMessages(value);
			expect(value).toContain(CONTENT_UNSERIALIZABLE);
			parseMessages(
				JSON.stringify(truncateContent(inputMessages(toolCall(args)), { maxBytes: 128 })),
			);
		},
	);

	it.each(['input_messages', 'output_messages'] as const)(
		'keeps a failed %s transform schema-valid without leaking content',
		(contentType) => {
			const result = contentAttribute(
				{
					transform: () => {
						throw new Error('secret');
					},
				},
				inputMessages([{ role: 'user', content: 'secret' }]),
				event,
				{ contentType, maxBytes: 128 },
			);
			parseMessages(result.value, contentType === 'output_messages');
			expect(result.value).toContain(CONTENT_TRANSFORM_FAILED);
			expect(result.value).not.toContain('secret');
			expect(Buffer.byteLength(requireValue(result.value))).toBeLessThanOrEqual(128);
		},
	);

	it('still permits omission and leaves raw tool diagnostics as text', () => {
		const content = inputMessages([{ role: 'user', content: 'secret' }]);
		expect(contentAttribute(false, content, event, inputOptions)).toEqual({});
		expect(contentAttribute({ transform: () => undefined }, content, event, inputOptions)).toEqual(
			{},
		);
		expect(
			contentAttribute(undefined, 1n, event, { contentType: 'tool_arguments', rawString: true })
				.value,
		).toBe(CONTENT_UNSERIALIZABLE);
		expect(
			JSON.parse(
				requireValue(
					contentAttribute(undefined, 1n, event, { contentType: 'tool_arguments' }).value,
				),
			),
		).toBe(CONTENT_UNSERIALIZABLE);
	});
});
