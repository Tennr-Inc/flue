import type { Transport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationRecord } from './conversation-records.ts';
import type { ReducedConversationState } from './conversation-reducer.ts';
import { SubmissionTimeoutError } from './errors.ts';
import { registerExecutionInterceptor } from './execution-interceptor.ts';
import { createHookStateBuffer } from './hooks/use-persistent-state.ts';
import { createMcpConnectionWithClient } from './mcp.ts';
import { Session } from './session.ts';
import { defineTool } from './tool.ts';
import type { ToolApproval, ToolApprovalProposal } from './tool-approval.ts';
import { toolApprovalProposalId } from './tool-approval.ts';
import type { ToolDefinition } from './tool-types.ts';

describe('tool state write fencing', () => {
	it('discards writes made before and after an invocation scope is abandoned', async () => {
		const state = createHookStateBuffer(new Map());
		const scope = state.createWriteScope();
		let release!: () => void;
		const paused = new Promise<void>((resolve) => {
			release = resolve;
		});
		const running = scope.run(async () => {
			state.write('phase', 'started');
			await paused;
			state.write('phase', 'late');
		});

		scope.discard();
		release();
		await running;

		expect(state.current('phase')).toBeUndefined();
		expect(state.drain()).toEqual([]);
	});

	it('merges a completed invocation scope into the next atomic state drain', async () => {
		const state = createHookStateBuffer(new Map());
		const scope = state.createWriteScope();
		await scope.run(async () => {
			state.write('phase', 'complete');
		});
		scope.commit();

		expect(state.current('phase')).toEqual({ value: 'complete' });
		expect(state.drain()).toEqual([{ name: 'phase', value: 'complete' }]);
	});
});

describe('approved tool batch repair', () => {
	it('does not fence or invoke an approved tool after the resumed budget expires', async () => {
		const run = vi.fn(async () => ({ output: 'done' }));
		const tool = defineTool({
			name: 'dangerous_action',
			description: 'Perform an approved action.',
			version: 'dangerous-action-v1',
			approval: { required: true },
			run,
		});
		const appendCanonical = vi.fn(async (_records: ConversationRecord[]) => {});
		const fakeSession = {
			agentTools: [tool],
			throwIfSubmissionHalted: vi.fn(async () => {
				throw new SubmissionTimeoutError();
			}),
			conversationWriter: { hasRecord: vi.fn(async () => false) },
			appendCanonical,
		};
		const materializeApprovalOutcome = Reflect.get(
			Session.prototype,
			'materializeApprovalOutcome',
		) as (
			this: typeof fakeSession,
			partial: { entryId: string; assistant: never },
			call: { id: string; name: string },
			approval: ToolApproval,
			signal: AbortSignal,
		) => Promise<ConversationRecord>;
		const approval: ToolApproval = {
			proposalId: 'approval-1',
			submissionId: 'submission-1',
			instanceId: 'instance-1',
			conversationId: 'conversation-1',
			harness: 'default',
			session: 'default',
			assistantMessageId: 'assistant-1',
			toolCallId: 'call-1',
			toolName: tool.name,
			toolVersion: 'dangerous-action-v1',
			arguments: {},
			requestedAt: 1,
			status: 'approved',
			decidedAt: 2,
		};

		await expect(
			materializeApprovalOutcome.call(
				fakeSession,
				{ entryId: 'assistant-1', assistant: {} as never },
				{ id: 'call-1', name: tool.name },
				approval,
				new AbortController().signal,
			),
		).rejects.toBeInstanceOf(SubmissionTimeoutError);
		expect(appendCanonical).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});

	it('runs approved tools through normal start, tracing, and post-commit publication', async () => {
		const run = vi.fn(async () => ({ output: 'done' }));
		const tool = defineTool({
			name: 'dangerous_action',
			description: 'Perform an approved action.',
			version: 'dangerous-action-v1',
			approval: { required: true },
			run,
		});
		const emit = vi.fn();
		const pendingToolPublications = new Map<string, () => void>();
		const operations: unknown[] = [];
		const unregister = registerExecutionInterceptor(async (operation, _context, next) => {
			operations.push(operation);
			return await next();
		});
		const fakeSession = {
			agentTools: [tool],
			conversationWriter: { hasRecord: vi.fn(async () => false) },
			throwIfSubmissionHalted: vi.fn(async () => {}),
			appendCanonical: vi.fn(async (_records: ConversationRecord[]) => {}),
			canonicalEnvelope: (type: string, id: string) => ({
				v: 1 as const,
				id,
				type,
				conversationId: 'conversation-1',
				harness: 'default',
				session: 'default',
				timestamp: '2026-09-03T00:00:00.000Z',
			}),
			createToolLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
			runWithToolStateScope: async (_signal: AbortSignal, execute: () => Promise<unknown>) =>
				await execute(),
			runWithToolTimeout: async (
				_tool: unknown,
				signal: AbortSignal,
				execute: (signal: AbortSignal) => Promise<unknown>,
			) => await execute(signal),
			executionContext: () => ({}),
			emit,
			pendingToolPublications,
			activeActionHarnesses: new Set(),
		};
		const materializeApprovalOutcome = Reflect.get(
			Session.prototype,
			'materializeApprovalOutcome',
		) as (
			this: typeof fakeSession,
			partial: { entryId: string; assistant: never },
			call: { id: string; name: string },
			approval: ToolApproval,
			signal: AbortSignal,
		) => Promise<ConversationRecord>;
		const approval: ToolApproval = {
			proposalId: 'approval-1',
			submissionId: 'submission-1',
			instanceId: 'instance-1',
			conversationId: 'conversation-1',
			harness: 'default',
			session: 'default',
			assistantMessageId: 'assistant-1',
			toolCallId: 'call-1',
			toolName: tool.name,
			toolVersion: 'dangerous-action-v1',
			arguments: {},
			requestedAt: 1,
			status: 'approved',
			decidedAt: 2,
		};

		try {
			const outcome = await materializeApprovalOutcome.call(
				fakeSession,
				{ entryId: 'assistant-1', assistant: {} as never },
				{ id: 'call-1', name: tool.name },
				approval,
				new AbortController().signal,
			);

			expect(run).toHaveBeenCalledTimes(1);
			expect(operations).toContainEqual({
				type: 'tool',
				toolCallId: 'call-1',
				toolName: tool.name,
			});
			expect(emit).toHaveBeenCalledWith(
				{ type: 'tool_start', toolName: tool.name, toolCallId: 'call-1' },
				{ origin: 'model', description: tool.description, args: {} },
			);
			expect(outcome).toEqual(expect.objectContaining({ type: 'tool_outcome', output: 'done' }));
			expect(pendingToolPublications.has('call-1')).toBe(true);

			pendingToolPublications.get('call-1')?.();
			expect(emit).toHaveBeenLastCalledWith(
				expect.objectContaining({
					type: 'tool',
					toolName: tool.name,
					toolCallId: 'call-1',
					isError: false,
				}),
				{
					origin: 'model',
					description: tool.description,
					effectiveResult: 'done',
				},
			);
		} finally {
			unregister();
		}
	});

	it('marks a fenced terminal execution unknown and emits an automatic decision', async () => {
		const tool = defineTool({
			name: 'dangerous_action',
			description: 'Perform an approved action.',
			version: 'dangerous-action-v1',
			approval: { required: true },
			run: async () => ({ output: 'done' }),
		});
		const proposalId = toolApprovalProposalId('submission-1', 'assistant-1', 'call-1');
		const pending: ToolApproval = {
			proposalId,
			submissionId: 'submission-1',
			instanceId: 'instance-1',
			conversationId: 'conversation-1',
			harness: 'default',
			session: 'default',
			assistantMessageId: 'assistant-1',
			toolCallId: 'call-1',
			toolName: tool.name,
			toolVersion: 'dangerous-action-v1',
			arguments: {},
			requestedAt: 1,
			status: 'pending',
		};
		const decided: ToolApproval = {
			...pending,
			status: 'aborted',
			decidedAt: 2,
			reason: 'Submission timed out.',
		};
		const assistantEntry = {
			type: 'message' as const,
			id: 'assistant-1',
			parentId: null,
			timestamp: '2026-09-03T00:00:00.000Z',
			submissionId: 'submission-1',
			message: {
				role: 'assistant',
				content: [{ type: 'toolCall', id: 'call-1', name: tool.name, arguments: {} }],
				stopReason: 'toolUse',
			},
		};
		const conversation = {
			activeLeafId: 'assistant-1',
			entries: new Map([['assistant-1', assistantEntry]]),
			toolOutcomes: new Map(),
			toolOutcomeRecords: new Map(),
			childConversations: new Map(),
		} as unknown as ReducedConversationState;
		const unknownOutcome = {
			v: 1,
			id: 'record_tool_outcome_assistant-1_call-1',
			type: 'tool_outcome',
			conversationId: 'conversation-1',
			harness: 'default',
			session: 'default',
			timestamp: '2026-09-03T00:00:00.000Z',
			assistantMessageId: 'assistant-1',
			toolCallId: 'call-1',
			toolName: tool.name,
			isError: true,
			content: [{ type: 'text', text: '{"type":"interrupted"}' }],
		} satisfies ConversationRecord;
		const appendCanonical = vi.fn(async (_records: ConversationRecord[]) => {});
		const emit = vi.fn();
		const appendRepairedToolResultBatch = vi.fn(
			async (
				_assistantEntryId: string,
				_toolCalls: ReadonlyArray<{ id: string; name: string }>,
				_conversation: ReducedConversationState,
				_resolved: Map<string, ConversationRecord>,
			) => {},
		);
		const approvalInterruptedOutcomeRecord = vi.fn(() => unknownOutcome);
		const fakeSession = {
			ownsDanglingState: () => () => true,
			conversationWriter: {
				getConversation: vi.fn(async () => conversation),
				hasRecord: vi.fn(
					async (id: string) =>
						id.includes('tool_approval_requested') ||
						id.includes('tool_approval_execution_started'),
				),
			},
			agentTools: [tool],
			submissionStore: {
				getToolApproval: vi.fn(async () => pending),
				decideToolApproval: vi.fn(async () => ({
					approval: decided,
					decisionApplied: true,
					resumed: false,
				})),
			},
			conversationId: 'conversation-1',
			executionIdentity: { harness: 'default' },
			name: 'default',
			approvalInterruptedOutcomeRecord,
			approvalFailureOutcomeRecord: vi.fn(),
			canonicalEnvelope: (type: string, id: string) => ({
				v: 1 as const,
				id,
				type,
				conversationId: 'conversation-1',
				harness: 'default',
				session: 'default',
				timestamp: '2026-09-03T00:00:00.000Z',
			}),
			appendCanonical,
			emit,
			appendRepairedToolResultBatch,
		};
		const settleTrailingToolBatch = Reflect.get(Session.prototype, 'settleTrailingToolBatch') as (
			this: typeof fakeSession,
			scope: { submissionId: string | undefined } | 'any',
		) => Promise<ReadonlyArray<{ id: string; name: string }>>;

		const settled = await settleTrailingToolBatch.call(fakeSession, {
			submissionId: 'submission-1',
		});

		expect(settled).toEqual([{ id: 'call-1', name: tool.name }]);
		expect(approvalInterruptedOutcomeRecord).toHaveBeenCalledWith(
			'assistant-1',
			expect.objectContaining({ id: 'call-1', name: tool.name }),
		);
		const resolved = appendRepairedToolResultBatch.mock.calls[0]?.[3] as Map<
			string,
			ConversationRecord
		>;
		expect(resolved.get('call-1')).toBe(unknownOutcome);
		expect(appendCanonical).toHaveBeenCalledWith([
			expect.objectContaining({
				type: 'tool_approval_decided',
				proposalId,
				status: 'aborted',
			}),
		]);
		expect(emit).toHaveBeenCalledWith({
			type: 'tool_approval_decided',
			proposalId,
			toolName: tool.name,
			toolCallId: 'call-1',
			status: 'aborted',
			reason: 'Submission timed out.',
		});
		expect(appendCanonical.mock.invocationCallOrder[0]).toBeLessThan(
			emit.mock.invocationCallOrder[0] as number,
		);
	});

	it('persists mixed-batch ordinary outcomes and state writes in one pre-park append', async () => {
		const outcome = {
			v: 1,
			id: 'record_tool_outcome_assistant-1_call-ordinary',
			type: 'tool_outcome',
			conversationId: 'conversation-1',
			harness: 'default',
			session: 'default',
			timestamp: '2026-09-03T00:00:00.000Z',
			assistantMessageId: 'assistant-1',
			toolCallId: 'call-ordinary',
			toolName: 'write_state',
			isError: false,
			content: [{ type: 'text', text: 'done' }],
		} satisfies ConversationRecord;
		const stateWrite = {
			v: 1,
			id: 'record_state_write_mixed',
			type: 'state_write',
			conversationId: 'conversation-1',
			harness: 'default',
			session: 'default',
			timestamp: '2026-09-03T00:00:00.000Z',
			name: 'ordinary-finished',
			value: true,
		} satisfies ConversationRecord;
		const appendCanonical = vi.fn(async (_records: ConversationRecord[]) => {});
		const pendingToolOutcomeRecords = new Map<string, ConversationRecord>([
			['call-ordinary', outcome],
		]);
		const fakeSession = {
			appendCanonical,
			pendingToolOutcomeRecords,
			drainHookStateRecords: vi.fn(() => [stateWrite]),
		};
		const flushPendingToolOutcomes = Reflect.get(Session.prototype, 'flushPendingToolOutcomes') as (
			this: typeof fakeSession,
		) => Promise<void>;

		await flushPendingToolOutcomes.call(fakeSession);

		expect(appendCanonical).toHaveBeenCalledTimes(1);
		expect(appendCanonical).toHaveBeenCalledWith([outcome, stateWrite]);
		expect(pendingToolOutcomeRecords.size).toBe(0);
	});

	it('commits recovered outcomes, persistent state, and the batch marker atomically', async () => {
		const outcome = {
			v: 1,
			id: 'record_tool_outcome_assistant-1_call-1',
			type: 'tool_outcome',
			conversationId: 'conversation-1',
			harness: 'default',
			session: 'default',
			timestamp: '2026-09-03T00:00:00.000Z',
			assistantMessageId: 'assistant-1',
			toolCallId: 'call-1',
			toolName: 'approve_then_write',
			isError: false,
			content: [{ type: 'text', text: 'done' }],
		} satisfies ConversationRecord;
		const stateWrite = {
			v: 1,
			id: 'record_state_write_1',
			type: 'state_write',
			conversationId: 'conversation-1',
			harness: 'default',
			session: 'default',
			timestamp: '2026-09-03T00:00:00.000Z',
			name: 'approved',
			value: true,
		} satisfies ConversationRecord;
		const appendCanonical = vi.fn(async (_records: ConversationRecord[]) => {});
		const rebuildCanonicalContext = vi.fn(async () => {});
		const publishRecoveredToolOutcome = vi.fn();
		const fakeSession = {
			appendCanonical,
			canonicalEnvelope: (type: string, id: string) => ({
				v: 1 as const,
				id,
				type,
				conversationId: 'conversation-1',
				harness: 'default',
				session: 'default',
				timestamp: '2026-09-03T00:00:00.000Z',
			}),
			canonicalToolRequestMessageId: 'assistant-1',
			drainHookStateRecords: vi.fn(() => [stateWrite]),
			lastCommittedToolBatch: undefined,
			pendingToolPublications: new Map(),
			publishRecoveredToolOutcome,
			rebuildCanonicalContext,
		};
		const conversation = {
			activeLeafId: 'assistant-1',
			toolOutcomes: new Map(),
			toolOutcomeRecords: new Map(),
		} as unknown as ReducedConversationState;
		const appendRepairedToolResultBatch = Reflect.get(
			Session.prototype,
			'appendRepairedToolResultBatch',
		) as (
			this: typeof fakeSession,
			assistantEntryId: string,
			toolCalls: ReadonlyArray<{ id: string; name: string }>,
			conversation: ReducedConversationState,
			resolved: Map<string, ConversationRecord>,
		) => Promise<void>;

		await appendRepairedToolResultBatch.call(
			fakeSession,
			'assistant-1',
			[{ id: 'call-1', name: 'approve_then_write' }],
			conversation,
			new Map([['call-1', outcome]]),
		);

		expect(appendCanonical).toHaveBeenCalledTimes(1);
		expect(appendCanonical).toHaveBeenCalledWith([
			outcome,
			stateWrite,
			expect.objectContaining({
				type: 'tool_results_committed',
				assistantMessageId: 'assistant-1',
				outcomeIds: [outcome.id],
			}),
		]);
		expect(rebuildCanonicalContext).toHaveBeenCalledTimes(1);
		expect(publishRecoveredToolOutcome).toHaveBeenCalledWith('call-1', outcome);
	});
});

describe('MCP approval proposal recovery', () => {
	async function gatedMcpTool(): Promise<ToolDefinition> {
		const connection = await createMcpConnectionWithClient(
			'linear',
			{
				connect: async () => {},
				close: async () => {},
				listTools: async () => ({
					tools: [
						{
							name: 'create_issue',
							description: 'Create a Linear issue.',
							inputSchema: {
								type: 'object',
								properties: { title: { type: 'string' } },
								required: ['title'],
							},
						},
					],
				}),
				callTool: async () => ({ content: [] }),
			},
			{} as Transport,
			{},
			{ approval: { required: true } },
		);
		const [tool] = connection.tools;
		if (!tool) throw new Error('Expected one adapted MCP tool.');
		return tool;
	}

	function recreate(tool: ToolDefinition, args: Record<string, unknown>) {
		const createToolApproval = vi.fn(
			async (proposal: ToolApprovalProposal): Promise<ToolApproval> => ({
				...proposal,
				status: 'pending',
			}),
		);
		const fakeSession = {
			agentTools: [tool],
			createToolLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
			executionIdentity: { harness: 'default' },
			conversationId: 'conversation-1',
			name: 'default',
			ensureApprovalRequestedRecord: vi.fn(async () => {}),
		};
		const recreateMissingToolApproval = Reflect.get(
			Session.prototype,
			'recreateMissingToolApproval',
		) as (
			this: typeof fakeSession,
			approvalStore: { createToolApproval: typeof createToolApproval },
			submissionId: string,
			partial: { entryId: string; assistant: unknown },
			call: { id: string; name: string },
			signal: AbortSignal,
		) => Promise<ToolApproval | null>;
		const running = recreateMissingToolApproval.call(
			fakeSession,
			{ createToolApproval },
			'submission-1',
			{
				entryId: 'assistant-1',
				assistant: {
					content: [{ type: 'toolCall', id: 'call-1', name: tool.name, arguments: args }],
				},
			},
			{ id: 'call-1', name: tool.name },
			new AbortController().signal,
		);
		return { running, createToolApproval };
	}

	it('rebuilds a lost MCP proposal from the schema-validated model arguments', async () => {
		const tool = await gatedMcpTool();
		const { running, createToolApproval } = recreate(tool, { title: 'Fix login' });

		await expect(running).resolves.toMatchObject({
			toolName: 'mcp__linear__create_issue',
			toolVersion: tool.version,
			arguments: { title: 'Fix login' },
		});
		expect(createToolApproval).toHaveBeenCalledTimes(1);
	});

	it('refuses to rebuild a proposal from arguments the schema rejects', async () => {
		const tool = await gatedMcpTool();
		const { running, createToolApproval } = recreate(tool, {});

		await expect(running).rejects.toThrow(/Validation failed for tool "mcp__linear__create_issue"/);
		expect(createToolApproval).not.toHaveBeenCalled();
	});
});
