import { describe, expect, it, vi } from 'vitest';
import {
	coordinatorToolApprovalDecisionRecord,
	coordinatorToolApprovalRequestedRecord,
	isBindingOnlyInternalUrl,
	nextSubmissionWakeSlot,
} from './cloudflare/agent-coordinator.ts';
import {
	projectAgentConversationBatch,
	projectAgentConversationSnapshot,
} from './conversation-public.ts';
import type { ConversationRecord } from './conversation-records.ts';
import { createReducedInstanceState, reduceConversationRecords } from './conversation-reducer.ts';
import { ConversationRecordWriter } from './conversation-writer.ts';
import { InMemoryConversationStreamStore } from './runtime/conversation-stream-store.ts';
import { Session } from './session.ts';
import type { ToolApproval } from './tool-approval.ts';

const conversationId = 'conversation-1';

function envelope<TType extends ConversationRecord['type']>(
	type: TType,
	id: string,
	timestamp: string,
) {
	return {
		v: 1 as const,
		id,
		type,
		conversationId,
		harness: 'default',
		session: 'default',
		timestamp,
	};
}

const created = {
	...envelope('conversation_created', 'record-created', '2026-09-03T12:00:00.000Z'),
	kind: 'root',
	affinityKey: 'instance-1',
	createdAt: '2026-09-03T12:00:00.000Z',
} satisfies ConversationRecord;

const requested = {
	...envelope(
		'tool_approval_requested',
		'record-tool-approval-requested-1',
		'2026-09-03T12:01:00.000Z',
	),
	proposalId: 'approval-1',
	submissionId: 'submission-1',
	assistantMessageId: 'assistant-1',
	toolCallId: 'call-1',
	toolName: 'send_payment',
	toolVersion: '3',
	arguments: { amount: 125, currency: 'USD' },
	requestedAt: 1_788_437_455_000,
	expiresAt: 1_788_437_460_000,
	presentation: {
		title: 'Send payment',
		description: 'Review the destination and amount.',
	},
} satisfies ConversationRecord;

const decided = {
	...envelope(
		'tool_approval_decided',
		'record-tool-approval-decided-1',
		'2026-09-03T12:02:00.000Z',
	),
	proposalId: requested.proposalId,
	submissionId: requested.submissionId,
	status: 'approved',
	decidedAt: 1_788_437_519_000,
	reason: 'Approved by an operator.',
} satisfies ConversationRecord;

describe('public tool approval projection', () => {
	it('alternates heartbeat slots away from the currently executing schedule row', () => {
		expect(nextSubmissionWakeSlot(undefined)).toBe(0);
		expect(nextSubmissionWakeSlot(0)).toBe(1);
		expect(nextSubmissionWakeSlot(1)).toBe(0);
	});

	it('recognizes private coordinator routes only on the binding-only origin', () => {
		const path = '/__flue/internal/tool-approval';
		expect(isBindingOnlyInternalUrl(new Request(`https://flue.invalid${path}`), path)).toBe(true);
		expect(isBindingOnlyInternalUrl(new Request(`https://example.test${path}`), path)).toBe(false);
	});

	it('writes parked decisions as coordinator-owned records without attempt authorization', async () => {
		const store = new InMemoryConversationStreamStore();
		const writer = await ConversationRecordWriter.create({
			store,
			path: 'agents/payments/instance-1',
			identity: { agentName: 'payments', instanceId: 'instance-1' },
			producerId: 'coordinator',
		});
		const approval: ToolApproval = {
			proposalId: requested.proposalId,
			submissionId: requested.submissionId,
			instanceId: 'instance-1',
			conversationId,
			harness: 'default',
			session: 'default',
			assistantMessageId: requested.assistantMessageId,
			toolCallId: requested.toolCallId,
			toolName: requested.toolName,
			toolVersion: requested.toolVersion,
			arguments: requested.arguments,
			requestedAt: requested.requestedAt,
			status: 'approved',
			decidedAt: decided.decidedAt,
			reason: decided.reason,
		};
		const requestRecord = coordinatorToolApprovalRequestedRecord(approval);
		const decisionRecord = coordinatorToolApprovalDecisionRecord(approval);

		expect(requestRecord.attemptId).toBeUndefined();
		expect(decisionRecord.submissionId).toBeUndefined();
		await writer.append([created]);
		// The coordinator and resumed session can race this repair. Both use the
		// same builder, and the serialized writer accepts an identical record ID
		// without poisoning the producer claim.
		await expect(
			Promise.all([writer.append([requestRecord]), writer.append([requestRecord])]),
		).resolves.toHaveLength(2);
		await expect(
			Promise.all([writer.append([decisionRecord]), writer.append([decisionRecord])]),
		).resolves.toHaveLength(2);
		await expect(writer.hasRecord(requestRecord.id)).resolves.toBe(true);
		await expect(writer.hasRecord(decisionRecord.id)).resolves.toBe(true);
	});

	it('reconstructs pending and decided approvals in a history snapshot', () => {
		const anotherRequest = {
			...envelope(
				'tool_approval_requested',
				'record-tool-approval-requested-2',
				'2026-09-03T12:01:30.000Z',
			),
			proposalId: 'approval-2',
			submissionId: 'submission-2',
			assistantMessageId: 'assistant-2',
			toolCallId: 'call-2',
			toolName: 'delete_export',
			toolVersion: '1',
			arguments: { exportId: 'export-7' },
		} satisfies ConversationRecord;
		const state = reduceConversationRecords(
			createReducedInstanceState(),
			[created, requested, anotherRequest, decided],
			'3',
		);

		expect(projectAgentConversationSnapshot(state)).toEqual({
			v: 1,
			conversationId,
			offset: '3',
			messages: [],
			settlements: [],
			toolApprovals: [
				{
					proposalId: 'approval-1',
					submissionId: 'submission-1',
					assistantMessageId: 'assistant-1',
					toolCallId: 'call-1',
					toolName: 'send_payment',
					toolVersion: '3',
					arguments: { amount: 125, currency: 'USD' },
					status: 'approved',
					requestedAt: 1_788_437_455_000,
					expiresAt: 1_788_437_460_000,
					presentation: {
						title: 'Send payment',
						description: 'Review the destination and amount.',
					},
					decidedAt: 1_788_437_519_000,
					reason: 'Approved by an operator.',
				},
				{
					proposalId: 'approval-2',
					submissionId: 'submission-2',
					assistantMessageId: 'assistant-2',
					toolCallId: 'call-2',
					toolName: 'delete_export',
					toolVersion: '1',
					arguments: { exportId: 'export-7' },
					status: 'pending',
					requestedAt: Date.parse('2026-09-03T12:01:30.000Z'),
				},
			],
		});
	});

	it('projects approval changes as legacy-compatible snapshot resets', () => {
		const initial = reduceConversationRecords(createReducedInstanceState(), [created], '0');
		const pending = reduceConversationRecords(initial, [requested], '1');
		const requestChunks = projectAgentConversationBatch({
			state: pending,
			previousState: initial,
			records: [requested],
			batchOrdinal: 8,
		});

		expect(requestChunks).toEqual([
			expect.objectContaining({
				type: 'conversation-reset',
				conversationId,
				position: { batch: 8, index: 0 },
				snapshot: expect.objectContaining({
					toolApprovals: [expect.objectContaining({ proposalId: 'approval-1', status: 'pending' })],
				}),
			}),
		]);

		const terminal = reduceConversationRecords(pending, [decided], '2');
		const decisionOptions = {
			state: terminal,
			previousState: pending,
			records: [decided],
			batchOrdinal: 9,
		};
		const decisionChunks = projectAgentConversationBatch(decisionOptions);
		expect(decisionChunks).toEqual([
			expect.objectContaining({
				type: 'conversation-reset',
				conversationId,
				position: { batch: 9, index: 0 },
				snapshot: expect.objectContaining({
					toolApprovals: [
						expect.objectContaining({ proposalId: 'approval-1', status: 'approved' }),
					],
				}),
			}),
		]);
		// A durable-stream redelivery produces the same reset and position.
		expect(projectAgentConversationBatch(decisionOptions)).toEqual(decisionChunks);
	});

	it('keeps a terminal decision when crash repair appends its request later', () => {
		const state = reduceConversationRecords(
			createReducedInstanceState(),
			[created, decided, requested],
			'2',
		);

		expect(projectAgentConversationSnapshot(state)?.toolApprovals).toEqual([
			expect.objectContaining({ proposalId: 'approval-1', status: 'approved' }),
		]);
	});

	it('persists frozen presentation hints on the canonical request record', async () => {
		const appendCanonical = vi.fn(async (_records: ConversationRecord[]) => {});
		const fakeSession = {
			conversationWriter: { hasRecord: vi.fn(async () => false) },
			canonicalEnvelope: (type: string, id: string) =>
				envelope(type as ConversationRecord['type'], id, '2026-09-03T12:01:00.000Z'),
			appendCanonical,
		};
		const ensureApprovalRequestedRecord = Reflect.get(
			Session.prototype,
			'ensureApprovalRequestedRecord',
		) as (this: typeof fakeSession, approval: ToolApproval) => Promise<void>;
		const approval: ToolApproval = {
			proposalId: requested.proposalId,
			submissionId: requested.submissionId,
			instanceId: 'instance-1',
			conversationId,
			harness: 'default',
			session: 'default',
			assistantMessageId: requested.assistantMessageId,
			toolCallId: requested.toolCallId,
			toolName: requested.toolName,
			toolVersion: requested.toolVersion,
			arguments: requested.arguments,
			requestedAt: Date.parse(requested.timestamp),
			expiresAt: requested.expiresAt,
			presentation: requested.presentation,
			status: 'pending',
		};

		await ensureApprovalRequestedRecord.call(fakeSession, approval);

		expect(appendCanonical).toHaveBeenCalledWith([
			expect.objectContaining({
				type: 'tool_approval_requested',
				proposalId: 'approval-1',
				requestedAt: Date.parse(requested.timestamp),
				presentation: {
					title: 'Send payment',
					description: 'Review the destination and amount.',
				},
			}),
		]);
	});
});
