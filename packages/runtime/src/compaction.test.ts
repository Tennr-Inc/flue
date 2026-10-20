import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from './compaction.ts';

function user(text: string): AgentMessage {
	return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 };
}

function toolResult(id: string, text: string): AgentMessage {
	return {
		role: 'toolResult',
		toolCallId: id,
		toolName: 'query',
		content: [{ type: 'text', text }],
		isError: false,
		timestamp: 1,
	};
}

const toolBatchRequest = fauxAssistantMessage(
	[fauxToolCall('query', {}, { id: 'call-1' }), fauxToolCall('query', {}, { id: 'call-2' })],
	{ stopReason: 'toolUse' },
);

describe('prepareCompaction cut point', () => {
	it('keeps an oversized trailing tool batch with its requesting assistant', () => {
		// Each result alone exceeds the 8k-token recent budget (4 chars per token).
		const large = 'x'.repeat(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens * 4 + 4);
		const messages = [
			user('Earlier question.'),
			fauxAssistantMessage([fauxText('Earlier answer.')], { stopReason: 'stop' }),
			user('Inspect the schema.'),
			toolBatchRequest,
			toolResult('call-1', large),
			toolResult('call-2', large),
		];

		const preparation = prepareCompaction(messages, DEFAULT_COMPACTION_SETTINGS);

		expect(preparation).toMatchObject({
			firstKeptIndex: 3,
			isSplitTurn: true,
			messagesToSummarize: messages.slice(0, 2),
			turnPrefixMessages: [messages[2]],
		});
	});

	it('still cuts at the boundary where the recent budget fills', () => {
		const messages = [
			user('Earlier question.'),
			fauxAssistantMessage([fauxText('Earlier answer.')], { stopReason: 'stop' }),
			user('x'.repeat(DEFAULT_COMPACTION_SETTINGS.keepRecentTokens * 4)),
			toolBatchRequest,
			toolResult('call-1', 'small'),
			toolResult('call-2', 'small'),
		];

		const preparation = prepareCompaction(messages, DEFAULT_COMPACTION_SETTINGS);

		expect(preparation).toMatchObject({
			firstKeptIndex: 2,
			isSplitTurn: false,
			messagesToSummarize: messages.slice(0, 2),
			turnPrefixMessages: [],
		});
	});
});
