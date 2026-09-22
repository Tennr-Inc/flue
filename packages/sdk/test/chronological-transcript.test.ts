import { describe, expect, it } from 'vitest';
import {
	projectAgentConversationBatch,
	projectAgentConversationSnapshot,
} from '../../runtime/src/conversation-public.ts';
import type { ConversationRecord } from '../../runtime/src/conversation-records.ts';
import {
	createReducedInstanceState,
	reduceConversationRecords,
	toolResultEntryId,
} from '../../runtime/src/conversation-reducer.ts';
import { InMemoryConversationStreamStore } from '../../runtime/src/runtime/conversation-stream-store.ts';
import { handleAgentConversationRead } from '../../runtime/src/runtime/handle-conversation-routes.ts';
import { createFlueClient } from '../src/client.ts';
import type { FlueConversationTranscript } from '../src/public/conversation.ts';
import {
	applyConversationChunk,
	createConversationStreamState,
} from '../src/public/conversation-stream.ts';
import { readSubmissionReply } from '../src/public/reply.ts';

const timestamp = '2026-09-22T12:00:00.000Z';
const envelope = {
	v: 1 as const,
	conversationId: 'conversation',
	harness: 'default',
	session: 'default',
	timestamp,
	submissionId: 'submission',
	attemptId: 'attempt',
};
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type RecordInput = ConversationRecord extends infer R
	? R extends ConversationRecord
		? Omit<R, keyof typeof envelope | 'id'> & Partial<Pick<R, keyof typeof envelope & keyof R>>
		: never
	: never;

function fixture(steers = true, reuseToolIds = true): ConversationRecord[] {
	const records: ConversationRecord[] = [];
	function add(record: RecordInput) {
		records.push({ ...envelope, id: `record-${records.length}`, ...record } as ConversationRecord);
	}
	add({
		type: 'conversation_created',
		kind: 'root',
		affinityKey: 'instance',
		createdAt: timestamp,
	});
	let parentId: string | null = null;
	for (let step = 1; step <= 3; step++) {
		const messageId = `entry_assistant-${step}`;
		const blockId = `text-${step}`;
		const toolCallId = reuseToolIds ? 'reused-call-id' : `call-${step}`;
		if (step === 1 || steers)
			add({
				type: 'user_message',
				messageId: `entry_user-${step}`,
				parentId,
				submissionId: step === 1 ? 'submission' : `steer-${step}`,
				content: [{ type: 'text', text: `Input ${step}` }],
			});
		add({
			type: 'assistant_message_started',
			messageId,
			parentId: step === 1 || steers ? `entry_user-${step}` : parentId,
			turnId: `turn-${step}`,
			modelInfo: { api: 'openai-responses', provider: 'openai', model: 'test' },
			...(step === 1 ? { responseMetadata: { start: true } } : {}),
		});
		add({ type: 'assistant_text_started', messageId, blockId, blockIndex: 0 });
		add({ type: 'assistant_text_delta', messageId, blockId, sequence: 0, delta: `Answer ${step}` });
		add({ type: 'assistant_text_completed', messageId, blockId, deltaCount: 1 });
		add({
			type: 'assistant_tool_call',
			messageId,
			blockId: `tool-${step}`,
			blockIndex: 1,
			toolCallId,
			name: 'lookup',
			arguments: { step },
		});
		add({ type: 'assistant_message_completed', messageId, stopReason: 'toolUse', usage });
		const outcomeId = `record-${records.length}`;
		add({
			type: 'tool_outcome',
			assistantMessageId: messageId,
			toolCallId,
			toolName: 'lookup',
			isError: step === 2,
			content: [{ type: 'text', text: `Result ${step}` }],
			output: { step },
			durationMs: step,
		});
		add({
			type: 'tool_results_committed',
			assistantMessageId: messageId,
			parentId: messageId,
			outcomeIds: [outcomeId],
		});
		add({ type: 'message_data_write', name: 'progress', data: { step } });
		add({ type: 'message_data_write', name: `step${step}`, data: step });
		parentId = toolResultEntryId(messageId, toolCallId);
	}
	add({ type: 'state_write', name: 'secret', value: 'private-runtime-state' });
	add({ type: 'message_metadata', metadata: { finished: true } });
	for (const submissionId of ['submission', 'steer-2', 'steer-3'])
		add({ type: 'submission_settled', submissionId, outcome: 'completed' });
	return records;
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error('Missing test fixture value');
	return value;
}

function snapshot(records: ConversationRecord[], transcript?: FlueConversationTranscript) {
	return required(
		projectAgentConversationSnapshot(
			reduceConversationRecords(createReducedInstanceState(), records),
			transcript,
		),
	);
}

describe('chronological transcript', () => {
	it('preserves step identity around multiple steers while the default stays combined', () => {
		const chronological = snapshot(fixture(), 'chronological');
		expect(JSON.stringify(chronological)).not.toContain('private-runtime-state');
		expect(chronological.messages.map(({ id }) => id)).toEqual([
			'entry_user-1',
			'entry_assistant-1',
			'entry_user-2',
			'entry_assistant-2',
			'entry_user-3',
			'entry_assistant-3',
		]);
		expect(
			chronological.messages.filter(({ role }) => role === 'assistant').map(({ turnId }) => turnId),
		).toEqual(['turn-1', 'turn-2', 'turn-3']);
		const combined = snapshot(fixture());
		expect(combined.transcript).toBeUndefined();
		expect(combined.messages.map(({ id }) => id)).toEqual([
			'entry_user-1',
			'entry_assistant-1',
			'entry_user-2',
			'entry_user-3',
		]);
		expect(snapshot(fixture(), 'combined')).toEqual(combined);
		expect(readSubmissionReply(chronological, 'submission')).toEqual(
			readSubmissionReply(combined, 'submission'),
		);
		expect(readSubmissionReply(chronological, 'steer-2')).toEqual(
			readSubmissionReply(combined, 'steer-2'),
		);
		expect(readSubmissionReply(combined, 'submission')).toEqual({
			text: 'Answer 1\n\nAnswer 2\n\nAnswer 3',
			data: { progress: [{ step: 3 }], step1: [1], step2: [2], step3: [3] },
			metadata: { start: true, finished: true },
		});
	});

	it('separates consecutive assistant steps without steering', () => {
		expect(snapshot(fixture(false), 'chronological').messages.map(({ id }) => id)).toEqual([
			'entry_user-1',
			'entry_assistant-1',
			'entry_assistant-2',
			'entry_assistant-3',
		]);
	});

	it('keeps the default live projection and legacy reply selection unchanged', () => {
		let state = createReducedInstanceState();
		let live = createConversationStreamState({
			v: 1,
			conversationId: 'conversation',
			offset: '-1',
			messages: [],
			settlements: [],
			toolApprovals: [],
		});
		for (const [batchOrdinal, record] of fixture(true, false).entries()) {
			state = reduceConversationRecords(state, [record]);
			for (const chunk of projectAgentConversationBatch({ state, records: [record], batchOrdinal }))
				live = applyConversationChunk(live, chunk);
		}
		expect(live).toEqual(createConversationStreamState(snapshot(fixture(true, false))));
		const chronological = snapshot(fixture(true, false), 'chronological');
		const { transcript: _, ...legacy } = chronological;
		expect(readSubmissionReply(legacy, 'submission').text).toBe('Answer 3');
	});

	it('retains chronological view in approval reset snapshots', () => {
		let state = reduceConversationRecords(createReducedInstanceState(), fixture().slice(0, 8));
		const record: ConversationRecord = {
			...envelope,
			id: 'approval',
			type: 'tool_approval_requested',
			proposalId: 'proposal',
			assistantMessageId: 'entry_assistant-1',
			toolCallId: 'reused-call-id',
			toolName: 'lookup',
			toolVersion: '1',
			arguments: { step: 1 },
			requestedAt: Date.parse(timestamp),
		};
		state = reduceConversationRecords(state, [record]);
		const chunks = projectAgentConversationBatch({
			state,
			records: [record],
			batchOrdinal: 8,
			transcript: 'chronological',
		});
		expect(chunks).toMatchObject([
			{
				type: 'conversation-reset',
				snapshot: {
					transcript: 'chronological',
					toolApprovals: [
						{ assistantMessageId: 'entry_assistant-1', toolCallId: 'reused-call-id' },
					],
				},
			},
		]);
		expect(
			applyConversationChunk(
				createConversationStreamState(snapshot(fixture().slice(0, 8), 'chronological')),
				required(chunks[0]),
			),
		).toEqual(
			createConversationStreamState(
				required(projectAgentConversationSnapshot(state, 'chronological')),
			),
		);
	});

	it('retracts superseded error content without merging the replacement step', () => {
		const records = fixture()
			.filter(
				(record) =>
					record.type === 'conversation_created' ||
					(record.type === 'user_message' && record.messageId === 'entry_user-1') ||
					('messageId' in record &&
						['entry_assistant-1', 'entry_assistant-2'].includes(record.messageId) &&
						record.type !== 'assistant_tool_call'),
			)
			.map((record): ConversationRecord => {
				if (record.type === 'assistant_message_completed')
					return {
						...record,
						stopReason: record.messageId === 'entry_assistant-1' ? 'error' : 'stop',
					};
				if (record.type === 'assistant_message_started' && record.messageId === 'entry_assistant-2')
					return { ...record, parentId: 'entry_assistant-1' };
				return record;
			});
		const restart = records.findIndex(
			(record) =>
				record.type === 'assistant_message_started' && record.messageId === 'entry_assistant-2',
		);
		let state = reduceConversationRecords(createReducedInstanceState(), records.slice(0, restart));
		let live = createConversationStreamState(
			required(projectAgentConversationSnapshot(state, 'chronological')),
		);
		for (const [batchOrdinal, record] of records.slice(restart).entries()) {
			state = reduceConversationRecords(state, [record]);
			for (const chunk of projectAgentConversationBatch({
				state,
				records: [record],
				batchOrdinal,
				transcript: 'chronological',
			}))
				live = applyConversationChunk(live, chunk);
		}
		expect(live).toEqual(createConversationStreamState(snapshot(records, 'chronological')));
		expect(live.messages.find(({ id }) => id === 'entry_assistant-1')?.parts).toEqual([]);
		expect(readSubmissionReply(live, 'submission').text).toBe('Answer 2');
	});

	it('matches reload at each streaming boundary and every reconnect offset', () => {
		const records = fixture();
		// Text-completed itself is intentionally not a public event: message completion
		// closes the streaming part. Check boundaries the public protocol represents.
		for (let resume = 1; resume <= records.length; resume++) {
			let state = reduceConversationRecords(createReducedInstanceState(), records.slice(0, resume));
			let live = createConversationStreamState(
				required(projectAgentConversationSnapshot(state, 'chronological')),
			);
			for (let i = resume; i < records.length; i++) {
				const previousState = state;
				state = reduceConversationRecords(state, [required(records[i])]);
				for (const chunk of projectAgentConversationBatch({
					state,
					previousState,
					records: [required(records[i])],
					batchOrdinal: i,
					transcript: 'chronological',
				}))
					live = applyConversationChunk(live, chunk);
				if (
					[
						'assistant_message_started',
						'assistant_text_delta',
						'assistant_message_completed',
						'tool_results_committed',
						'message_data_write',
						'message_metadata',
						'submission_settled',
					].includes(required(records[i]).type)
				) {
					expect(live, `resume ${resume}, record ${i}`).toEqual(
						createConversationStreamState(
							required(projectAgentConversationSnapshot(state, 'chronological')),
						),
					);
				}
			}
		}
	});

	it('keeps data rewrites anchored and repeated tool IDs correlated', () => {
		const messages = snapshot(fixture(), 'chronological').messages.filter(
			({ role }) => role === 'assistant',
		);
		expect(required(messages[0]).parts.filter(({ type }) => type.startsWith('data-'))).toEqual([
			{ type: 'data-progress', data: { step: 3 } },
			{ type: 'data-step1', data: 1 },
		]);
		expect(
			messages.map((message) => message.parts.find(({ type }) => type === 'dynamic-tool')),
		).toMatchObject([
			{ state: 'output-available', output: { step: 1 }, durationMs: 1 },
			{ state: 'output-error', errorText: 'Result 2', durationMs: 2 },
			{ state: 'output-available', output: { step: 3 }, durationMs: 3 },
		]);
	});

	it.each(['sse', 'long-poll'] as const)(
		'keeps history, %s, reconnect and refresh scoped to the SDK option',
		async (live) => {
			const store = new InMemoryConversationStreamStore();
			const path = '/agent';
			await store.createStream(path, { agentName: 'Agent', instanceId: 'instance' });
			const claim = await store.acquireProducer(path, 'test');
			const records = fixture();
			let sequence = 0;
			const append = async (batch: ConversationRecord[]) => {
				for (const record of batch)
					await store.append({
						path,
						producerId: claim.producerId,
						producerEpoch: claim.producerEpoch,
						incarnation: claim.incarnation,
						producerSequence: sequence++,
						submission: {
							submissionId: required(record.submissionId),
							attemptId: required(record.attemptId),
						},
						records: [record],
					});
			};
			await append(records.slice(0, 13));
			const urls: URL[] = [];
			let rejectFirstResume = true;
			const fetch: typeof globalThis.fetch = async (input, init) => {
				const request = new Request(input, init);
				const url = new URL(request.url);
				urls.push(url);
				if (url.searchParams.get('view') === 'updates' && rejectFirstResume) {
					rejectFirstResume = false;
					// An expired offset forces observe() to reconnect through fresh history.
					return new Response('Offset gone', { status: 416 });
				}
				return handleAgentConversationRead({ store, path, request });
			};
			const client = createFlueClient({ url: 'http://local/agent', fetch });
			expect((await client.history()).transcript).toBeUndefined();
			const observation = client.observe({ transcript: 'chronological', live });
			const unsubscribe = observation.subscribe(() => {});
			try {
				await expect.poll(() => observation.getSnapshot().phase).toBe('live');
				await append(records.slice(13));
				await expect.poll(() => observation.getSnapshot().conversation?.settlements.length).toBe(3);
				const history = await client.history({ transcript: 'chronological' });
				expect(observation.getSnapshot().conversation).toEqual(
					createConversationStreamState(history),
				);
				observation.refresh();
				await expect
					.poll(() => urls.filter((url) => url.searchParams.get('view') === 'history').length)
					.toBeGreaterThanOrEqual(5);
				await expect.poll(() => observation.getSnapshot().phase).toBe('live');
				expect(observation.getSnapshot().conversation).toEqual(
					createConversationStreamState(history),
				);
				expect(
					urls.slice(1).every((url) => url.searchParams.get('transcript') === 'chronological'),
				).toBe(true);
			} finally {
				unsubscribe();
				observation.close();
			}
			const invalid = await handleAgentConversationRead({
				store,
				path,
				request: new Request('http://local/agent?transcript=raw'),
			});
			expect(invalid.status).toBe(400);
		},
	);
});
