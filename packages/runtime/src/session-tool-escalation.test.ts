import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { ToolCall } from '@earendil-works/pi-ai';
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import type { CallToolResult, Tool, Transport } from '@modelcontextprotocol/client';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSubmissionStore, ToolApprovalDecisionInput } from './agent-execution-store.ts';
import { createFlueContext } from './client.ts';
import type { ConversationRecord } from './conversation-records.ts';
import { ConversationRecordWriter } from './conversation-writer.ts';
import type { Harness } from './harness.ts';
import { useMcpConnection } from './hooks/use-mcp-connection.ts';
import { useModel } from './hooks/use-model.ts';
import { useTool } from './hooks/use-tool.ts';
import { useToolEscalation } from './hooks/use-tool-escalation.ts';
import { createMcpConnectionWithClient, type McpConnectionResolver } from './mcp.ts';
import { ensureInstanceIdentity, processSubmission } from './runtime/agent-submissions.ts';
import { InMemoryAttachmentStore } from './runtime/attachment-store.ts';
import { SqliteConversationStreamStore } from './runtime/conversation-stream-store.ts';
import { resetModelsForTests, resolveModel, setProvider } from './runtime/providers.ts';
import { agentStreamPath } from './runtime/stream-offsets.ts';
import {
	resetToolApprovalProvider,
	setToolApprovalProvider,
} from './runtime/tool-approval-provider.ts';
import {
	createSqlAgentExecutionStoreFromSql,
	ensureSqlAgentExecutionTables,
} from './sql-agent-execution-store.ts';
import type { SqlStorage } from './sql-storage.ts';
import type {
	ToolApproval,
	ToolEscalationMode,
	ToolEscalationOptions,
	ToolEscalationState,
} from './tool-approval.ts';
import type { Agent } from './types.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	resetModelsForTests();
	resetToolApprovalProvider();
	vi.useRealTimers();
});

function toolRequest(...calls: ToolCall[]) {
	return fauxAssistantMessage(calls, { stopReason: 'toolUse' });
}

function call(name: string, id: string) {
	return fauxToolCall(name, {}, { id });
}

// Real rendering, Pi execution, submission recovery, and SQLite transactions,
// as the Durable Object host runs them. The model, the host decisions, and an
// optional crash before the tool-outcome append are scripted. Reopening the
// file drops every writer, fold cache, and harness.
async function createFixture(options: { mcpConnections?: McpConnectionResolver } = {}) {
	const directory = mkdtempSync(join(tmpdir(), 'flue-tool-escalation-'));
	const path = agentStreamPath('TestAgent', 'instance-1');
	const crash = new Error('injected process loss');
	const model = fauxProvider();
	setProvider(model.provider);
	let fault: 'before' | undefined;
	// Process loss between persisting a grouped proposal and deciding it: the
	// next escalation decision fails, and the batch's outcome append crashes.
	let loseEscalationDecision = false;
	// Runs after an automatic approval commits, before the tool executes.
	let afterAutoApproval: ((submissions: AgentSubmissionStore) => Promise<void>) | undefined;
	const harnesses: Harness[] = [];
	const admitted = new Set<string>();
	let attemptNumber = 0;
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
		const decide = submissions.decideToolApproval?.bind(submissions);
		if (decide) {
			submissions.decideToolApproval = async (input) => {
				if (loseEscalationDecision && (input.via === 'escalation' || input.via === 'mode')) {
					loseEscalationDecision = false;
					fault = 'before';
					throw new Error('injected decision loss');
				}
				const result = await decide(input);
				if (
					afterAutoApproval &&
					result.decisionApplied &&
					result.approval.status === 'approved' &&
					input.via !== 'host'
				) {
					const hook = afterAutoApproval;
					afterAutoApproval = undefined;
					await hook(submissions);
				}
				return result;
			};
		}
		const store = new SqliteConversationStreamStore(sql, transaction);
		const append = store.append.bind(store);
		store.append = async (input) => {
			if (fault === 'before' && input.records.some((record) => record.type === 'tool_outcome')) {
				throw crash;
			}
			return append(input);
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
		get submissions() {
			return connection.submissions;
		},
		inject() {
			fault = 'before';
		},
		loseNextEscalationDecision() {
			loseEscalationDecision = true;
		},
		afterNextAutoApproval(hook: (submissions: AgentSubmissionStore) => Promise<void>) {
			afterAutoApproval = hook;
		},
		async reopen() {
			await close();
			fault = undefined;
			connection = await open();
		},
		async records(): Promise<ConversationRecord[]> {
			return (await connection.store.read(path)).batches.flatMap((batch) => batch.records);
		},
		async approvals(submissionId = 'submission-1'): Promise<ToolApproval[]> {
			return (await connection.submissions.listToolApprovals?.(submissionId)) ?? [];
		},
		/** A host decision, as the coordinator records one. */
		async decide(proposalId: string, decision: Omit<ToolApprovalDecisionInput, 'proposalId'>) {
			const decide = connection.submissions.decideToolApproval;
			if (!decide) throw new Error('Expected native approval storage.');
			return decide.call(connection.submissions, { proposalId, via: 'host', ...decision });
		},
		async attempt(agent: Agent, submissionId = 'submission-1') {
			const { submissions, writer } = connection;
			if (!admitted.has(submissionId)) {
				if (admitted.size === 0) await ensureInstanceIdentity(writer, agent, undefined);
				await submissions.admitDirect({
					kind: 'direct',
					submissionId,
					agent: 'TestAgent',
					id: 'instance-1',
					message: { kind: 'user', body: 'Edit the page.' },
					acceptedAt: new Date().toISOString(),
				});
				await submissions.markSubmissionCanonicalReady(submissionId);
				admitted.add(submissionId);
			}
			const previous = await submissions.getSubmission(submissionId);
			const attemptId = `attempt-${++attemptNumber}`;
			const submission =
				previous?.status === 'running' && previous.attemptId
					? await submissions.replaceSubmissionAttempt(
							{ submissionId, attemptId: previous.attemptId },
							attemptId,
						)
					: await submissions.claimSubmission({
							submissionId,
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
				createContext: (contextSubmissionId) => {
					const context = createFlueContext({
						id: 'instance-1',
						agentName: 'TestAgent',
						submissionId: contextSubmissionId,
						env: {},
						agentConfig: { resolveModel },
						conversationWriter: writer,
						attachmentStore: new InMemoryAttachmentStore(),
						submissionStore: submissions,
						...(options.mcpConnections ? { mcpConnections: options.mcpConnections } : {}),
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
			const current = await submissions.getSubmission(submissionId);
			expect(current?.error).toBeUndefined();
			return current;
		},
	};
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

// Two Notion-style write tools in one escalation group, plus an ungrouped
// approval-gated tool to show grouping does not leak.
function notionAgent(
	options: {
		mode?: ToolEscalationMode;
		expiresInMs?: number;
		declare?: boolean;
		approvalExpiresInMs?: number;
	} = {},
) {
	const edit = vi.fn(async () => ({ output: 'edited' }));
	const publish = vi.fn(async () => ({ output: 'published' }));
	const remove = vi.fn(async () => ({ output: 'removed' }));
	const states: ToolEscalationState[] = [];
	function TestAgent() {
		useModel('faux/faux-1', { compaction: false });
		const escalationOptions: ToolEscalationOptions = {
			...(options.mode ? { mode: options.mode } : {}),
			...(options.expiresInMs !== undefined ? { expiresInMs: options.expiresInMs } : {}),
			presentation: { title: 'Allow Notion edits for this session' },
		};
		if (options.declare !== false) {
			states.push(useToolEscalation('notion-edit', escalationOptions));
		}
		for (const [name, run] of [
			['edit_page', edit],
			['publish_page', publish],
		] as const) {
			useTool({
				name,
				description: `Notion ${name}.`,
				version: '1',
				approval: {
					required: true,
					escalation: 'notion-edit',
					...(options.approvalExpiresInMs !== undefined
						? { expiresInMs: options.approvalExpiresInMs }
						: {}),
				},
				run,
			});
		}
		useTool({
			name: 'delete_page',
			description: 'Delete a Notion page.',
			version: '1',
			approval: { required: true },
			run: remove,
		});
		return 'Edit Notion pages.';
	}
	return { agent: TestAgent as Agent, edit, publish, remove, states };
}

function installProvider() {
	const requested = vi.fn();
	const decided = vi.fn();
	setToolApprovalProvider({ requested, decided });
	return { requested, decided };
}

async function outcomeFor(fixture: Fixture, toolCallId: string) {
	return (await fixture.records()).find(
		(record): record is Extract<ConversationRecord, { type: 'tool_outcome' }> =>
			record.type === 'tool_outcome' && record.toolCallId === toolCallId,
	);
}

/** Park submission-1 on one grouped call and approve it as the host. */
async function escalateOnce(fixture: Fixture, agent: Agent, decision: { escalate?: boolean } = {}) {
	fixture.model.setResponses([toolRequest(call('edit_page', 'edit-1'))]);
	expect(await fixture.attempt(agent)).toMatchObject({ status: 'waiting_for_approval' });
	const [pending] = await fixture.approvals();
	if (!pending) throw new Error('Expected a pending approval.');
	const result = await fixture.decide(pending.proposalId, {
		status: 'approved',
		actor: 'U123',
		...decision,
	});
	fixture.model.setResponses([fauxAssistantMessage('Edited.')]);
	expect(await fixture.attempt(agent)).toMatchObject({ status: 'settled' });
	return { pending, result };
}

describe('tool escalation lifecycle', () => {
	it('asks once, then approves later calls in the group without parking or asking', async () => {
		const fixture = await createFixture();
		const provider = installProvider();
		const { agent, edit, publish, states } = notionAgent();

		const { pending, result } = await escalateOnce(fixture, agent);
		expect(pending.escalation).toEqual({
			group: 'notion-edit',
			mode: 'ask',
			presentation: { title: 'Allow Notion edits for this session' },
		});
		expect(provider.requested).toHaveBeenCalledTimes(1);
		expect(provider.requested.mock.calls[0]?.[0]).toMatchObject({
			proposalId: pending.proposalId,
			escalation: { group: 'notion-edit', mode: 'ask' },
		});
		expect(result.approval.decidedVia).toEqual({ kind: 'host', actor: 'U123' });
		expect(result.grant).toMatchObject({
			group: 'notion-edit',
			instanceId: 'instance-1',
			proposalId: pending.proposalId,
			actor: 'U123',
		});
		expect(result.grant?.expiresAt).toBeUndefined();
		expect(edit).toHaveBeenCalledTimes(1);

		fixture.model.setResponses([
			toolRequest(call('edit_page', 'edit-2'), call('publish_page', 'publish-2')),
			fauxAssistantMessage('Done.'),
		]);
		expect(await fixture.attempt(agent, 'submission-2')).toMatchObject({ status: 'settled' });

		expect(edit).toHaveBeenCalledTimes(2);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(provider.requested).toHaveBeenCalledTimes(1);
		const auto = await fixture.approvals('submission-2');
		expect(auto).toHaveLength(2);
		for (const approval of auto) {
			expect(approval).toMatchObject({
				status: 'approved',
				decidedVia: { kind: 'escalation', grantProposalId: pending.proposalId, actor: 'U123' },
			});
		}
		await vi.waitFor(() => expect(provider.decided).toHaveBeenCalledTimes(2));
		expect(states.at(-1)?.grant).toMatchObject({ proposalId: pending.proposalId });

		const records = await fixture.records();
		for (const approval of auto) {
			expect(records).toContainEqual(
				expect.objectContaining({
					type: 'tool_approval_decided',
					proposalId: approval.proposalId,
					decidedVia: approval.decidedVia,
				}),
			);
			expect(records).toContainEqual(
				expect.objectContaining({
					type: 'tool_approval_execution_started',
					proposalId: approval.proposalId,
				}),
			);
		}
		expect(await outcomeFor(fixture, 'publish-2')).toMatchObject({
			isError: false,
			output: 'published',
		});
	});

	it('keeps an ungrouped approval-gated tool asking after its neighbors escalate', async () => {
		const fixture = await createFixture();
		const { agent, remove } = notionAgent();
		await escalateOnce(fixture, agent);

		fixture.model.setResponses([toolRequest(call('delete_page', 'delete-2'))]);
		expect(await fixture.attempt(agent, 'submission-2')).toMatchObject({
			status: 'waiting_for_approval',
		});
		expect(remove).not.toHaveBeenCalled();
	});

	it('approves only the one call when the host opts out of escalation', async () => {
		const fixture = await createFixture();
		const { agent, edit } = notionAgent();
		const { result } = await escalateOnce(fixture, agent, { escalate: false });
		expect(result.grant).toBeUndefined();
		expect(edit).toHaveBeenCalledTimes(1);
		expect(await fixture.submissions.listToolEscalationGrants?.()).toEqual([]);

		fixture.model.setResponses([toolRequest(call('edit_page', 'edit-2'))]);
		expect(await fixture.attempt(agent, 'submission-2')).toMatchObject({
			status: 'waiting_for_approval',
		});
		expect(edit).toHaveBeenCalledTimes(1);
	});

	it('approves the rest of a parked batch in the transaction that creates the grant', async () => {
		const fixture = await createFixture();
		const { agent, edit, publish } = notionAgent();
		fixture.model.setResponses([
			toolRequest(
				call('edit_page', 'edit-a'),
				call('edit_page', 'edit-b'),
				call('publish_page', 'publish-c'),
			),
		]);
		expect(await fixture.attempt(agent)).toMatchObject({ status: 'waiting_for_approval' });
		const pending = await fixture.approvals();
		expect(pending.map((approval) => approval.status)).toEqual(['pending', 'pending', 'pending']);
		const first = pending.find((approval) => approval.toolCallId === 'edit-a');
		if (!first) throw new Error('Expected edit-a.');

		const result = await fixture.decide(first.proposalId, { status: 'approved' });
		expect(result.resumed).toBe(true);
		expect(result.escalated?.map(({ approval }) => approval.toolCallId).sort()).toEqual([
			'edit-b',
			'publish-c',
		]);
		expect(result.escalated?.every(({ resumed }) => !resumed)).toBe(true);
		expect(
			(await fixture.approvals()).map(({ status, decidedVia }) => [status, decidedVia?.kind]),
		).toEqual([
			['approved', 'host'],
			['approved', 'escalation'],
			['approved', 'escalation'],
		]);

		fixture.model.setResponses([fauxAssistantMessage('All three done.')]);
		expect(await fixture.attempt(agent)).toMatchObject({ status: 'settled' });
		expect(edit).toHaveBeenCalledTimes(2);
		expect(publish).toHaveBeenCalledTimes(1);
	});

	it.each(['rejected', 'expired', 'canceled', 'aborted'] as const)(
		'creates no grant when the host decision is %s',
		async (status) => {
			const fixture = await createFixture();
			const { agent, edit } = notionAgent();
			fixture.model.setResponses([toolRequest(call('edit_page', 'edit-1'))]);
			expect(await fixture.attempt(agent)).toMatchObject({ status: 'waiting_for_approval' });
			const [pending] = await fixture.approvals();
			if (!pending) throw new Error('Expected a pending approval.');
			const result = await fixture.decide(pending.proposalId, { status });
			expect(result.grant).toBeUndefined();
			expect(await fixture.submissions.listToolEscalationGrants?.()).toEqual([]);

			fixture.model.setResponses([fauxAssistantMessage('Not edited.')]);
			expect(await fixture.attempt(agent)).toMatchObject({ status: 'settled' });
			fixture.model.setResponses([toolRequest(call('edit_page', 'edit-2'))]);
			expect(await fixture.attempt(agent, 'submission-2')).toMatchObject({
				status: 'waiting_for_approval',
			});
			expect(edit).not.toHaveBeenCalled();
		},
	);

	it('covers calls requested before the grant expires and asks again after', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
		const fixture = await createFixture();
		const { agent, edit } = notionAgent({ expiresInMs: 60 * 60_000 });
		const { result } = await escalateOnce(fixture, agent);
		const grantedAt = result.grant?.grantedAt ?? 0;
		expect(result.grant?.expiresAt).toBe(grantedAt + 60 * 60_000);

		vi.setSystemTime(grantedAt + 59 * 60_000);
		fixture.model.setResponses([
			toolRequest(call('edit_page', 'edit-2')),
			fauxAssistantMessage('Done.'),
		]);
		expect(await fixture.attempt(agent, 'submission-2')).toMatchObject({ status: 'settled' });
		expect(edit).toHaveBeenCalledTimes(2);

		vi.setSystemTime(grantedAt + 61 * 60_000);
		expect(await fixture.submissions.listToolEscalationGrants?.()).toEqual([]);
		fixture.model.setResponses([toolRequest(call('edit_page', 'edit-3'))]);
		expect(await fixture.attempt(agent, 'submission-3')).toMatchObject({
			status: 'waiting_for_approval',
		});
		const [pending] = await fixture.approvals('submission-3');
		if (!pending) throw new Error('Expected a pending approval.');
		const renewed = await fixture.decide(pending.proposalId, { status: 'approved' });
		expect(renewed.grant).toMatchObject({ proposalId: pending.proposalId });
		expect(await fixture.submissions.listToolEscalationGrants?.()).toEqual([
			expect.objectContaining({ proposalId: pending.proposalId }),
		]);
	});

	it('asks again after revocation, and revocation is idempotent', async () => {
		const fixture = await createFixture();
		const { agent, edit, states } = notionAgent();
		const { pending } = await escalateOnce(fixture, agent);

		const revoked = await fixture.submissions.revokeToolEscalation?.({
			group: 'notion-edit',
			actor: 'U999',
			reason: 'done editing',
		});
		expect(revoked).toEqual([
			expect.objectContaining({
				proposalId: pending.proposalId,
				revokedBy: 'U999',
				revokeReason: 'done editing',
			}),
		]);
		expect(await fixture.submissions.revokeToolEscalation?.({ group: 'notion-edit' })).toEqual([]);

		fixture.model.setResponses([toolRequest(call('edit_page', 'edit-2'))]);
		expect(await fixture.attempt(agent, 'submission-2')).toMatchObject({
			status: 'waiting_for_approval',
		});
		expect(edit).toHaveBeenCalledTimes(1);
		expect(states.at(-1)?.grant).toBeNull();
	});

	it('runs every call without asking in granted mode', async () => {
		const fixture = await createFixture();
		const provider = installProvider();
		const { agent, edit } = notionAgent({ mode: 'granted' });
		fixture.model.setResponses([
			toolRequest(call('edit_page', 'edit-1')),
			fauxAssistantMessage('Done.'),
		]);
		expect(await fixture.attempt(agent)).toMatchObject({ status: 'settled' });

		expect(edit).toHaveBeenCalledTimes(1);
		expect(provider.requested).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(provider.decided).toHaveBeenCalledTimes(1));
		expect(await fixture.approvals()).toMatchObject([
			{ status: 'approved', decidedVia: { kind: 'mode', mode: 'granted' } },
		]);
		expect(await fixture.submissions.listToolEscalationGrants?.()).toEqual([]);
	});

	it('rejects every call without asking or running in denied mode', async () => {
		const fixture = await createFixture();
		const provider = installProvider();
		const { agent, edit } = notionAgent({ mode: 'denied' });
		fixture.model.setResponses([
			toolRequest(call('edit_page', 'edit-1')),
			fauxAssistantMessage('Not allowed.'),
		]);
		expect(await fixture.attempt(agent)).toMatchObject({ status: 'settled' });

		expect(edit).not.toHaveBeenCalled();
		expect(provider.requested).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(provider.decided).toHaveBeenCalledTimes(1));
		expect(await fixture.approvals()).toMatchObject([
			{ status: 'rejected', decidedVia: { kind: 'mode', mode: 'denied' } },
		]);
		const outcome = await outcomeFor(fixture, 'edit-1');
		expect(outcome).toMatchObject({ isError: true });
		expect(outcome?.content).toEqual([
			{
				type: 'text',
				text: 'Tool calls in escalation group "notion-edit" are denied in this context; the tool was not executed.',
			},
		]);
	});

	it('does not run an escalated call again after a crash before its outcome commits', async () => {
		const fixture = await createFixture();
		const { agent, edit } = notionAgent();
		await escalateOnce(fixture, agent);

		fixture.model.setResponses([toolRequest(call('edit_page', 'edit-2'))]);
		fixture.inject();
		await expect(fixture.attempt(agent, 'submission-2')).rejects.toBe(fixture.crash);
		expect(edit).toHaveBeenCalledTimes(2);
		await fixture.reopen();

		fixture.model.setResponses([fauxAssistantMessage('Recovered.')]);
		expect(await fixture.attempt(agent, 'submission-2')).toMatchObject({ status: 'settled' });
		expect(edit).toHaveBeenCalledTimes(2);
		const outcome = await outcomeFor(fixture, 'edit-2');
		expect(outcome).toMatchObject({ isError: true });
		expect(JSON.stringify(outcome?.content)).toContain('was not executed again');
	});

	it('runs an escalated call while a sibling in the same batch parks, and never reruns it', async () => {
		const fixture = await createFixture();
		const { agent, edit, remove } = notionAgent();
		await escalateOnce(fixture, agent);

		fixture.model.setResponses([
			toolRequest(call('edit_page', 'edit-2'), call('delete_page', 'delete-2')),
		]);
		expect(await fixture.attempt(agent, 'submission-2')).toMatchObject({
			status: 'waiting_for_approval',
		});
		expect(edit).toHaveBeenCalledTimes(2);
		expect(remove).not.toHaveBeenCalled();
		const pending = (await fixture.approvals('submission-2')).filter(
			(approval) => approval.status === 'pending',
		);
		expect(pending.map((approval) => approval.toolCallId)).toEqual(['delete-2']);

		const decision = await fixture.decide(pending[0]?.proposalId ?? '', { status: 'approved' });
		expect(decision.grant).toBeUndefined();
		fixture.model.setResponses([fauxAssistantMessage('Both done.')]);
		expect(await fixture.attempt(agent, 'submission-2')).toMatchObject({ status: 'settled' });

		expect(edit).toHaveBeenCalledTimes(2);
		expect(remove).toHaveBeenCalledTimes(1);
		expect(await outcomeFor(fixture, 'edit-2')).toMatchObject({ isError: false, output: 'edited' });
		expect(await outcomeFor(fixture, 'delete-2')).toMatchObject({
			isError: false,
			output: 'removed',
		});
	});

	it('decides a grouped proposal that a crash left pending before it parked', async () => {
		const fixture = await createFixture();
		const provider = installProvider();
		const { agent, edit } = notionAgent();
		const { pending: origin } = await escalateOnce(fixture, agent);

		fixture.model.setResponses([toolRequest(call('edit_page', 'edit-2'))]);
		fixture.loseNextEscalationDecision();
		await expect(fixture.attempt(agent, 'submission-2')).rejects.toBe(fixture.crash);
		expect(edit).toHaveBeenCalledTimes(1);
		expect(await fixture.approvals('submission-2')).toMatchObject([{ status: 'pending' }]);
		await fixture.reopen();

		fixture.model.setResponses([fauxAssistantMessage('Recovered.')]);
		expect(await fixture.attempt(agent, 'submission-2')).toMatchObject({ status: 'settled' });
		expect(edit).toHaveBeenCalledTimes(2);
		expect(await fixture.approvals('submission-2')).toMatchObject([
			{
				status: 'approved',
				decidedVia: { kind: 'escalation', grantProposalId: origin.proposalId },
			},
		]);
		// No one was asked about the recovered call.
		expect(provider.requested).toHaveBeenCalledTimes(1);
	});

	it('rejects a call made under denied on recovery, even once the render asks and a grant exists', async () => {
		const fixture = await createFixture();
		const asking = notionAgent();
		await escalateOnce(fixture, asking.agent);
		const denying = notionAgent({ mode: 'denied' });

		fixture.model.setResponses([toolRequest(call('edit_page', 'edit-2'))]);
		fixture.loseNextEscalationDecision();
		await expect(fixture.attempt(denying.agent, 'submission-2')).rejects.toBe(fixture.crash);
		expect(await fixture.approvals('submission-2')).toMatchObject([
			{ status: 'pending', escalation: { group: 'notion-edit', mode: 'denied' } },
		]);
		await fixture.reopen();

		fixture.model.setResponses([fauxAssistantMessage('Not allowed.')]);
		expect(await fixture.attempt(asking.agent, 'submission-2')).toMatchObject({
			status: 'settled',
		});
		expect(asking.edit).toHaveBeenCalledTimes(1);
		expect(denying.edit).not.toHaveBeenCalled();
		expect(await fixture.approvals('submission-2')).toMatchObject([
			{ status: 'rejected', decidedVia: { kind: 'mode', mode: 'denied' } },
		]);
		expect(await outcomeFor(fixture, 'edit-2')).toMatchObject({ isError: true });
	});

	it('applies the denied mode when a host approves a call that a crash left pending', async () => {
		const fixture = await createFixture();
		const { agent, edit } = notionAgent({ mode: 'denied' });
		fixture.model.setResponses([toolRequest(call('edit_page', 'edit-1'))]);
		fixture.loseNextEscalationDecision();
		await expect(fixture.attempt(agent)).rejects.toBe(fixture.crash);
		const [pending] = await fixture.approvals();
		if (!pending) throw new Error('Expected a pending approval.');
		expect(pending).toMatchObject({ status: 'pending', escalation: { mode: 'denied' } });

		const decision = await fixture.decide(pending.proposalId, {
			status: 'approved',
			actor: 'U123',
		});
		expect(decision.approval).toMatchObject({
			status: 'rejected',
			decidedVia: { kind: 'mode', mode: 'denied' },
		});
		expect(decision.grant).toBeUndefined();
		await fixture.reopen();

		fixture.model.setResponses([fauxAssistantMessage('Not allowed.')]);
		expect(await fixture.attempt(agent)).toMatchObject({ status: 'settled' });
		expect(edit).not.toHaveBeenCalled();
		expect(await fixture.submissions.listToolEscalationGrants?.()).toEqual([]);
		expect(await outcomeFor(fixture, 'edit-1')).toMatchObject({ isError: true });
	});

	it('expires a recovered call past its deadline without reporting it as a Flue decision', async () => {
		const fixture = await createFixture();
		const provider = installProvider();
		const { agent, edit } = notionAgent({ approvalExpiresInMs: 1_000 });
		await escalateOnce(fixture, agent);

		fixture.model.setResponses([toolRequest(call('edit_page', 'edit-2'))]);
		fixture.loseNextEscalationDecision();
		await expect(fixture.attempt(agent, 'submission-2')).rejects.toBe(fixture.crash);
		const later = Date.now() + 5_000;
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(later);
		await fixture.reopen();

		fixture.model.setResponses([fauxAssistantMessage('Too late.')]);
		expect(await fixture.attempt(agent, 'submission-2')).toMatchObject({ status: 'settled' });
		expect(edit).toHaveBeenCalledTimes(1);
		const [expired] = await fixture.approvals('submission-2');
		expect(expired).toMatchObject({ status: 'expired' });
		expect(expired?.decidedVia).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(provider.decided).not.toHaveBeenCalled();
	});

	it('asks the host when the store cannot check grants', async () => {
		const fixture = await createFixture();
		const { agent, edit } = notionAgent();
		await escalateOnce(fixture, agent);
		// A store written before escalation would ignore the decision source and
		// approve without a grant, so it is never asked to.
		delete (fixture.submissions as Partial<AgentSubmissionStore>).listToolEscalationGrants;

		fixture.model.setResponses([toolRequest(call('edit_page', 'edit-2'))]);
		expect(await fixture.attempt(agent, 'submission-2')).toMatchObject({
			status: 'waiting_for_approval',
		});
		expect(edit).toHaveBeenCalledTimes(1);
		expect(await fixture.approvals('submission-2')).toMatchObject([{ status: 'pending' }]);
	});

	it('runs an automatically approved call on the parsed arguments its approval recorded', async () => {
		const fixture = await createFixture();
		let generated = 0;
		const run = vi.fn(async ({ data }: { data: { requestId: string; title: string } }) => ({
			output: data,
		}));
		function TestAgent() {
			useModel('faux/faux-1', { compaction: false });
			useToolEscalation('notion-edit', { mode: 'granted' });
			useTool({
				name: 'edit_page',
				description: 'Edit a Notion page.',
				version: '1',
				input: v.object({
					requestId: v.optional(v.string(), () => `request-${++generated}`),
					title: v.pipe(
						v.string(),
						v.transform((title) => `${title}!`),
					),
				}),
				approval: { required: true, escalation: 'notion-edit' },
				run,
			});
			return 'Edit Notion pages.';
		}
		fixture.model.setResponses([
			toolRequest(fauxToolCall('edit_page', { title: 'Plan' }, { id: 'edit-1' })),
			fauxAssistantMessage('Done.'),
		]);
		expect(await fixture.attempt(TestAgent as Agent)).toMatchObject({ status: 'settled' });

		const [approval] = await fixture.approvals();
		expect(approval?.arguments).toEqual({ requestId: expect.any(String), title: 'Plan!' });
		expect(run).toHaveBeenCalledTimes(1);
		// Neither a fresh default nor a second transform.
		expect(run.mock.calls[0]?.[0].data).toEqual(approval?.arguments);
	});

	it('does not start an escalated call once an abort is recorded', async () => {
		const fixture = await createFixture();
		const { agent, edit } = notionAgent();
		await escalateOnce(fixture, agent);

		fixture.model.setResponses([toolRequest(call('edit_page', 'edit-2'))]);
		fixture.afterNextAutoApproval(async (submissions) => {
			const submission = await submissions.getSubmission('submission-2');
			if (!submission) throw new Error('Expected submission-2.');
			await submissions.requestSessionAbort(submission.sessionKey);
		});
		const settled = await fixture.attempt(agent, 'submission-2').catch((error: unknown) => error);
		expect(settled).not.toBe(fixture.crash);
		expect(edit).toHaveBeenCalledTimes(1);
		const records = await fixture.records();
		const [approval] = await fixture.approvals('submission-2');
		expect(approval).toMatchObject({ status: 'approved' });
		expect(records).not.toContainEqual(
			expect.objectContaining({
				type: 'tool_approval_execution_started',
				proposalId: approval?.proposalId,
			}),
		);
	});

	it('survives a restart: a reopened store keeps the grant', async () => {
		const fixture = await createFixture();
		const { agent, edit } = notionAgent();
		const { pending } = await escalateOnce(fixture, agent);
		await fixture.reopen();

		expect(await fixture.submissions.listToolEscalationGrants?.()).toEqual([
			expect.objectContaining({ group: 'notion-edit', proposalId: pending.proposalId }),
		]);
		fixture.model.setResponses([
			toolRequest(call('edit_page', 'edit-2')),
			fauxAssistantMessage('Done.'),
		]);
		expect(await fixture.attempt(agent, 'submission-2')).toMatchObject({ status: 'settled' });
		expect(edit).toHaveBeenCalledTimes(2);
	});

	it('fails the render when a mounted tool names an undeclared group', async () => {
		const fixture = await createFixture();
		const { agent } = notionAgent({ declare: false });
		fixture.model.setResponses([fauxAssistantMessage('Unreachable.')]);
		// Anchored: the render's own error, not an assertion quoting it.
		await expect(fixture.attempt(agent)).rejects.toThrow(
			/^\[flue\] Tool "edit_page" names escalation group "notion-edit", which this render did not declare\./,
		);
	});
});

describe('MCP tool escalation', () => {
	const createPage: Tool = {
		name: 'create_page',
		description: 'Create a Notion page.',
		inputSchema: {
			type: 'object',
			properties: { title: { type: 'string' } },
			required: ['title'],
		},
	};

	function createMcpServer() {
		const callTool = vi.fn(
			async (request: { name: string }) =>
				({ content: [{ type: 'text', text: `${request.name} ok` }] }) as CallToolResult,
		);
		const connect = vi.fn();
		const mcpConnections: McpConnectionResolver = {
			resolve: (definition) => {
				connect(definition.name);
				return createMcpConnectionWithClient(
					definition.name,
					{
						connect: async () => {},
						close: async () => {},
						listTools: async () => ({ tools: [createPage] }),
						callTool: callTool as never,
					},
					{} as Transport,
					{},
					{ tools: definition.tools, approval: definition.approval },
				);
			},
		};
		return { callTool, connect, mcpConnections };
	}

	function notionMcpAgent(declare: boolean) {
		const NotionAgent = () => {
			useModel('faux/faux-1', { compaction: false });
			if (declare) useToolEscalation('notion-edit');
			useMcpConnection({
				name: 'notion',
				url: 'https://mcp.example.test/mcp',
				approval: { required: true, escalation: 'notion-edit' },
			});
			return 'Edit Notion.';
		};
		return NotionAgent as Agent;
	}

	it('escalates a gated MCP tool group with one approval', async () => {
		const { callTool, mcpConnections } = createMcpServer();
		const fixture = await createFixture({ mcpConnections });
		const agent = notionMcpAgent(true);
		fixture.model.setResponses([
			toolRequest(fauxToolCall('mcp__notion__create_page', { title: 'A' }, { id: 'a' })),
		]);
		expect(await fixture.attempt(agent)).toMatchObject({ status: 'waiting_for_approval' });
		const [pending] = await fixture.approvals();
		expect(pending?.escalation).toEqual({ group: 'notion-edit', mode: 'ask' });
		if (!pending) throw new Error('Expected a pending approval.');
		await fixture.decide(pending.proposalId, { status: 'approved' });
		fixture.model.setResponses([fauxAssistantMessage('Created A.')]);
		expect(await fixture.attempt(agent)).toMatchObject({ status: 'settled' });

		fixture.model.setResponses([
			toolRequest(fauxToolCall('mcp__notion__create_page', { title: 'B' }, { id: 'b' })),
			fauxAssistantMessage('Created B.'),
		]);
		expect(await fixture.attempt(agent, 'submission-2')).toMatchObject({ status: 'settled' });
		expect(callTool.mock.calls.map(([request]) => request)).toEqual([
			{ name: 'create_page', arguments: { title: 'A' } },
			{ name: 'create_page', arguments: { title: 'B' } },
		]);
	});

	it('fails the render before connecting when the MCP group is undeclared', async () => {
		const { callTool, connect, mcpConnections } = createMcpServer();
		const fixture = await createFixture({ mcpConnections });
		fixture.model.setResponses([fauxAssistantMessage('Unreachable.')]);
		await expect(fixture.attempt(notionMcpAgent(false))).rejects.toThrow(
			/^\[flue\] MCP connection "notion" names escalation group "notion-edit", which this render did not declare\./,
		);
		// Checked on the definition, so a typo surfaces even when the server is down.
		expect(connect).not.toHaveBeenCalled();
		expect(callTool).not.toHaveBeenCalled();
	});

	it("keeps a dropped connection's group declaration for its still-mounted tools", async () => {
		const { callTool, mcpConnections } = createMcpServer();
		const fixture = await createFixture({ mcpConnections });
		let enabled = true;
		const NotionAgent = () => {
			useModel('faux/faux-1', { compaction: false });
			useTool({
				name: 'disable_notion',
				description: 'Turn Notion off.',
				version: '1',
				run: async () => {
					enabled = false;
					return { output: 'disabled' };
				},
			});
			if (enabled) {
				useToolEscalation('notion-edit', { mode: 'granted' });
				useMcpConnection({
					name: 'notion',
					url: 'https://mcp.example.test/mcp',
					approval: { required: true, escalation: 'notion-edit' },
				});
			}
			return 'Edit Notion.';
		};
		fixture.model.setResponses([
			toolRequest(fauxToolCall('disable_notion', {}, { id: 'off' })),
			toolRequest(fauxToolCall('mcp__notion__create_page', { title: 'A' }, { id: 'a' })),
			fauxAssistantMessage('Done.'),
		]);
		// MCP tools stay mounted until the next submission; so does their group.
		expect(await fixture.attempt(NotionAgent as Agent)).toMatchObject({ status: 'settled' });
		expect(callTool).toHaveBeenCalledTimes(1);
		expect(await fixture.approvals()).toMatchObject([
			{ status: 'approved', decidedVia: { kind: 'mode', mode: 'granted' } },
		]);
	});
});
