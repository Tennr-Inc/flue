import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';
import { afterEach, expect, it, vi } from 'vitest';
import { createFlueContext } from './client.ts';
import { ConversationRecordWriter } from './conversation-writer.ts';
import type { Harness } from './harness.ts';
import { init, instrument, useAgentStart, useModel, useTool } from './index.ts';
import { sqlite, start } from './node/index.ts';
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
import type { FlueObservation, ThinkingLevel } from './types.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	resetModelsForTests();
});

it('classifies the first and post-tool root calls with current delivery and messages', async () => {
	const faux = fauxProvider({
		models: [
			{ id: 'main', reasoning: true },
			{ id: 'classifier', reasoning: true },
		],
	});
	const requests: Array<{ model: string; reasoning: string | undefined; messages: number }> = [];
	const response =
		(message: ReturnType<typeof fauxAssistantMessage>): FauxResponseFactory =>
		(context, options, _state, model) => {
			requests.push({
				model: model.id,
				reasoning: (options as SimpleStreamOptions | undefined)?.reasoning,
				messages: context.messages.length,
			});
			return message;
		};
	faux.setResponses([
		response(fauxAssistantMessage('high')),
		response(
			fauxAssistantMessage([fauxToolCall('lookup', {}, { id: 'lookup-1' })], {
				stopReason: 'toolUse',
			}),
		),
		response(fauxAssistantMessage('low')),
		response(fauxAssistantMessage('Done.')),
	]);
	const decisions: Array<{ delivery: string; messages: number; signal: AbortSignal }> = [];
	const startHook = vi.fn();
	function ClassifiedAgent() {
		useModel('faux/main', {
			thinkingLevel: 'medium',
			beforeModelCall: async ({ delivery, messages, signal, classify }) => {
				decisions.push({ delivery: delivery.body, messages: messages.length, signal });
				const label = await classify({ model: 'faux/classifier', prompt: delivery.body });
				return { thinkingLevel: label as ThinkingLevel };
			},
		});
		useAgentStart(({ append }) => {
			startHook();
			append({ kind: 'signal', type: 'prepared', body: 'Prepared context.' });
		});
		useTool({ name: 'lookup', description: 'Look up the answer.', run: () => 'found' });
		return 'Use the lookup tool, then answer.';
	}
	const observations: FlueObservation[] = [];
	const dispose = instrument({
		observe: (event) => {
			observations.push(event);
		},
		interceptor: (_operation, _context, next) => next(),
		dispose() {},
	});
	const runtime = await start({
		agents: [ClassifiedAgent],
		db: sqlite(),
		providers: [faux.provider],
		env: {},
	});
	const agent = init(ClassifiedAgent, { id: 'classified-agent' });
	cleanups.push(async () => {
		await agent.abort();
		await runtime.stop();
		await dispose();
	});

	await expect(agent.read(await agent.dispatch('Find it.'))).resolves.toMatchObject({
		text: 'Done.',
	});
	expect(startHook).toHaveBeenCalledTimes(1);
	expect(decisions.map(({ delivery, messages }) => ({ delivery, messages }))).toEqual([
		{ delivery: 'Prepared context.', messages: 2 },
		{ delivery: 'Prepared context.', messages: 4 },
	]);
	expect(decisions.every((decision) => !decision.signal.aborted)).toBe(true);
	expect(requests.map(({ model, reasoning }) => ({ model, reasoning }))).toEqual([
		{ model: 'classifier', reasoning: undefined },
		{ model: 'main', reasoning: 'high' },
		{ model: 'classifier', reasoning: undefined },
		{ model: 'main', reasoning: 'low' },
	]);
	expect(
		observations
			.filter((event) => event.type === 'turn_request')
			.map((event) => event.request.reasoningLevel),
	).toEqual(['high', 'low']);
});

it('uses the static default on fallback and records an explicit off override', async () => {
	const faux = fauxProvider({ models: [{ id: 'main', reasoning: true }] });
	const providerEfforts: Array<string | undefined> = [];
	faux.setResponses([
		(_context, options) => {
			providerEfforts.push((options as SimpleStreamOptions | undefined)?.reasoning);
			return fauxAssistantMessage('First.');
		},
		(_context, options) => {
			providerEfforts.push((options as SimpleStreamOptions | undefined)?.reasoning);
			return fauxAssistantMessage('Second.');
		},
	]);
	function DefaultAgent() {
		useModel('faux/main', {
			thinkingLevel: 'high',
			beforeModelCall: async ({ delivery }) =>
				delivery.body === 'Disable.' ? { thinkingLevel: 'off' as const } : undefined,
		});
		return 'Answer.';
	}
	const observations: FlueObservation[] = [];
	const dispose = instrument({
		observe: (event) => {
			observations.push(event);
		},
		interceptor: (_operation, _context, next) => next(),
		dispose() {},
	});
	const runtime = await start({
		agents: [DefaultAgent],
		db: sqlite(),
		providers: [faux.provider],
		env: {},
	});
	const agent = init(DefaultAgent, { id: 'default-effort-agent' });
	cleanups.push(async () => {
		await agent.abort();
		await runtime.stop();
		await dispose();
	});
	await agent.read(await agent.dispatch('Hello.'));
	await agent.read(await agent.dispatch('Disable.'));
	expect(providerEfforts).toEqual(['high', undefined]);
	expect(
		observations
			.filter((event) => event.type === 'turn_request')
			.map((event) => event.request.reasoningLevel),
	).toEqual(['high', 'off']);
});

it('cancels a pending selector before the root provider call', async () => {
	const faux = fauxProvider({ models: [{ id: 'main', reasoning: true }] });
	faux.setResponses([fauxAssistantMessage('Must not run.')]);
	const entered = Promise.withResolvers<AbortSignal>();
	function CancelAgent() {
		useModel('faux/main', {
			beforeModelCall: ({ signal }) => {
				entered.resolve(signal);
				return new Promise(() => {});
			},
		});
		return 'Answer.';
	}
	const runtime = await start({
		agents: [CancelAgent],
		db: sqlite(),
		providers: [faux.provider],
		env: {},
	});
	const agent = init(CancelAgent, { id: 'cancel-selector-agent' });
	cleanups.push(async () => {
		await agent.abort();
		await runtime.stop();
	});
	const receipt = await agent.dispatch('Hello.');
	const signal = await entered.promise;
	await agent.abort();
	await expect(agent.read(receipt)).rejects.toBeDefined();
	expect(signal.aborted).toBe(true);
	expect(faux.state.callCount).toBe(0);
});

it('reuses the durable effort after an interrupted attempt', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'flue-model-choice-'));
	const path = agentStreamPath('RetryAgent', 'instance-1');
	const crash = new Error('injected crash after decision commit');
	const faux = fauxProvider({ models: [{ id: 'main', reasoning: true }] });
	setProvider(faux.provider);
	let crashOnDecision = true;
	let attemptNumber = 0;
	let admitted = false;
	const harnesses: Harness[] = [];
	const selector = vi.fn(() => ({ thinkingLevel: 'high' as const }));
	const providerEfforts: Array<string | undefined> = [];
	faux.setResponses([
		(_context, options) => {
			providerEfforts.push((options as SimpleStreamOptions | undefined)?.reasoning);
			return fauxAssistantMessage('Recovered.');
		},
	]);
	function RetryAgent() {
		useModel('faux/main', { thinkingLevel: 'low', beforeModelCall: selector });
		return 'Answer.';
	}
	async function open() {
		const database = new DatabaseSync(join(directory, 'store.sqlite'));
		const sql: SqlStorage = {
			exec(query, ...bindings) {
				const statement = database.prepare(query);
				let rows: Record<string, unknown>[] = [];
				if (/^(SELECT|WITH|PRAGMA)/i.test(query.trimStart()) || /\bRETURNING\b/i.test(query)) {
					rows = statement.all(...(bindings as SQLInputValue[])) as Record<string, unknown>[];
				} else {
					statement.run(...(bindings as SQLInputValue[]));
				}
				return { toArray: () => rows as Record<string, unknown>[] };
			},
		};
		const transaction = <T>(run: () => T): T => {
			database.exec('BEGIN');
			try {
				const value = run();
				database.exec('COMMIT');
				return value;
			} catch (error) {
				database.exec('ROLLBACK');
				throw error;
			}
		};
		ensureSqlAgentExecutionTables(sql);
		const submissions = createSqlAgentExecutionStoreFromSql(sql, transaction);
		const store = new SqliteConversationStreamStore(sql, transaction);
		const append = store.append.bind(store);
		store.append = async (input) => {
			const result = await append(input);
			if (
				crashOnDecision &&
				input.records.some((record) => record.type === 'model_call_decision')
			) {
				throw crash;
			}
			return result;
		};
		const writer = await ConversationRecordWriter.create({
			store,
			path,
			identity: { agentName: 'RetryAgent', instanceId: 'instance-1' },
			producerId: `attempt-${attemptNumber}`,
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
	async function attempt() {
		const { submissions, writer } = connection;
		if (!admitted) {
			await ensureInstanceIdentity(writer, RetryAgent, undefined);
			await submissions.admitDirect({
				kind: 'direct',
				submissionId: 'submission-1',
				agent: 'RetryAgent',
				id: 'instance-1',
				message: { kind: 'user', body: 'Answer now.' },
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
			resolveAgent: () => RetryAgent,
			conversationWriter: writer,
			isShutdownAbort: (error) => error === crash,
			createContext: (submissionId) => {
				const context = createFlueContext({
					id: 'instance-1',
					agentName: 'RetryAgent',
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
		return submissions.getSubmission('submission-1');
	}

	await expect(attempt()).rejects.toBe(crash);
	expect(faux.state.callCount).toBe(0);
	expect(selector).toHaveBeenCalledTimes(1);
	await close();
	crashOnDecision = false;
	connection = await open();
	await expect(attempt()).resolves.toMatchObject({ status: 'settled' });
	expect(selector).toHaveBeenCalledTimes(1);
	expect(providerEfforts).toEqual(['high']);
	const records = (await connection.store.read(path)).batches.flatMap((batch) => batch.records);
	expect(records.filter((record) => record.type === 'model_call_decision')).toHaveLength(1);
	expect(records.findIndex((record) => record.type === 'model_call_decision')).toBeLessThan(
		records.findIndex((record) => record.type === 'assistant_message_started'),
	);
});
