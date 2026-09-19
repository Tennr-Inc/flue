import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import type { ConversationRecord } from './conversation-records.ts';
import { ConversationRecordWriter } from './conversation-writer.ts';
import { InMemoryConversationStreamStore } from './runtime/conversation-stream-store.ts';
import { Session } from './session.ts';

const envelope = {
	v: 1 as const,
	conversationId: 'conv',
	harness: 'default',
	session: 'default',
	submissionId: 'submission',
	attemptId: 'attempt',
	timestamp: '2026-09-19T00:00:00.000Z',
};

const authorization = { submission: { submissionId: 'submission', attemptId: 'attempt' } };

// Use the real outcome construction, durable fold, and terminal reporting;
// the model loop is not needed once all tool results have committed.
function terminalSession(writer: ConversationRecordWriter): Session {
	return Object.assign(Object.create(Session.prototype) as Session, {
		conversationId: 'conv',
		conversationWriter: writer,
		canonicalEnvelope: (type: string, id: string) => ({ ...envelope, type, id }),
		appendCanonical: (records: ConversationRecord[]) => writer.append(records, authorization),
		rebuildCanonicalContext: async () => {},
	});
}

describe('approved interruption metadata', () => {
	it.each([true, false])(
		'reports a repaired approved call but not an ordinary failure (interrupted=%s)',
		async (interrupted) => {
			const store = new InMemoryConversationStreamStore();
			const path = '/approved-interruption';
			const identity = { agentName: 'TestAgent', instanceId: 'test' };
			const writer = await ConversationRecordWriter.create({
				store,
				path,
				identity,
				producerId: 'before-restart',
			});
			const append = (records: ConversationRecord[]) => writer.append(records, authorization);
			await append([
				{
					...envelope,
					id: 'created',
					type: 'conversation_created',
					kind: 'root',
					affinityKey: 'test',
					createdAt: envelope.timestamp,
				},
				{
					...envelope,
					id: 'input',
					type: 'user_message',
					messageId: 'entry_user',
					parentId: null,
					content: [{ type: 'text', text: 'Perform the approved action.' }],
				},
				{
					...envelope,
					id: 'started',
					type: 'assistant_message_started',
					messageId: 'entry_assistant',
					parentId: 'entry_user',
					modelInfo: { provider: 'faux', api: 'openai-responses', model: 'model' },
				},
				{
					...envelope,
					id: 'call',
					type: 'assistant_tool_call',
					messageId: 'entry_assistant',
					blockId: 'block',
					blockIndex: 0,
					toolCallId: 'approved-call',
					name: 'approved_action',
					arguments: {},
				},
				{
					...envelope,
					id: 'completed',
					type: 'assistant_message_completed',
					messageId: 'entry_assistant',
					stopReason: 'toolUse',
					usage: fauxAssistantMessage('done').usage,
				},
			]);
			const session = terminalSession(writer);
			const buildOutcome = Reflect.get(
				Session.prototype,
				interrupted ? 'approvalInterruptedOutcomeRecord' : 'approvalFailureOutcomeRecord',
			) as (
				this: Session,
				assistant: string,
				call: { id: string; name: string },
				message?: string,
			) => ConversationRecord;
			const outcome = buildOutcome.call(
				session,
				'entry_assistant',
				{ id: 'approved-call', name: 'approved_action' },
				'Ordinary tool failure.',
			);
			await append([
				outcome,
				{
					...envelope,
					id: 'commit',
					type: 'tool_results_committed',
					assistantMessageId: 'entry_assistant',
					parentId: 'entry_assistant',
					outcomeIds: [outcome.id],
				},
			]);
			const reopened = await ConversationRecordWriter.create({
				store,
				path,
				identity,
				producerId: 'after-restart',
			});
			const terminal = terminalSession(reopened);
			const input = {
				kind: 'direct' as const,
				submissionId: 'submission',
				reason: 'aborted' as const,
				message: 'Submission aborted.',
			};
			const expected = interrupted ? [{ id: 'approved-call', name: 'approved_action' }] : [];
			expect(await terminal.recordSubmissionTerminal(input)).toEqual(expected);
			// Idempotent terminalization must retain the same advisory on retry.
			expect(await terminal.recordSubmissionTerminal(input)).toEqual(expected);
			const signals = (await store.read(path)).batches
				.flatMap((batch) => batch.records)
				.filter((record) => record.type === 'signal');
			expect(signals).toHaveLength(1);
			const metadata = signals[0]?.attributes?.interruptedTools;
			expect(metadata === undefined ? [] : JSON.parse(metadata)).toEqual(expected);
		},
	);
});
