import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApproval, ToolEscalationGrant } from '../tool-approval.ts';
import type { CloudflareRuntime, ToolApprovalResolutionInput } from './flue-app.ts';
import { configureFlueRuntime, resetFlueRuntimeForTests } from './flue-app.ts';
import { createAgentRouter } from './registration.ts';

const approvalRow: ToolApproval = {
	proposalId: 'approval_1',
	submissionId: 'submission_1',
	agentName: 'ApprovalAgent',
	instanceId: 'conversation-1',
	conversationId: 'conversation-1',
	harness: 'default',
	session: 'default',
	assistantMessageId: 'assistant-1',
	toolCallId: 'tool-call-1',
	toolName: 'refund_order',
	toolVersion: 'refund-v1',
	arguments: { orderId: 'order-1', amount: 42 },
	requestedAt: 1_000,
	status: 'pending',
};

function ApprovalAgent() {
	return 'Review the requested action.';
}

function createTestApp(): Hono {
	const app = new Hono();
	app.use('/agents/ApprovalAgent/*', async (c, next) => {
		if (c.req.header('authorization') !== 'Bearer test-token') {
			return c.json({ error: 'unauthorized' }, 401);
		}
		return next();
	});
	app.route('/agents/ApprovalAgent', createAgentRouter(ApprovalAgent));
	return app;
}

function createRuntime(
	resolveToolApproval: CloudflareRuntime['resolveToolApproval'],
	escalations: Partial<
		Pick<CloudflareRuntime, 'listToolEscalations' | 'revokeToolEscalation'>
	> = {},
): CloudflareRuntime {
	return {
		target: 'cloudflare',
		dispatchQueue: {
			enqueue: async () => ({
				submissionId: 'unused',
				acceptedAt: new Date(0).toISOString(),
				uid: 'unused',
			}),
		},
		routeAgentRequest: async () => null,
		instanceInfo: async () => null,
		resolveToolApproval,
		listToolEscalations: escalations.listToolEscalations ?? (async () => []),
		revokeToolEscalation: escalations.revokeToolEscalation ?? (async () => ({ revoked: false })),
	};
}

function escalationRequest(method: string, path = '', body?: unknown): Request {
	return new Request(
		`https://example.test/agents/ApprovalAgent/conversation-1/tool-escalations${path}`,
		{
			method,
			headers: {
				authorization: 'Bearer test-token',
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		},
	);
}

function approvalRequest(method: string, body?: unknown): Request {
	return new Request(
		'https://example.test/agents/ApprovalAgent/conversation-1/tool-approvals/approval_1',
		{
			method,
			headers: {
				authorization: 'Bearer test-token',
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		},
	);
}

afterEach(() => {
	resetFlueRuntimeForTests();
});

describe('createAgentRouter tool approval route', () => {
	it('uses the mounted route and host middleware to resolve a durable approval', async () => {
		const resolveToolApproval = vi.fn(async (input: ToolApprovalResolutionInput) => ({
			...approvalRow,
			status: input.status,
			decidedAt: 2_000,
			...(input.reason === undefined ? {} : { reason: input.reason }),
		}));
		configureFlueRuntime(createRuntime(resolveToolApproval));
		const app = createTestApp();

		const response = await app.fetch(
			approvalRequest('POST', { status: 'approved', reason: 'Operator confirmed the refund.' }),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			proposalId: approvalRow.proposalId,
			submissionId: approvalRow.submissionId,
			assistantMessageId: approvalRow.assistantMessageId,
			toolCallId: approvalRow.toolCallId,
			toolName: approvalRow.toolName,
			toolVersion: approvalRow.toolVersion,
			arguments: approvalRow.arguments,
			requestedAt: approvalRow.requestedAt,
			status: 'approved',
			decidedAt: 2_000,
			reason: 'Operator confirmed the refund.',
		});
		expect(resolveToolApproval).toHaveBeenCalledOnce();
		expect(resolveToolApproval).toHaveBeenCalledWith({
			agent: 'ApprovalAgent',
			id: 'conversation-1',
			proposalId: 'approval_1',
			status: 'approved',
			reason: 'Operator confirmed the refund.',
		});
	});

	it('decodes the proposal id from the mounted URL segment', async () => {
		const resolveToolApproval = vi.fn(async () => approvalRow);
		configureFlueRuntime(createRuntime(resolveToolApproval));
		const app = createTestApp();
		const request = new Request(
			'https://example.test/agents/ApprovalAgent/conversation-1/tool-approvals/approval%252Fcall%253F1',
			{
				method: 'POST',
				headers: {
					authorization: 'Bearer test-token',
					'content-type': 'application/json',
				},
				body: JSON.stringify({ status: 'approved' }),
			},
		);

		const response = await app.fetch(request);

		expect(response.status).toBe(200);
		expect(resolveToolApproval).toHaveBeenCalledWith(
			expect.objectContaining({ proposalId: 'approval%2Fcall%3F1' }),
		);
	});

	it('lets host middleware protect the native route', async () => {
		const resolveToolApproval = vi.fn(async () => approvalRow);
		configureFlueRuntime(createRuntime(resolveToolApproval));
		const app = createTestApp();
		const request = new Request(
			'https://example.test/agents/ApprovalAgent/conversation-1/tool-approvals/approval_1',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ status: 'approved' }),
			},
		);

		const response = await app.fetch(request);

		expect(response.status).toBe(401);
		expect(resolveToolApproval).not.toHaveBeenCalled();
	});

	it('returns 405 for unsupported methods', async () => {
		const resolveToolApproval = vi.fn(async () => approvalRow);
		configureFlueRuntime(createRuntime(resolveToolApproval));
		const app = createTestApp();

		const response = await app.fetch(approvalRequest('PUT', { status: 'approved' }));

		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('POST');
		expect(resolveToolApproval).not.toHaveBeenCalled();
	});

	it('returns 400 for an invalid decision body', async () => {
		const resolveToolApproval = vi.fn(async () => approvalRow);
		configureFlueRuntime(createRuntime(resolveToolApproval));
		const app = createTestApp();

		const response = await app.fetch(approvalRequest('POST', { status: 'pending' }));

		expect(response.status).toBe(400);
		expect(resolveToolApproval).not.toHaveBeenCalled();
	});
});

describe('createAgentRouter tool escalation routes', () => {
	const grant: ToolEscalationGrant = {
		group: 'notion-edit',
		instanceId: 'conversation-1',
		proposalId: 'approval_1',
		grantedAt: 2_000,
		actor: 'U123',
	};

	it('forwards the escalation choice and actor with a decision', async () => {
		const resolveToolApproval = vi.fn(async (input: ToolApprovalResolutionInput) => ({
			...approvalRow,
			escalation: { group: 'notion-edit' },
			status: input.status,
			decidedAt: 2_000,
			decidedVia: { kind: 'host' as const, actor: 'U123' },
		}));
		configureFlueRuntime(createRuntime(resolveToolApproval));

		const response = await createTestApp().fetch(
			approvalRequest('POST', { status: 'approved', escalate: false, actor: 'U123' }),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			escalation: { group: 'notion-edit' },
			decidedVia: { kind: 'host', actor: 'U123' },
		});
		expect(resolveToolApproval).toHaveBeenCalledWith({
			agent: 'ApprovalAgent',
			id: 'conversation-1',
			proposalId: 'approval_1',
			status: 'approved',
			escalate: false,
			actor: 'U123',
		});
	});

	it('rejects a malformed escalation flag or actor', async () => {
		const resolveToolApproval = vi.fn(async () => approvalRow);
		configureFlueRuntime(createRuntime(resolveToolApproval));
		const app = createTestApp();

		for (const body of [
			{ status: 'approved', escalate: 'yes' },
			{ status: 'approved', actor: 7 },
		]) {
			expect((await app.fetch(approvalRequest('POST', body))).status).toBe(400);
		}
		expect(resolveToolApproval).not.toHaveBeenCalled();
	});

	it('lists active grants behind host middleware', async () => {
		const listToolEscalations = vi.fn(async () => [grant]);
		configureFlueRuntime(createRuntime(vi.fn(), { listToolEscalations }));
		const app = createTestApp();

		const response = await app.fetch(escalationRequest('GET'));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ grants: [grant] });
		expect(listToolEscalations).toHaveBeenCalledWith({
			agent: 'ApprovalAgent',
			id: 'conversation-1',
		});

		const unauthorized = await app.fetch(
			new Request('https://example.test/agents/ApprovalAgent/conversation-1/tool-escalations'),
		);
		expect(unauthorized.status).toBe(401);
		expect((await app.fetch(escalationRequest('POST'))).status).toBe(405);
	});

	it('revokes a group with an optional actor and reason', async () => {
		const revokeToolEscalation = vi.fn(async () => ({ revoked: true }));
		configureFlueRuntime(createRuntime(vi.fn(), { revokeToolEscalation }));
		const app = createTestApp();

		const withBody = await app.fetch(
			escalationRequest('DELETE', '/notion-edit', { actor: 'U999', reason: 'done editing' }),
		);
		expect(withBody.status).toBe(200);
		expect(await withBody.json()).toEqual({ revoked: true });
		const bare = await app.fetch(escalationRequest('DELETE', '/notion-edit'));
		expect(bare.status).toBe(200);
		expect(revokeToolEscalation.mock.calls).toEqual([
			[
				{
					agent: 'ApprovalAgent',
					id: 'conversation-1',
					group: 'notion-edit',
					actor: 'U999',
					reason: 'done editing',
				},
			],
			[{ agent: 'ApprovalAgent', id: 'conversation-1', group: 'notion-edit' }],
		]);
	});

	it('rejects an invalid group or method before reaching the agent', async () => {
		const revokeToolEscalation = vi.fn(async () => ({ revoked: true }));
		configureFlueRuntime(createRuntime(vi.fn(), { revokeToolEscalation }));
		const app = createTestApp();

		expect((await app.fetch(escalationRequest('DELETE', '/Notion%20Edit'))).status).toBe(400);
		const wrongMethod = await app.fetch(escalationRequest('POST', '/notion-edit'));
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get('allow')).toBe('DELETE');
		expect(revokeToolEscalation).not.toHaveBeenCalled();
	});
});
