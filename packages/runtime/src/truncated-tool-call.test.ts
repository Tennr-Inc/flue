import { describe, expect, it } from 'vitest';
import {
	classifyConversationSubmission,
	projectConversationUi,
} from './conversation-projections.ts';
import type { ConversationRecord } from './conversation-records.ts';
import {
	buildConversationContext,
	createReducedInstanceState,
	getActiveConversationPath,
	reduceConversationRecords,
} from './conversation-reducer.ts';
import { classifySubmissionState, findTrailingPartialToolBatch } from './submission-state.ts';

const timestamp = '2026-01-01T00:00:00.000Z';
const usage = {
	input: 10,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function truncatedToolCallRecords(): ConversationRecord[] {
	const envelope = {
		v: 1 as const,
		conversationId: 'conv_test',
		harness: 'default',
		session: 'default',
		timestamp,
		submissionId: 'sub_test',
	};
	return [
		{
			...envelope,
			id: 'record_conversation_created_conv_test',
			type: 'conversation_created',
			kind: 'root',
			affinityKey: 'affinity_test',
			createdAt: timestamp,
		},
		{
			...envelope,
			id: 'record_user',
			type: 'user_message',
			messageId: 'entry_user',
			parentId: null,
			content: [{ type: 'text', text: 'Write a long report.' }],
		},
		{
			...envelope,
			id: 'record_assistant_started',
			type: 'assistant_message_started',
			messageId: 'entry_assistant',
			parentId: 'entry_user',
			modelInfo: {
				api: 'openai-responses',
				provider: 'openai',
				model: 'test-model',
			},
		},
		{
			...envelope,
			id: 'record_assistant_tool_call',
			type: 'assistant_tool_call',
			messageId: 'entry_assistant',
			blockId: 'block_tool_call',
			blockIndex: 0,
			toolCallId: 'call_write',
			name: 'write',
			arguments: { path: 'report.md', content: 'truncated' },
		},
		{
			...envelope,
			id: 'record_assistant_completed',
			type: 'assistant_message_completed',
			messageId: 'entry_assistant',
			stopReason: 'length',
			usage,
		},
		{
			...envelope,
			id: 'record_tool_outcome',
			type: 'tool_outcome',
			assistantMessageId: 'entry_assistant',
			toolCallId: 'call_write',
			toolName: 'write',
			isError: true,
			content: [
				{
					type: 'text',
					text: 'Tool call "write" was not executed because its arguments may be truncated.',
				},
			],
		},
		{
			...envelope,
			id: 'record_tool_results_committed',
			type: 'tool_results_committed',
			assistantMessageId: 'entry_assistant',
			parentId: 'entry_assistant',
			outcomeIds: ['record_tool_outcome'],
		},
	];
}

describe('truncated tool calls', () => {
	it('commits their synthetic errors and resumes from the complete batch', () => {
		const state = reduceConversationRecords(
			createReducedInstanceState(),
			truncatedToolCallRecords(),
		);
		const conversation = state.conversations.get('conv_test');
		expect(conversation).toBeDefined();
		if (!conversation) return;

		expect(
			classifyConversationSubmission(conversation, 'entry_user', { contextWindow: 128_000 }),
		).toMatchObject({ kind: 'resume', mode: 'tool_results' });
		expect(buildConversationContext(conversation).map((message) => message.role)).toEqual([
			'user',
			'assistant',
			'toolResult',
		]);
		expect(projectConversationUi(conversation, '6').messages[1]?.parts[0]).toMatchObject({
			type: 'dynamic-tool',
			toolName: 'write',
			state: 'output-error',
		});
	});

	it('holds an unresolved length tool batch at the conversation leaf', () => {
		const records = truncatedToolCallRecords().slice(0, 5);
		records.push({
			v: 1,
			id: 'record_next_user',
			type: 'user_message',
			conversationId: 'conv_test',
			harness: 'default',
			session: 'default',
			timestamp,
			submissionId: 'sub_next',
			messageId: 'entry_next_user',
			parentId: 'entry_assistant',
			content: [{ type: 'text', text: 'Next input' }],
		});

		let failure: unknown;
		try {
			reduceConversationRecords(createReducedInstanceState(), records);
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({
			meta: {
				reason: 'Cannot advance the conversation while a tool batch is uncommitted.',
			},
		});
	});

	it('recognizes an unresolved length tool batch for safe repair', () => {
		const state = reduceConversationRecords(
			createReducedInstanceState(),
			truncatedToolCallRecords().slice(0, 5),
		);
		const conversation = state.conversations.get('conv_test');
		expect(conversation).toBeDefined();
		if (!conversation) return;
		const following = getActiveConversationPath(conversation).slice(1);

		expect(classifySubmissionState(following, { contextWindow: 128_000 })).toMatchObject({
			kind: 'tool_use_unresolved',
		});
		expect(findTrailingPartialToolBatch(following)).toMatchObject({
			entryId: 'entry_assistant',
			assistant: { stopReason: 'length' },
		});
	});

	it('still completes a length response without tool calls', () => {
		const assistant = {
			role: 'assistant' as const,
			content: [],
			api: 'openai-responses' as const,
			provider: 'openai',
			model: 'test-model',
			stopReason: 'length' as const,
			usage,
			timestamp: Date.parse(timestamp),
		};

		expect(
			classifySubmissionState(
				[
					{
						type: 'message',
						id: 'entry_assistant',
						message: assistant,
					},
				],
				{ contextWindow: 128_000 },
			),
		).toMatchObject({ kind: 'completed', assistant: { stopReason: 'length' } });
	});
});
