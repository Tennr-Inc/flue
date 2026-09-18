import { describe, expect, it } from 'vitest';

import type { AgentConversationSnapshot, ConversationStreamChunk } from './conversation-public.ts';
import { handleAgentConversationRead } from './runtime/handle-conversation-routes.ts';
import { InMemoryConversationStreamStore } from './runtime/conversation-stream-store.ts';

type CanonicalRecord = Parameters<InMemoryConversationStreamStore['append']>[0]['records'][number];

/** Real canonical records exercise both runtime projections, not a mocked UI snapshot. */
async function fixture() {
	const store = new InMemoryConversationStreamStore();
	const path = '/conversation-order';
	await store.createStream(path, {
		agentName: 'error-case-tot',
		instanceId: 'case',
	});
	const producer = await store.acquireProducer(path, 'test-producer');
	let sequence = producer.nextProducerSequence;
	const envelope = {
		v: 1 as const,
		conversationId: 'conversation',
		harness: 'default',
		session: 'default',
		timestamp: '2026-09-17T00:00:00.000Z',
	};
	const append = async (record: CanonicalRecord) => {
		const submission = record.submissionId
			? { submissionId: record.submissionId, attemptId: 'attempt' }
			: undefined;
		await store.append({
			path,
			...producer,
			producerSequence: sequence++,
			submission,
			records: [submission ? { ...record, attemptId: submission.attemptId } : record],
		});
	};
	await append({
		...envelope,
		id: 'created',
		type: 'conversation_created',
		kind: 'root',
		affinityKey: 'case',
		createdAt: envelope.timestamp,
	});
	const user = async (id: string, parentId: string | null) => {
		await append({
			...envelope,
			id,
			type: 'user_message',
			messageId: `entry_${id}`,
			parentId: parentId ? `entry_${parentId}` : null,
			submissionId: id,
			content: [{ type: 'text', text: id }],
		});
	};
	const assistant = async (id: string, parentId: string, complete = true) => {
		const base = { ...envelope, submissionId: 'original', turnId: id };
		await append({
			...base,
			id: `${id}-start`,
			type: 'assistant_message_started',
			messageId: `entry_${id}`,
			parentId: parentId ? `entry_${parentId}` : null,
			modelInfo: {
				api: 'openai-responses',
				provider: 'openai',
				model: 'synthetic',
			},
		});
		await append({
			...base,
			id: `${id}-text-start`,
			type: 'assistant_text_started',
			messageId: `entry_${id}`,
			blockId: id,
			blockIndex: 0,
		});
		await append({
			...base,
			id: `${id}-delta`,
			type: 'assistant_text_delta',
			messageId: `entry_${id}`,
			blockId: id,
			sequence: 0,
			delta: id,
		});
		if (!complete) return;
		await append({
			...base,
			id: `${id}-text-end`,
			type: 'assistant_text_completed',
			messageId: `entry_${id}`,
			blockId: id,
			deltaCount: 1,
		});
		await append({
			...base,
			id: `${id}-end`,
			type: 'assistant_message_completed',
			messageId: `entry_${id}`,
			stopReason: 'stop',
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
	};
	const read = async (query: string) => {
		const response = await handleAgentConversationRead({
			store,
			path,
			request: new Request(`http://test/conversation${query}`),
		});
		expect(response.status).toBe(200);
		return response;
	};
	return { append, envelope, user, assistant, read };
}

describe('Flue steering transcript order', () => {
	it('preserves data anchors and response metadata across a steering boundary', async () => {
		const test = await fixture();
		await test.user('original', null);
		await test.assistant('before', 'original');
		await test.append({
			...test.envelope,
			submissionId: 'original',
			id: 'data-before',
			type: 'message_data_write',
			name: 'before',
			data: 1,
		});
		await test.user('steer', 'before');
		await test.assistant('after', 'steer');
		await test.append({
			...test.envelope,
			submissionId: 'original',
			id: 'data-after',
			type: 'message_data_write',
			name: 'after',
			data: 2,
		});
		await test.append({
			...test.envelope,
			submissionId: 'original',
			id: 'data-update',
			type: 'message_data_write',
			name: 'before',
			data: 3,
		});
		await test.append({
			...test.envelope,
			submissionId: 'original',
			id: 'metadata',
			type: 'message_metadata',
			metadata: { complete: true },
		});

		const history: AgentConversationSnapshot = await (await test.read('?view=history')).json();
		const assistants = history.messages.filter((message) => message.role === 'assistant');
		expect(
			assistants.map((message) => ({
				id: message.id,
				metadata: message.metadata,
				data: message.parts.filter((part) => part.type.startsWith('data-')),
			})),
		).toEqual([
			{
				id: 'entry_before',
				metadata: { complete: true },
				data: [{ type: 'data-before', data: 3 }],
			},
			{
				id: 'entry_after',
				metadata: { complete: true },
				data: [{ type: 'data-after', data: 2 }],
			},
		]);
		const chunks: ConversationStreamChunk[] = await (
			await test.read('?view=updates&offset=-1')
		).json();
		expect(
			chunks
				.filter((chunk) => chunk.type === 'data-part')
				.map((chunk) => [chunk.messageId, chunk.name, chunk.data]),
		).toEqual([
			['entry_before', 'before', 1],
			['entry_after', 'after', 2],
			['entry_before', 'before', 3],
		]);
		expect(
			chunks
				.filter((chunk) => chunk.type === 'message-metadata')
				.map((chunk) => [chunk.messageId, chunk.metadata]),
		).toEqual([
			['entry_before', { complete: true }],
			['entry_after', { complete: true }],
		]);
	});

	it.each([false, true])(
		'splits the continuation after a steering message (completed=%s)',
		async (complete) => {
			const test = await fixture();
			await test.user('original', null);
			await test.assistant('before-1', 'original');
			await test.assistant('before-2', 'before-1');
			await test.user('steer', 'before-2');
			await test.assistant('after', 'steer', complete);

			const history: AgentConversationSnapshot = await (await test.read('?view=history')).json();
			expect(
				history.messages.map((message) => ({
					id: message.id.replace('entry_', ''),
					parts: message.parts,
				})),
			).toEqual([
				{
					id: 'original',
					parts: [{ type: 'text', text: 'original', state: 'done' }],
				},
				{
					id: 'before-1',
					parts: [
						{ type: 'text', text: 'before-1', state: 'done' },
						{ type: 'text', text: 'before-2', state: 'done' },
					],
				},
				{
					id: 'steer',
					parts: [{ type: 'text', text: 'steer', state: 'done' }],
				},
				{
					id: 'after',
					parts: [
						{
							type: 'text',
							text: 'after',
							state: complete ? 'done' : 'streaming',
						},
					],
				},
			]);

			const chunks: ConversationStreamChunk[] = await (
				await test.read('?view=updates&offset=-1')
			).json();
			expect(
				chunks
					.filter((chunk) => chunk.type === 'message-started')
					.map((chunk) => chunk.messageId.replace('entry_', '')),
			).toEqual(['before-1', 'before-1', 'after']);
			expect(
				chunks
					.filter((chunk) => chunk.type === 'message-delta')
					.map((chunk) => [chunk.messageId.replace('entry_', ''), chunk.delta]),
			).toEqual([
				['before-1', 'before-1'],
				['before-1', 'before-2'],
				['after', 'after'],
			]);
		},
	);
});
