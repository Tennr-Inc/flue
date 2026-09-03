import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Context, ToolCall } from '@earendil-works/pi-ai';
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlueContext } from './client.ts';
import { ConversationRecordWriter } from './conversation-writer.ts';
import type { Harness } from './harness.ts';
import { useAgentFinish } from './hooks/use-agent-finish.ts';
import { useModel } from './hooks/use-model.ts';
import { usePersistentState } from './hooks/use-persistent-state.ts';
import { useResponseFinish } from './hooks/use-response-finish.ts';
import { useTool } from './hooks/use-tool.ts';
import { ensureInstanceIdentity, processSubmission } from './runtime/agent-submissions.ts';
import { InMemoryAttachmentStore } from './runtime/attachment-store.ts';
import { SqliteConversationStreamStore } from './runtime/conversation-stream-store.ts';
import { resetModelsForTests, resolveModel, setProvider } from './runtime/providers.ts';
import { agentStreamPath } from './runtime/stream-offsets.ts';
import {
	createSqlAgentExecutionStoreFromSql,
	ensureSqlAgentExecutionTables,
} from './sql-agent-execution-store.ts';
import type { SqlStorage } from './sql-storage.ts';
import type { Agent } from './types.ts';

function toolRequest(...calls: ToolCall[]) {
	return fauxAssistantMessage(calls, { stopReason: 'toolUse' });
}

const databases: DatabaseSync[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
	for (const database of databases.splice(0)) database.close();
	resetModelsForTests();
});

// Exercise the real submission, rendering, and model-loop paths against the
// same SQLite stores used by the Durable Object host. Only the model is scripted.
async function createFixture() {
	const database = new DatabaseSync(':memory:');
	databases.push(database);
	const sql: SqlStorage = {
		exec(query, ...bindings) {
			const statement = database.prepare(query);
			const expectsRows =
				/^(SELECT|WITH|PRAGMA)/i.test(query.trimStart()) || /\bRETURNING\b/i.test(query);
			let rows: Record<string, unknown>[] = [];
			if (expectsRows) rows = statement.all(...(bindings as SQLInputValue[]));
			else statement.run(...(bindings as SQLInputValue[]));
			return { toArray: () => rows };
		},
	};
	const transaction = <T>(run: () => T): T => {
		database.exec('BEGIN');
		try {
			const result = run();
			database.exec('COMMIT');
			return result;
		} catch (error) {
			database.exec('ROLLBACK');
			throw error;
		}
	};
	ensureSqlAgentExecutionTables(sql, { toolApprovals: true });
	const submissions = createSqlAgentExecutionStoreFromSql(sql, transaction, {
		toolApprovals: true,
	});
	const writer = await ConversationRecordWriter.create({
		store: new SqliteConversationStreamStore(sql, transaction),
		path: agentStreamPath('TestAgent', 'instance-1'),
		identity: { agentName: 'TestAgent', instanceId: 'instance-1' },
		producerId: 'test',
	});
	const model = fauxProvider();
	setProvider(model.provider);
	let attemptNumber = 0;

	async function attempt(agent: Agent) {
		if (attemptNumber === 0) {
			await ensureInstanceIdentity(writer, agent, undefined);
			await submissions.admitDirect({
				kind: 'direct',
				submissionId: 'submission-1',
				agent: 'TestAgent',
				id: 'instance-1',
				message: { kind: 'user', body: 'Do the action.' },
				acceptedAt: new Date().toISOString(),
			});
			await submissions.markSubmissionCanonicalReady('submission-1');
		}
		const submission = await submissions.claimSubmission({
			submissionId: 'submission-1',
			attemptId: `attempt-${++attemptNumber}`,
			ownerId: 'test',
			leaseExpiresAt: Date.now() + 30_000,
		});
		expect(submission).not.toBeNull();
		if (!submission) throw new Error('Expected a claimable submission.');
		await processSubmission({
			submissions,
			submission,
			resolveAgent: () => agent,
			conversationWriter: writer,
			createContext: (submissionId) => {
				const context = createFlueContext({
					id: 'instance-1',
					agentName: 'TestAgent',
					submissionId,
					env: {},
					agentConfig: { resolveModel },
					conversationWriter: writer,
					attachmentStore: new InMemoryAttachmentStore(),
					submissionStore: submissions,
				});
				const initialize = context.initializeRootHarness.bind(context);
				context.initializeRootHarness = async (...args) => {
					const harness = await initialize(...args);
					harnesses.push(harness);
					return harness;
				};
				return context;
			},
		});
		const current = await submissions.getSubmission('submission-1');
		expect(current?.error).toBeUndefined();
		return current;
	}

	async function decide(status: 'approved' | 'rejected') {
		if (!submissions.listToolApprovals || !submissions.decideToolApproval) {
			throw new Error('Expected an approval-capable store.');
		}
		const approvals = await submissions.listToolApprovals('submission-1');
		expect(approvals).toHaveLength(1);
		const [approval] = approvals;
		if (!approval) throw new Error('Expected an approval proposal.');
		await submissions.decideToolApproval({ proposalId: approval.proposalId, status });
	}

	async function join() {
		await submissions.admitDispatch({
			submissionId: 'joined-1',
			agent: 'TestAgent',
			id: 'instance-1',
			message: { kind: 'signal', type: 'follow_up', body: 'Call approve.' },
			acceptedAt: new Date().toISOString(),
		});
		await submissions.markSubmissionCanonicalReady('joined-1');
	}

	return { model, submissions, writer, attempt, decide, join };
}

describe('tool approval lifecycle', () => {
	it('refreshes instructions, tool availability, and closures after a recovered state write', async () => {
		const fixture = await createFixture();
		const readPhase = vi.fn();
		function TestAgent() {
			useModel('faux/faux-1', { compaction: false });
			const [phase, setPhase] = usePersistentState('phase', 'pending');
			useTool({
				name: 'approve',
				description: 'Advance the phase.',
				version: '1',
				approval: { required: true },
				run: () => {
					setPhase('done');
					return { output: 'done' };
				},
			});
			useTool({
				name: 'read_phase',
				description: 'Read the current phase.',
				run: () => {
					readPhase(phase);
					return { output: phase };
				},
			});
			if (phase === 'done') {
				useTool({
					name: 'unlocked',
					description: 'A newly available tool.',
					run: () => ({ output: 'ok' }),
				});
			}
			return `phase=${phase}`;
		}
		fixture.model.setResponses([toolRequest(fauxToolCall('approve', {}, { id: 'approval-call' }))]);
		expect(await fixture.attempt(TestAgent)).toMatchObject({ status: 'waiting_for_approval' });
		await fixture.decide('approved');
		let nextRequest: Context | undefined;
		fixture.model.setResponses([
			(context) => {
				nextRequest = { ...context, messages: [...context.messages] };
				return toolRequest(fauxToolCall('read_phase', {}, { id: 'read-call' }));
			},
			fauxAssistantMessage('Finished.'),
		]);
		expect(await fixture.attempt(TestAgent)).toMatchObject({ status: 'settled' });
		expect((await fixture.writer.loadReducedState()).state.get('phase')).toBe('done');
		expect(nextRequest?.systemPrompt).toContain('phase=done');
		expect(nextRequest?.tools?.map((tool) => tool.name)).toContain('unlocked');
		expect(readPhase).toHaveBeenCalledExactlyOnceWith('done');
	});

	it.each([
		{ origin: 'initial', continueAfterTool: false },
		{ origin: 'finish', continueAfterTool: false },
		{ origin: 'join', continueAfterTool: false },
		{ origin: 'finish', continueAfterTool: true },
	])(
		'honors termination after $origin recovery and fresh finish hooks (continue: $continueAfterTool)',
		async ({ origin, continueAfterTool }) => {
			const fixture = await createFixture();
			const finishPhase = vi.fn();
			let continued = false;
			function TestAgent() {
				useModel('faux/faux-1', { compaction: false });
				const [phase, setPhase] = usePersistentState('phase', 'pending');
				useTool({
					name: 'approve',
					description: 'Complete the action.',
					version: '1',
					approval: { required: true },
					run: () => {
						setPhase('done');
						return { output: 'done', terminate: true };
					},
				});
				if (phase === 'done') {
					useTool({ name: 'unlocked', description: 'A new tool.', run: () => ({ output: 'ok' }) });
				}
				useAgentFinish(async ({ response, append }) => {
					if (!response.toolCalls.some((call) => call.tool === 'approve')) {
						if (origin === 'join') await fixture.join();
						else append({ kind: 'signal', type: 'continue', body: 'Call approve.' });
					} else if (continueAfterTool && !continued) {
						continued = true;
						append({ kind: 'signal', type: 'follow_up', body: `Explain the ${phase} result.` });
					}
				});
				useResponseFinish(() => {
					finishPhase(phase);
					return { phase };
				});
				return `phase=${phase}`;
			}
			fixture.model.setResponses([
				...(origin === 'initial' ? [] : [fauxAssistantMessage('First answer.')]),
				toolRequest(fauxToolCall('approve', {}, { id: 'approval-call' })),
			]);
			expect(await fixture.attempt(TestAgent)).toMatchObject({ status: 'waiting_for_approval' });
			await fixture.decide('approved');
			const nextRequest = vi.fn(() => fauxAssistantMessage('Finished.'));
			fixture.model.setResponses([nextRequest]);
			expect(await fixture.attempt(TestAgent)).toMatchObject({ status: 'settled' });
			expect(nextRequest).toHaveBeenCalledTimes(continueAfterTool ? 1 : 0);
			expect(finishPhase).toHaveBeenCalledExactlyOnceWith('done');
		},
	);

	describe.each(['finish', 'join'] as const)('%s continuation', (continuation) => {
		it.each(['approved', 'rejected'] as const)(
			'handles a fast %s decision before settling',
			async (decision) => {
				const fixture = await createFixture();
				const run = vi.fn(() => ({ output: 'done' }));
				function TestAgent() {
					useModel('faux/faux-1', { compaction: false });
					useTool({
						name: 'approve',
						description: 'An action.',
						version: '1',
						approval: { required: true },
						run,
					});
					useTool({
						name: 'slow_read',
						description: 'A decision arrives while an unguarded tool in the same batch is running.',
						run: async () => {
							await fixture.decide(decision);
							return { output: 'read finished' };
						},
					});
					useAgentFinish(async ({ response, append }) => {
						if (!response.toolCalls.some((call) => call.tool === 'approve')) {
							if (continuation === 'join') await fixture.join();
							else append({ kind: 'signal', type: 'continue', body: 'Call approve.' });
						}
					});
					return 'Perform the action.';
				}
				fixture.model.setResponses([
					fauxAssistantMessage('First answer.'),
					toolRequest(
						fauxToolCall('approve', {}, { id: 'approval-call' }),
						fauxToolCall('slow_read', {}, { id: 'read-call' }),
					),
					fauxAssistantMessage('Finished.'),
				]);
				expect(await fixture.attempt(TestAgent)).toMatchObject({ status: 'settled' });
				expect(run).toHaveBeenCalledTimes(decision === 'approved' ? 1 : 0);
				expect(fixture.model.getPendingResponseCount()).toBe(0);
				const reduced = await fixture.writer.loadReducedState();
				const messages = [...reduced.conversations.values()].flatMap((conversation) =>
					[...conversation.entries.values()].flatMap((entry) =>
						entry.type === 'message' ? [entry.message] : [],
					),
				);
				expect(messages).toContainEqual(
					expect.objectContaining({
						toolCallId: 'approval-call',
						isError: decision === 'rejected',
					}),
				);
			},
		);

		it('defers response-finish callbacks and metadata until a parked continuation resumes', async () => {
			const fixture = await createFixture();
			const finish = vi.fn(() => ({ finished: true }));
			const run = vi.fn(() => ({ output: 'done' }));
			function TestAgent() {
				useModel('faux/faux-1', { compaction: false });
				useTool({
					name: 'approve',
					description: 'An action.',
					version: '1',
					approval: { required: true },
					run,
				});
				useAgentFinish(async ({ response, append }) => {
					if (!response.toolCalls.some((call) => call.tool === 'approve')) {
						if (continuation === 'join') await fixture.join();
						else append({ kind: 'signal', type: 'continue', body: 'Call approve.' });
					}
				});
				useResponseFinish(finish);
				return 'Perform the action.';
			}
			fixture.model.setResponses([
				fauxAssistantMessage('First answer.'),
				toolRequest(fauxToolCall('approve', {}, { id: 'approval-call' })),
			]);
			expect(await fixture.attempt(TestAgent)).toMatchObject({ status: 'waiting_for_approval' });
			expect(finish).not.toHaveBeenCalled();
			expect(run).not.toHaveBeenCalled();
			await fixture.decide('approved');
			fixture.model.setResponses([fauxAssistantMessage('Finished.')]);
			expect(await fixture.attempt(TestAgent)).toMatchObject({ status: 'settled' });
			expect(finish).toHaveBeenCalledTimes(1);
			expect(run).toHaveBeenCalledTimes(1);
			const reduced = await fixture.writer.loadReducedState();
			const metadata = [...reduced.conversations.values()].flatMap((conversation) => [
				...conversation.responseMetadata.values(),
			]);
			expect(metadata).toEqual([{ finished: true }]);
			if (continuation === 'join') {
				expect(await fixture.submissions.getSubmission('joined-1')).toMatchObject({
					status: 'settled',
					joinedInto: 'submission-1',
				});
			}
		});
	});
});
