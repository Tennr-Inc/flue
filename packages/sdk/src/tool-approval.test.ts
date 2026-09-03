import { describe, expect, it } from 'vitest';
import { createFlueClient } from './client.ts';
import type { FlueConversationSnapshot, FlueToolApproval } from './public/conversation.ts';
import {
	applyConversationChunk,
	type ConversationStreamChunk,
	createConversationStreamState,
} from './public/conversation-stream.ts';

const approval: FlueToolApproval = {
	proposalId: 'approval-1',
	submissionId: 'submission-1',
	assistantMessageId: 'assistant-1',
	toolCallId: 'tool-call-1',
	toolName: 'deploy',
	toolVersion: '1',
	arguments: { environment: 'production' },
	requestedAt: 1_700_000_000_000,
	status: 'pending',
};

function snapshot(toolApprovals: FlueToolApproval[] = []): FlueConversationSnapshot {
	return {
		v: 1,
		conversationId: 'conversation-1',
		offset: '0',
		messages: [],
		settlements: [],
		toolApprovals,
	};
}

describe('tool approval conversation state', () => {
	it('hydrates approvals from a materialized snapshot', () => {
		const state = createConversationStreamState(snapshot([approval]));

		expect(state.toolApprovals).toEqual([approval]);
	});

	it('applies approval changes through a legacy-compatible conversation reset', () => {
		const decidedApproval: FlueToolApproval = {
			...approval,
			status: 'rejected',
			decidedAt: 1_700_000_000_123,
			reason: 'Outside the approved change window.',
		};
		const reset: ConversationStreamChunk = {
			type: 'conversation-reset',
			conversationId: 'conversation-1',
			snapshot: snapshot([decidedApproval]),
			position: { batch: 1, index: 0 },
		};
		const state = applyConversationChunk(createConversationStreamState(snapshot()), reset);

		expect(state.toolApprovals).toEqual([decidedApproval]);
	});

	it('normalizes a pre-approval server conversation reset to an empty list', () => {
		const reset: ConversationStreamChunk = {
			type: 'conversation-reset',
			conversationId: 'conversation-1',
			snapshot: {
				v: 1,
				conversationId: 'conversation-1',
				offset: '0',
				messages: [],
				settlements: [],
			} as unknown as FlueConversationSnapshot,
			position: { batch: 1, index: 0 },
		};

		const state = applyConversationChunk(
			createConversationStreamState(snapshot([approval])),
			reset,
		);

		expect(state.toolApprovals).toEqual([]);
	});
});

describe('resolveToolApproval', () => {
	it('posts an encoded proposal path and decision body', async () => {
		const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const client = createFlueClient({
			url: 'https://example.test/agents/deployer/conversation-1',
			fetch: async (input, init) => {
				requests.push({ input, init });
				return Response.json({ ...approval, status: 'approved', decidedAt: 1_700_000_000_123 });
			},
		});

		const result = await client.resolveToolApproval('approval/a? #', {
			status: 'approved',
			reason: 'Approved by the release manager.',
		});

		expect(result).toMatchObject({ proposalId: approval.proposalId, status: 'approved' });
		expect(requests).toEqual([
			{
				input:
					'https://example.test/agents/deployer/conversation-1/tool-approvals/approval%2Fa%3F%20%23',
				init: {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						status: 'approved',
						reason: 'Approved by the release manager.',
					}),
					signal: undefined,
				},
			},
		]);
	});
});

describe('approval snapshot compatibility', () => {
	it('normalizes a pre-approval server snapshot to an empty approval list', async () => {
		const client = createFlueClient({
			url: 'https://example.test/agents/deployer/conversation-1',
			fetch: async () =>
				Response.json({
					v: 1,
					conversationId: 'conversation-1',
					offset: '0',
					messages: [],
					settlements: [],
				}),
		});

		await expect(client.history()).resolves.toMatchObject({ toolApprovals: [] });
	});
});
