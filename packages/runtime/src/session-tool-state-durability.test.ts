import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlueContext } from './client.ts';
import { ConversationRecordWriter } from './conversation-writer.ts';
import type { Harness } from './harness.ts';
import { useModel } from './hooks/use-model.ts';
import { usePersistentState } from './hooks/use-persistent-state.ts';
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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	resetModelsForTests();
});

function toolRequest(...names: string[]) {
	return fauxAssistantMessage(
		names.map((name) => fauxToolCall(name, {}, { id: name })),
		{
			stopReason: 'toolUse',
		},
	);
}

// Real rendering, Pi execution, submission recovery, and SQLite transactions.
// Only the provider and crash boundary are controlled by the test. Reopening
// the file drops every writer, fold cache, harness, and hook-state buffer.
async function createFixture() {
	const directory = mkdtempSync(join(tmpdir(), 'flue-tool-state-'));
	const path = agentStreamPath('TestAgent', 'instance-1');
	const crash = new Error('injected process loss');
	const model = fauxProvider();
	setProvider(model.provider);
	let fault: 'before' | 'after' | undefined;
	const harnesses: Harness[] = [];
	let attemptNumber = 0;
	let admitted = false;
	async function open() {
		const database = new DatabaseSync(join(directory, 'store.sqlite'));
		const sql: SqlStorage = {
			exec(query, ...bindings) {
				const statement = database.prepare(query);
				let rows: Record<string, unknown>[] = [];
				if (/^(SELECT|WITH|PRAGMA)/i.test(query.trimStart()) || /\bRETURNING\b/i.test(query)) {
					rows = statement.all(...(bindings as SQLInputValue[]));
				} else {
					statement.run(...(bindings as SQLInputValue[]));
				}
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
		const store = new SqliteConversationStreamStore(sql, transaction);
		const append = store.append.bind(store);
		store.append = async (input) => {
			const hit = input.records.some((record) => record.type === 'tool_outcome')
				? fault
				: undefined;
			if (hit === 'before') throw crash;
			const result = await append(input);
			if (hit === 'after') throw crash;
			return result;
		};
		const writer = await ConversationRecordWriter.create({
			store,
			path,
			identity: { agentName: 'TestAgent', instanceId: 'instance-1' },
			producerId: `test-${attemptNumber}`,
		});
		return { database, submissions, store, writer };
	}
	let connection = await open();
	async function close() {
		await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
		connection.database.close();
	}
	cleanups.push(async () => {
		await close();
		rmSync(directory, { recursive: true, force: true });
	});
	return {
		model,
		crash,
		get writer() {
			return connection.writer;
		},
		inject(when: 'before' | 'after') {
			fault = when;
		},
		async reopen() {
			await close();
			fault = undefined;
			connection = await open();
		},
		async records() {
			return (await connection.store.read(path)).batches.flatMap((batch) => batch.records);
		},
		async decide() {
			const { submissions } = connection;
			const approvals = await submissions.listToolApprovals?.('submission-1');
			expect(approvals).toHaveLength(1);
			const approval = approvals?.[0];
			if (!approval || !submissions.decideToolApproval)
				throw new Error('Expected native approval storage.');
			await submissions.decideToolApproval({ proposalId: approval.proposalId, status: 'approved' });
		},
		async attempt(agent: Agent) {
			const { submissions, writer } = connection;
			if (!admitted) {
				await ensureInstanceIdentity(writer, agent, undefined);
				await submissions.admitDirect({
					kind: 'direct',
					submissionId: 'submission-1',
					agent: 'TestAgent',
					id: 'instance-1',
					message: { kind: 'user', body: 'Request the missing information.' },
					acceptedAt: new Date().toISOString(),
				});
				await submissions.markSubmissionCanonicalReady('submission-1');
				admitted = true;
			}
			const previous = await submissions.getSubmission('submission-1');
			const attemptId = `attempt-${++attemptNumber}`;
			const submission =
				previous?.status === 'running' && previous.attemptId
					? await submissions.replaceSubmissionAttempt(
							{ submissionId: 'submission-1', attemptId: previous.attemptId },
							attemptId,
						)
					: await submissions.claimSubmission({
							submissionId: 'submission-1',
							attemptId,
							ownerId: 'test',
							leaseExpiresAt: Date.now() + 30_000,
						});
			if (!submission) throw new Error('Expected a claimable submission.');
			await processSubmission({
				submissions,
				submission,
				resolveAgent: () => agent,
				conversationWriter: writer,
				// A crashed host cannot terminalize a submission; leave it running
				// for the same replacement-attempt recovery used by a new host.
				isShutdownAbort: (error) => error === crash,
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
		},
	};
}

describe('tool outcome and persistent-state durability', () => {
	it('retains the request limit after a crash immediately after the outcome append', async () => {
		const fixture = await createFixture();
		const requested = vi.fn();
		function TestAgent() {
			useModel('faux/faux-1', { compaction: false });
			const [count, setCount] = usePersistentState('requests', 0);
			useTool({
				name: 'request_missing_info',
				description: 'Request once.',
				run: () => {
					if (count >= 1) return { output: 'limit_reached' };
					requested();
					setCount((previous) => previous + 1);
					return { output: 'requested' };
				},
			});
			return `Requests: ${count}`;
		}
		fixture.model.setResponses([toolRequest('request_missing_info')]);
		fixture.inject('after');
		await expect(fixture.attempt(TestAgent)).rejects.toBe(fixture.crash);
		await fixture.reopen();
		fixture.model.setResponses([
			toolRequest('request_missing_info'),
			fauxAssistantMessage('Done.'),
		]);
		expect(await fixture.attempt(TestAgent)).toMatchObject({ status: 'settled' });
		expect(requested).toHaveBeenCalledTimes(1);
		expect((await fixture.writer.loadReducedState()).state.get('requests')).toBe(1);
		expect(
			(await fixture.records())
				.filter((record) => record.type === 'tool_outcome')
				.map((record) => record.output),
		).toEqual(['requested', 'limit_reached']);
	});

	it('repairs an uncommitted ordinary batch as interrupted without replaying its tool or state', async () => {
		const fixture = await createFixture();
		const run = vi.fn();
		function TestAgent() {
			useModel('faux/faux-1', { compaction: false });
			const [, setCount] = usePersistentState('requests', 0);
			useTool({
				name: 'request',
				description: 'Request information.',
				run: () => {
					run();
					setCount(1);
					return { output: 'requested' };
				},
			});
			return 'Request information.';
		}
		fixture.model.setResponses([toolRequest('request')]);
		fixture.inject('before');
		await expect(fixture.attempt(TestAgent)).rejects.toBe(fixture.crash);
		await fixture.reopen();
		expect(
			(await fixture.records()).some(
				(record) => record.type === 'tool_outcome' || record.type === 'state_write',
			),
		).toBe(false);
		fixture.model.setResponses([fauxAssistantMessage('Interrupted.')]);
		expect(await fixture.attempt(TestAgent)).toMatchObject({ status: 'settled' });
		expect(run).toHaveBeenCalledTimes(1);
		expect((await fixture.writer.loadReducedState()).state.has('requests')).toBe(false);
		const outcomes = (await fixture.records()).filter((record) => record.type === 'tool_outcome');
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			isError: true,
			content: [{ type: 'text', text: expect.stringContaining('interrupted') }],
		});
	});

	it('replays durable steps and reconstructs state when the outcome batch never committed', async () => {
		const fixture = await createFixture();
		const sideEffect = vi.fn(() => 'requested');
		const run = vi.fn();
		function TestAgent() {
			useModel('faux/faux-1', { compaction: false });
			const [, setCount] = usePersistentState('requests', 0);
			useTool({
				name: 'request',
				description: 'Request information durably.',
				durable: true,
				run: async ({ step }) => {
					run();
					const output = await step.do('request', sideEffect);
					setCount((previous) => previous + 1);
					return { output };
				},
			});
			return 'Request information.';
		}
		fixture.model.setResponses([toolRequest('request')]);
		fixture.inject('before');
		await expect(fixture.attempt(TestAgent)).rejects.toBe(fixture.crash);
		await fixture.reopen();
		fixture.model.setResponses([fauxAssistantMessage('Done.')]);
		expect(await fixture.attempt(TestAgent)).toMatchObject({ status: 'settled' });
		expect(run).toHaveBeenCalledTimes(2);
		expect(sideEffect).toHaveBeenCalledTimes(1);
		expect((await fixture.writer.loadReducedState()).state.get('requests')).toBe(1);
		expect(
			(await fixture.records()).filter((record) => record.type === 'tool_outcome'),
		).toMatchObject([{ isError: false, output: 'requested' }]);
	});

	it('commits parallel success and error writes in setter order while discarding a timed-out sibling', async () => {
		const fixture = await createFixture();
		const abandoned = Promise.withResolvers<void>();
		const firstWrote = Promise.withResolvers<void>();
		const secondWrote = Promise.withResolvers<void>();
		const timeoutWrote = Promise.withResolvers<void>();
		const orphanFinished = Promise.withResolvers<void>();
		function TestAgent() {
			useModel('faux/faux-1', { compaction: false });
			const [, setCount] = usePersistentState('count', 0);
			useTool({
				name: 'first',
				description: 'Write first, finish last.',
				run: async () => {
					setCount((previous) => previous + 1);
					firstWrote.resolve();
					await secondWrote.promise;
					return { output: 'done' };
				},
			});
			useTool({
				name: 'second',
				description: 'Write then fail.',
				run: async () => {
					await firstWrote.promise;
					await timeoutWrote.promise;
					setCount((previous) => previous + 1);
					secondWrote.resolve();
					throw new Error('ordinary failure');
				},
			});
			useTool({
				name: 'timeout',
				description: 'Abandon this write.',
				timeoutMs: 25,
				run: async () => {
					await firstWrote.promise;
					setCount((previous) => previous + 100);
					timeoutWrote.resolve();
					await abandoned.promise;
					setCount(999);
					orphanFinished.resolve();
					return { output: 'late' };
				},
			});
			return 'Run all three tools.';
		}
		fixture.model.setResponses([toolRequest('first', 'second', 'timeout')]);
		fixture.inject('after');
		try {
			await expect(fixture.attempt(TestAgent)).rejects.toBe(fixture.crash);
		} finally {
			abandoned.resolve();
		}
		await orphanFinished.promise;
		await fixture.reopen();
		expect((await fixture.writer.loadReducedState()).state.get('count')).toBe(2);
		const records = await fixture.records();
		expect(
			records.filter((record) => record.type === 'state_write').map((record) => record.value),
		).toEqual([1, 2]);
		const outcomes = records.filter((record) => record.type === 'tool_outcome');
		expect(outcomes).toHaveLength(3);
		expect(outcomes.find((record) => record.toolName === 'first')).toMatchObject({
			isError: false,
			output: 'done',
		});
		expect(outcomes.find((record) => record.toolName === 'second')).toMatchObject({
			isError: true,
		});
		expect(outcomes.find((record) => record.toolName === 'timeout')).toMatchObject({
			isError: true,
		});
		fixture.model.setResponses([fauxAssistantMessage('Done.')]);
		expect(await fixture.attempt(TestAgent)).toMatchObject({ status: 'settled' });
		expect(
			(await fixture.records()).filter((record) => record.type === 'tool_outcome'),
		).toHaveLength(3);
	});

	it.each(['before', 'after'] as const)(
		'keeps parked mixed work and recovers a crash %s the approved outcome append',
		async (when) => {
			const fixture = await createFixture();
			const ordinary = vi.fn();
			const approved = vi.fn();
			function TestAgent() {
				useModel('faux/faux-1', { compaction: false });
				const [, setCount] = usePersistentState('count', 0);
				useTool({
					name: 'ordinary',
					description: 'Complete while approval waits.',
					run: () => {
						ordinary();
						setCount((previous) => previous + 1);
						return { output: 'ordinary' };
					},
				});
				useTool({
					name: 'approved',
					description: 'Wait for native approval.',
					version: '1',
					approval: { required: true },
					run: () => {
						approved();
						setCount((previous) => previous + 10);
						return { output: 'approved' };
					},
				});
				return 'Run both tools.';
			}
			fixture.model.setResponses([toolRequest('ordinary', 'approved')]);
			// Crash after ordinary work commits, before its submission can park.
			fixture.inject('after');
			await expect(fixture.attempt(TestAgent)).rejects.toBe(fixture.crash);
			await fixture.reopen();
			expect((await fixture.writer.loadReducedState()).state.get('count')).toBe(1);
			expect(await fixture.attempt(TestAgent)).toMatchObject({ status: 'waiting_for_approval' });
			expect(ordinary).toHaveBeenCalledTimes(1);
			expect(approved).not.toHaveBeenCalled();
			expect(
				(await fixture.records()).some((record) => record.type === 'tool_results_committed'),
			).toBe(false);
			await fixture.reopen();
			await fixture.decide();
			fixture.inject(when);
			await expect(fixture.attempt(TestAgent)).rejects.toBe(fixture.crash);
			await fixture.reopen();
			expect((await fixture.writer.loadReducedState()).state.get('count')).toBe(
				when === 'after' ? 11 : 1,
			);
			fixture.model.setResponses([fauxAssistantMessage('Done.')]);
			expect(await fixture.attempt(TestAgent)).toMatchObject({ status: 'settled' });
			expect(ordinary).toHaveBeenCalledTimes(1);
			expect(approved).toHaveBeenCalledTimes(1);
			const outcomes = (await fixture.records()).filter((record) => record.type === 'tool_outcome');
			expect(outcomes).toHaveLength(2);
			expect(outcomes.find((record) => record.toolName === 'ordinary')).toMatchObject({
				isError: false,
				output: 'ordinary',
			});
			expect(outcomes.find((record) => record.toolName === 'approved')).toMatchObject({
				isError: when === 'before',
			});
		},
	);
});
