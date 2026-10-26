import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlueContext } from '../client.ts';
import type { ConversationRecord } from '../conversation-records.ts';
import { useModel } from '../hooks/use-model.ts';
import { observe } from '../runtime/events.ts';
import { resetModelsForTests, resolveModel, setProvider } from '../runtime/providers.ts';
import { registerFlueAgents, resetFlueAgentRegistrationForTests } from '../runtime/registration.ts';
import { agentStreamPath } from '../runtime/stream-offsets.ts';
import {
	resetToolApprovalProvider,
	setToolApprovalProvider,
} from '../runtime/tool-approval-provider.ts';
import type { SqlStorage } from '../sql-storage.ts';
import type { ToolApprovalProposal } from '../tool-approval.ts';
import type { Agent, FlueEvent } from '../types.ts';
import {
	CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH,
	type CloudflareAgentResolver,
	type CloudflareAgentResolverContext,
	createCloudflareAgentRuntime,
} from './agent-coordinator.ts';

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const database of databases.splice(0)) database.close();
	resetModelsForTests();
	resetFlueAgentRegistrationForTests();
	resetToolApprovalProvider();
	vi.restoreAllMocks();
});

function definition() {
	const render = vi.fn();
	const agent: Agent = () => {
		render();
		useModel('faux/faux-1', { compaction: false });
	};
	agent.agentName = 'Support';
	return { agent, render };
}

function fixture(resolveAgentForInstance?: CloudflareAgentResolver) {
	const current = definition();
	current.agent.durability = { maxAttempts: 8 };
	registerFlueAgents([{ identity: 'Support', agent: current.agent }]);
	const model = fauxProvider();
	setProvider(model.provider);
	const runtime = createCloudflareAgentRuntime({
		agents: [{ name: 'Support', agent: current.agent }],
		resolveAgentForInstance,
		createContext: ({ instance, agentName, request, submissionId, submissionStore }) =>
			createFlueContext({
				id: instance.name,
				agentName,
				env: instance.env,
				req: request,
				submissionId,
				submissionStore,
				agentConfig: { resolveModel },
			}),
		runWithInstanceContext: (_instance, _agentName, callback) => callback(),
	});

	function cell(name: string) {
		const database = new DatabaseSync(':memory:');
		databases.push(database);
		const sql: SqlStorage = {
			exec(query, ...bindings) {
				const statement = database.prepare(query);
				const expectsRows =
					/^(SELECT|WITH|PRAGMA)/i.test(query.trimStart()) || /\bRETURNING\b/i.test(query);
				const rows = expectsRows ? statement.all(...(bindings as SQLInputValue[])) : [];
				if (!expectsRows) statement.run(...(bindings as SQLInputValue[]));
				return { toArray: () => rows };
			},
		};
		const storage = {
			sql,
			transactionSync<T>(callback: () => T): T {
				database.exec('BEGIN');
				try {
					const result = callback();
					database.exec('COMMIT');
					return result;
				} catch (error) {
					database.exec('ROLLBACK');
					throw error;
				}
			},
		};
		const pending: Promise<unknown>[] = [];
		const instance: CloudflareAgentResolverContext['instance'] = {
			name,
			env: { release: name },
			ctx: {
				id: { toString: () => name },
				storage,
				waitUntil: (promise) => {
					pending.push(promise);
				},
			},
			schedule: vi.fn(async () => {}),
			runFiber: vi.fn(async (_name, callback) => {
				await callback({ stash: vi.fn() });
			}),
		};
		const prepared = runtime.prepare({ storage, className: 'FlueSupport', agentName: 'Support' });
		runtime.attach(instance, prepared);
		return {
			instance,
			sql,
			store: prepared.submissionStore,
			async records(): Promise<ConversationRecord[]> {
				return (
					await prepared.conversationStreamStore.read(agentStreamPath('Support', name))
				).batches.flatMap((batch) => batch.records);
			},
			restart() {
				runtime.attach(instance, prepared);
			},
			async send(initialData?: unknown) {
				return runtime.onRequest(
					instance,
					new Request(`https://test/agents/Support/${name}`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ kind: 'user', body: 'Hello', initialData }),
					}),
				);
			},
			async dispatch(initialData?: unknown) {
				return runtime.onRequest(
					instance,
					new Request(`https://flue.invalid${CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH}`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							submissionId: 'dispatch',
							agent: 'Support',
							id: name,
							message: { kind: 'user', body: 'Hello' },
							acceptedAt: new Date().toISOString(),
							initialData,
						}),
					}),
				);
			},
			async drain() {
				model.setResponses([fauxAssistantMessage([fauxText('Done.')], { stopReason: 'stop' })]);
				await runtime.drainSubmissions(instance);
				while (pending.length) await Promise.all(pending.splice(0));
			},
		};
	}
	return { cell, current, runtime };
}

async function receipt(response: Response | null): Promise<{ submissionId: string }> {
	if (!response) throw new Error('Expected an admission response');
	return response.json();
}

describe('per-instance agent resolution', () => {
	it('keeps static registration as the default', async () => {
		const { cell, current } = fixture();
		const alice = cell('alice');
		const response = await alice.send();
		expect(response?.status).toBe(202);
		const { submissionId } = await receipt(response);
		await alice.drain();
		expect(current.render).toHaveBeenCalled();
		expect(await alice.store.getSubmission(submissionId)).toMatchObject({
			status: 'settled',
			maxAttempts: 8,
		});
		expect((await alice.store.getSubmission(submissionId))?.error).toBeUndefined();
	});

	it('isolates selections, schemas, and retry policies for cells of the same agent', async () => {
		const old = definition();
		old.agent.initialData = v.object({ legacy: v.string() });
		old.agent.durability = { maxAttempts: 2 };
		const next = definition();
		next.agent.initialData = v.object({ modern: v.number() });
		const resolve = vi.fn<CloudflareAgentResolver>(({ instance }) =>
			instance.env.release === 'alice' ? old.agent : next.agent,
		);
		const { cell, current } = fixture(resolve);
		const alice = cell('alice');
		const bob = cell('bob');
		expect((await alice.send({ modern: 1 }))?.status).toBe(400);
		expect((await bob.dispatch({ legacy: 'x' }))?.status).toBe(400);
		const accepted = await alice.send({ legacy: 'x' });
		expect(accepted?.status).toBe(202);
		expect((await bob.dispatch({ modern: 1 }))?.status).toBe(200);
		const { submissionId } = await receipt(accepted);
		await alice.drain();
		await bob.drain();
		expect(old.render).toHaveBeenCalled();
		expect(next.render).toHaveBeenCalled();
		expect(current.render).not.toHaveBeenCalled();
		expect(resolve).toHaveBeenCalledTimes(2);
		expect(await alice.store.getSubmission(submissionId)).toMatchObject({
			status: 'settled',
			maxAttempts: 2,
		});
		// No policy on the selected function means store defaults, not current's 8.
		expect(await bob.store.getSubmission('dispatch')).toMatchObject({
			status: 'settled',
			maxAttempts: 10,
		});
		expect((await alice.store.getSubmission(submissionId))?.error).toBeUndefined();
		expect((await bob.store.getSubmission('dispatch'))?.error).toBeUndefined();
	});

	it('shares an in-flight resolution across concurrent admissions', async () => {
		const selected = definition();
		const loading = Promise.withResolvers<Agent>();
		const resolve = vi.fn<CloudflareAgentResolver>(() => loading.promise);
		const { cell } = fixture(resolve);
		const alice = cell('alice');
		const admissions = [alice.send(), alice.send()];
		await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
		loading.resolve(selected.agent);
		expect((await Promise.all(admissions)).map((response) => response?.status)).toEqual([202, 202]);
	});

	it('retries failed loads and rejects wrong or missing definitions without a fallback', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const selected = definition();
		const resolve = vi
			.fn<CloudflareAgentResolver>()
			.mockRejectedValueOnce(new Error('package unavailable'))
			.mockResolvedValueOnce(Object.assign(() => {}, { agentName: 'Other' }))
			.mockResolvedValueOnce(undefined as unknown as Agent)
			.mockResolvedValue(selected.agent);
		const { cell, current } = fixture(resolve);
		const alice = cell('alice');
		for (let attempt = 0; attempt < 3; attempt++) expect((await alice.send())?.status).toBe(500);
		expect(await alice.store.hasUnsettledSubmissions()).toBe(false);
		expect((await alice.send())?.status).toBe(202);
		await alice.drain();
		expect(resolve).toHaveBeenCalledTimes(4);
		expect(selected.render).toHaveBeenCalled();
		expect(current.render).not.toHaveBeenCalled();
	});

	it.each(['unready', 'queued', 'running'] as const)(
		'retries a failed background load without claiming %s work',
		async (status) => {
			vi.spyOn(console, 'error').mockImplementation(() => {});
			const selected = definition();
			const resolve = vi.fn<CloudflareAgentResolver>(() => selected.agent);
			const { cell, current } = fixture(resolve);
			const alice = cell('alice');
			const response = await alice.send();
			const { submissionId } = await receipt(response);
			if (status === 'unready') {
				// Simulate the crash window before canonical readiness was recorded.
				alice.sql.exec(
					'UPDATE flue_agent_submissions SET canonical_ready_at = NULL WHERE submission_id = ?',
					submissionId,
				);
			} else if (status === 'running') {
				await alice.store.claimSubmission({
					submissionId,
					attemptId: 'old',
					ownerId: 'old',
					leaseExpiresAt: 0,
				});
			}
			const before = await alice.store.getSubmission(submissionId);
			alice.restart();
			resolve.mockRejectedValueOnce(new Error('package unavailable'));
			await alice.drain();
			expect(await alice.store.getSubmission(submissionId)).toMatchObject({
				status: before?.status,
				attemptCount: before?.attemptCount,
			});
			expect(current.render).not.toHaveBeenCalled();
			expect(selected.render).not.toHaveBeenCalled();
			await alice.drain();
			expect((await alice.store.getSubmission(submissionId))?.status).toBe('settled');
			expect((await alice.store.getSubmission(submissionId))?.error).toBeUndefined();
		},
	);

	it.each(['unready', 'queued', 'running'] as const)(
		'resolves during %s recovery after residency ends',
		async (status) => {
			const selected = definition();
			selected.agent.initialData = v.object({ legacy: v.string() });
			const resolve = vi.fn<CloudflareAgentResolver>(() => selected.agent);
			const { cell, current, runtime } = fixture(resolve);
			const alice = cell('alice');
			let submissionId = 'unready';
			if (status === 'unready') {
				await alice.store.admitDirect({
					kind: 'direct',
					agent: 'Support',
					id: 'alice',
					submissionId,
					initialData: { legacy: 'x' },
					message: { kind: 'user', body: 'Hello' },
					acceptedAt: new Date().toISOString(),
				});
			} else {
				const response = await alice.send({ legacy: 'x' });
				({ submissionId } = await receipt(response));
				if (status === 'running') {
					await alice.store.claimSubmission({
						submissionId,
						attemptId: 'interrupted',
						ownerId: 'old',
						leaseExpiresAt: 0,
					});
				}
			}
			alice.restart();
			await runtime.onStart(alice.instance, () => {});
			await runtime.onFiberRecovered(alice.instance, { name: 'flue:submission-attempt' }, () => {});
			await alice.drain();
			expect(resolve).toHaveBeenCalledTimes(status === 'unready' ? 1 : 2);
			expect(selected.render).toHaveBeenCalled();
			expect(current.render).not.toHaveBeenCalled();
			expect(await alice.store.getSubmission(submissionId)).toMatchObject({ status: 'settled' });
			expect((await alice.store.getSubmission(submissionId))?.error).toBeUndefined();
		},
	);
});

describe('tool escalation through the coordinator', () => {
	it('projects and announces a grant, its escalated approvals, and its revocation', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const decided = vi.fn();
		setToolApprovalProvider({ requested: vi.fn(), decided });
		const events: FlueEvent[] = [];
		const stop = observe((event) => {
			if (event.type.startsWith('tool_')) events.push(event);
		});
		try {
			const { cell, runtime } = fixture();
			const alice = cell('alice');
			await alice.send();
			await alice.drain();
			const created = (await alice.records()).find(
				(record): record is Extract<ConversationRecord, { type: 'conversation_created' }> =>
					record.type === 'conversation_created',
			);
			if (!created) throw new Error('Expected the root conversation.');
			const proposal = (toolCallId: string): ToolApprovalProposal => ({
				proposalId: `approval_${toolCallId}`,
				submissionId: 'parked',
				agentName: 'Support',
				instanceId: 'alice',
				conversationId: created.conversationId,
				harness: created.harness,
				session: created.session,
				assistantMessageId: 'assistant-1',
				toolCallId,
				toolName: 'edit_page',
				toolVersion: '1',
				arguments: {},
				requestedAt: 1,
				escalation: { group: 'notion-edit', mode: 'ask' },
			});
			for (const toolCallId of ['call-1', 'call-2']) {
				await alice.store.createToolApproval?.(proposal(toolCallId));
			}

			const approval = await runtime.resolveToolApproval(alice.instance, {
				agent: 'Support',
				id: 'alice',
				proposalId: 'approval_call-1',
				status: 'approved',
				actor: 'U1',
			});
			expect(approval.decidedVia).toEqual({ kind: 'host', actor: 'U1' });
			expect(
				await runtime.listToolEscalations(alice.instance, { agent: 'Support', id: 'alice' }),
			).toEqual([expect.objectContaining({ group: 'notion-edit', proposalId: 'approval_call-1' })]);
			await vi.waitFor(() =>
				expect(decided).toHaveBeenCalledWith(
					expect.objectContaining({ proposalId: 'approval_call-2', status: 'approved' }),
				),
			);

			const wakesBefore = vi.mocked(alice.instance.schedule).mock.calls.length;
			expect(
				await runtime.revokeToolEscalation(alice.instance, {
					agent: 'Support',
					id: 'alice',
					group: 'notion-edit',
					actor: 'U2',
					reason: 'done editing',
				}),
			).toEqual({ revoked: true });
			// A wake retries the revocation record if its append is deferred.
			expect(vi.mocked(alice.instance.schedule).mock.calls.length).toBeGreaterThan(wakesBefore);
			expect(
				await runtime.revokeToolEscalation(alice.instance, {
					agent: 'Support',
					id: 'alice',
					group: 'notion-edit',
				}),
			).toEqual({ revoked: false });

			const records = await alice.records();
			expect(records).toContainEqual(
				expect.objectContaining({
					type: 'tool_approval_decided',
					proposalId: 'approval_call-2',
					decidedVia: { kind: 'escalation', grantProposalId: 'approval_call-1', actor: 'U1' },
				}),
			);
			expect(records).toContainEqual(
				expect.objectContaining({
					type: 'tool_escalation_granted',
					group: 'notion-edit',
					proposalId: 'approval_call-1',
					actor: 'U1',
				}),
			);
			expect(records).toContainEqual(
				expect.objectContaining({
					type: 'tool_escalation_revoked',
					group: 'notion-edit',
					proposalId: 'approval_call-1',
					actor: 'U2',
					reason: 'done editing',
				}),
			);
			expect(await alice.store.listToolEscalationProjectionWork?.()).toEqual([]);
			expect(
				events.map((event) =>
					event.type === 'tool_approval_decided'
						? [event.type, event.proposalId, event.via]
						: [event.type, 'proposalId' in event ? event.proposalId : undefined],
				),
			).toEqual([
				['tool_approval_decided', 'approval_call-1', 'host'],
				['tool_escalation_granted', 'approval_call-1'],
				['tool_approval_decided', 'approval_call-2', 'escalation'],
				['tool_escalation_revoked', 'approval_call-1'],
			]);
		} finally {
			stop();
		}
	});

	it('rejects a grant read or revocation addressed to another instance', async () => {
		const { cell, runtime } = fixture();
		const alice = cell('alice');
		await expect(
			runtime.listToolEscalations(alice.instance, { agent: 'Support', id: 'bob' }),
		).rejects.toThrow('does not match this agent instance');
		await expect(
			runtime.revokeToolEscalation(alice.instance, {
				agent: 'Support',
				id: 'alice',
				group: 'Not A Group',
			}),
		).rejects.toThrow('revocation group must be an escalation group name');
	});
});
