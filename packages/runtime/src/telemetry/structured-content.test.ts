import { describe, expect, it } from 'vitest';
import type { FlueObservation } from '../types.ts';
import { contentAttribute, drawContentAttribute, OUTPUT_CONTENT_RESERVE_BYTES } from './content.ts';
import {
	inputMessages,
	outputMessages,
	systemInstructions,
	toolDefinitions,
} from './projection.ts';
import {
	CONTENT_TRANSFORM_FAILED,
	CONTENT_UNSERIALIZABLE,
	type ContentArrayKind,
	truncateContent,
} from './truncate.ts';

const event: FlueObservation = {
	type: 'idle',
	v: 3,
	eventIndex: 0,
	timestamp: '2026-09-14T00:00:00.000Z',
};

// Validate the projected branches of the pinned GenAI schemas, not merely
// JSON syntax: strings in any of these arrays are invalid. Generic tool
// definitions require both type/name; generic instruction parts require type.
function parseArray(value: string | undefined, kind: ContentArrayKind, budget: number) {
	expect(value).toBeTypeOf('string');
	if (value === undefined) throw new Error('Expected a content attribute.');
	expect(Buffer.byteLength(value)).toBeLessThanOrEqual(budget);
	const items = JSON.parse(value);
	expect(Array.isArray(items)).toBe(true);
	for (const item of items) {
		expect(item).not.toBeNull();
		expect(item).toBeTypeOf('object');
		if (kind === 'tool_definitions') {
			expect(item.type).toBeTypeOf('string');
			expect(item.name).toBeTypeOf('string');
		} else if (kind === 'system_instructions') {
			expect(item.type).toBeTypeOf('string');
			if (item.type === 'text') expect(item.content).toBeTypeOf('string');
		} else {
			expect(item.role).toBeTypeOf('string');
			expect(Array.isArray(item.parts)).toBe(true);
			if (kind === 'output_messages') expect(item.finish_reason).toBeTypeOf('string');
			for (const part of item.parts) {
				expect(part.type).toBeTypeOf('string');
				if (part.type === 'text') expect(part.content).toBeTypeOf('string');
			}
		}
	}
	return items;
}

const text = '🙂"\n'.repeat(20_000);
const schemas = {
	input_messages: inputMessages([
		{ role: 'user', content: text },
		{ role: 'user', content: text },
	]),
	output_messages: outputMessages({ role: 'assistant', content: [{ type: 'text', text }] }, 'stop'),
	system_instructions: [...(systemInstructions(text) ?? []), ...(systemInstructions(text) ?? [])],
	tool_definitions: toolDefinitions([
		{ name: 'old', description: text, parameters: {} },
		{ name: 'latest', description: text, parameters: { type: 'object' } },
	]),
};
const kinds = Object.keys(schemas) as ContentArrayKind[];

describe.each(kinds)('%s structural content budgeting', (kind) => {
	it.each([128, 256, 25_000, 57_344])('keeps array shape at %i bytes', (budget) => {
		const original = structuredClone(schemas[kind]);
		parseArray(JSON.stringify(truncateContent(schemas[kind], { maxBytes: budget })), kind, budget);
		parseArray(
			contentAttribute(undefined, schemas[kind], event, { contentType: kind, maxBytes: budget })
				.value,
			kind,
			budget,
		);
		expect(schemas[kind]).toEqual(original);
	});

	it('keeps failures schema-valid without leaking content', () => {
		for (const failure of ['transform', 'bigint', 'circular'] as const) {
			const invalid: Record<string, unknown> = { secret: 1n };
			if (failure === 'circular') invalid.secret = invalid;
			const value = contentAttribute(
				failure === 'transform'
					? {
							transform: () => {
								throw new Error('secret');
							},
						}
					: undefined,
				invalid,
				event,
				{ contentType: kind, maxBytes: 128 },
			).value;
			parseArray(value, kind, 128);
			expect(value).toContain(
				failure === 'transform' ? CONTENT_TRANSFORM_FAILED : CONTENT_UNSERIALIZABLE,
			);
			expect(value).not.toContain('secret');
		}
	});

	it('retains schema shape when earlier content exhausts the shared ledger', () => {
		const value = drawContentAttribute(
			{ remaining: kind === 'output_messages' ? 0 : OUTPUT_CONTENT_RESERVE_BYTES },
			undefined,
			() => schemas[kind],
			event,
			{ contentType: kind, key: 'gen_ai.test' },
		).value;
		parseArray(value, kind, 128);
	});

	it('honors a receiver byte cap after one transform and within the ledger allowance', () => {
		for (const allowance of [512, 57_344]) {
			let transforms = 0;
			const value = contentAttribute(
				{
					maxBytes: 25_000,
					transform: (content) => {
						transforms += 1;
						return content;
					},
				},
				schemas[kind],
				event,
				{ contentType: kind, maxBytes: allowance },
			).value;
			parseArray(value, kind, Math.min(allowance, 25_000));
			expect(transforms).toBe(1);
		}
	});
});

describe('tool definitions and system instructions', () => {
	it.each(['tool_definitions', 'system_instructions'] as const)(
		'keeps retained %s items intact after dropping oversized older items',
		(kind) => {
			const latest =
				kind === 'tool_definitions'
					? { type: 'function', name: 'latest', parameters: { type: 'object' } }
					: { type: 'text', content: 'latest' };
			const content = [...(schemas[kind] ?? []), latest];
			const items = parseArray(
				JSON.stringify(truncateContent(content, { maxBytes: 512 })),
				kind,
				512,
			);
			expect(items).toHaveLength(2);
			expect(items[0]).toEqual(
				kind === 'tool_definitions'
					? {
							type: 'flue',
							name: '[flue]',
							description: expect.stringContaining('2 items omitted'),
						}
					: { type: 'text', content: expect.stringContaining('2 items omitted') },
			);
			expect(items[1]).toEqual(latest);
		},
	);

	it('shortens only tool descriptions, preserving names and parameter schemas', () => {
		const tool = {
			type: 'function',
			name: 'long_tool_name'.repeat(50),
			description: text,
			parameters: { type: 'string', pattern: `^${'x'.repeat(1_000)}$`, enum: ['y'.repeat(1_000)] },
		};
		const original = structuredClone(tool);
		const items = parseArray(
			JSON.stringify(truncateContent([tool], { maxBytes: 4_000 })),
			'tool_definitions',
			4_000,
		);
		expect(items).toEqual([{ ...tool, description: expect.stringContaining('[flue:truncated,') }]);
		expect(tool).toEqual(original);
	});

	it('omits an oversized parameter schema instead of changing its strings', () => {
		const tool = { type: 'function', name: 'lookup', parameters: { enum: [text] } };
		const items = parseArray(
			JSON.stringify(truncateContent([tool], { maxBytes: 25_000 })),
			'tool_definitions',
			25_000,
		);
		expect(items).toEqual([
			{ type: 'flue', name: '[flue]', description: expect.stringContaining('1 items omitted') },
		]);
	});

	it.each(['bigint', 'circular'])('keeps direct helper failures typed (%s)', (kind) => {
		const parameters: Record<string, unknown> = { value: 1n };
		if (kind === 'circular') parameters.value = parameters;
		const tools = [{ type: 'function', name: 'lookup', parameters }];
		const value = JSON.stringify(truncateContent(tools, { maxBytes: 128 }));
		parseArray(value, 'tool_definitions', 128);
		expect(value).toContain(CONTENT_UNSERIALIZABLE);
	});

	it('preserves normal projected definitions and instructions exactly', () => {
		const tools = toolDefinitions([
			{ name: 'lookup', description: 'Look up a record.', parameters: { type: 'object' } },
		]);
		const instructions = systemInstructions('Be helpful.');
		expect(truncateContent(tools, { maxBytes: 128 })).toEqual(tools);
		expect(truncateContent(instructions, { maxBytes: 128 })).toEqual(instructions);
	});

	it('keeps generic array behavior for unstructured tool payloads', () => {
		const result = truncateContent([text, 'latest'], { maxBytes: 128 });
		expect(result).toEqual([expect.stringContaining('[flue]'), 'latest']);
	});
});
