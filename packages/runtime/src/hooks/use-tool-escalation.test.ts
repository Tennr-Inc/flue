import { describe, expect, it } from 'vitest';
import { defineTool } from '../tool.ts';
import type { ToolEscalationGrant } from '../tool-approval.ts';
import type { AgentFunction, AgentProps } from '../types.ts';
import { renderAgentFunction, resolveSubagentDefinition } from './render.ts';
import { useMcpConnection } from './use-mcp-connection.ts';
import { useModel } from './use-model.ts';
import { useTool } from './use-tool.ts';
import { useToolEscalation } from './use-tool-escalation.ts';

const editPage = defineTool({
	name: 'edit_page',
	description: 'Edit a page.',
	version: '1',
	approval: { required: true, escalation: 'notion-edit' },
	run: () => ({ output: 'edited' }),
});

function render(agent: () => string | undefined, grants: ToolEscalationGrant[] = []) {
	return renderAgentFunction(agent as AgentFunction<AgentProps>, {
		snapshot: new Map(),
		store: undefined,
		toolEscalationGrants: new Map(grants.map((grant) => [grant.group, grant])),
	});
}

describe('useToolEscalation', () => {
	it('declares the group for the render and reads the active grant', () => {
		const grant: ToolEscalationGrant = {
			group: 'notion-edit',
			instanceId: 'instance-1',
			proposalId: 'approval_1',
			grantedAt: 1,
			actor: 'U123',
		};
		let state: ReturnType<typeof useToolEscalation> | undefined;
		const config = render(() => {
			useModel('faux/faux-1');
			state = useToolEscalation('notion-edit', {
				expiresInMs: 60_000,
				presentation: { title: 'Allow Notion edits' },
			});
			useTool(editPage);
			return state.grant ? 'Editing enabled.' : 'Ask first.';
		}, [grant]);

		expect(state).toEqual({ group: 'notion-edit', mode: 'ask', grant });
		expect(config.instructions).toBe('Editing enabled.');
		expect(config.toolEscalations?.get('notion-edit')).toEqual({
			group: 'notion-edit',
			mode: 'ask',
			expiresInMs: 60_000,
			presentation: { title: 'Allow Notion edits' },
		});
	});

	it('reports a grant that expired since it was read as absent', () => {
		let state: ReturnType<typeof useToolEscalation> | undefined;
		render(() => {
			state = useToolEscalation('notion-edit', { mode: 'granted' });
			return undefined;
		}, [
			{
				group: 'notion-edit',
				instanceId: 'instance-1',
				proposalId: 'approval_1',
				grantedAt: 1,
				expiresAt: 2,
			},
		]);
		expect(state).toEqual({ group: 'notion-edit', mode: 'granted', grant: null });
	});

	it('rejects a mounted tool whose group the render did not declare', () => {
		expect(() =>
			render(() => {
				useTool(editPage);
				return undefined;
			}),
		).toThrow(
			`[flue] Tool "edit_page" names escalation group "notion-edit", which this render did not declare. Declare it with useToolEscalation('notion-edit').`,
		);
	});

	it('rejects an MCP connection whose per-tool group the render did not declare', () => {
		const notion = {
			name: 'notion',
			url: 'https://mcp.example.test/mcp',
			approval: {
				required: true as const,
				tools: ['update-page', 'create-comment'],
				escalation: 'notion-edit',
				escalations: { 'create-comment': 'notion-comment' },
			},
		};

		expect(() =>
			render(() => {
				useToolEscalation('notion-edit');
				useMcpConnection(notion);
				return undefined;
			}),
		).toThrow(
			`[flue] MCP connection "notion" names escalation group "notion-comment", which this render did not declare. Declare it with useToolEscalation('notion-comment').`,
		);
		expect(() =>
			render(() => {
				useToolEscalation('notion-edit');
				useToolEscalation('notion-comment');
				useMcpConnection(notion);
				return undefined;
			}),
		).not.toThrow();
	});

	it('rejects duplicate declarations, bad names, and bad options', () => {
		expect(() =>
			render(() => {
				useToolEscalation('notion-edit');
				useToolEscalation('notion-edit');
				return undefined;
			}),
		).toThrow(/was called twice in one render/);
		for (const group of ['Notion', '-edit', '', 'x'.repeat(65)]) {
			expect(() =>
				render(() => {
					useToolEscalation(group);
					return undefined;
				}),
			).toThrow(/must be an escalation group name/);
		}
		const invalid = [
			[{ mode: 'always' }, /mode must be one of ask, granted, denied/],
			[{ expiresInMs: 0 }, /expiresInMs must be a positive finite number/],
			[{ ttl: 1 }, /received unknown option "ttl"/],
			[{ presentation: { title: 1 } }, /presentation.title must be a string/],
		] as const;
		for (const [options, message] of invalid) {
			expect(() =>
				render(() => {
					useToolEscalation('notion-edit', options as never);
					return undefined;
				}),
			).toThrow(message);
		}
	});

	it('is unavailable in subagent renders', () => {
		expect(() =>
			resolveSubagentDefinition({
				name: 'editor',
				description: 'Edits pages.',
				agent: () => {
					useToolEscalation('notion-edit');
					return 'Edit.';
				},
			}),
		).toThrow(/not available in a subagent render/);
	});

	it('validates the group named by a tool approval policy', () => {
		expect(() =>
			defineTool({
				name: 'edit_page',
				description: 'Edit a page.',
				version: '1',
				approval: { required: true, escalation: 'Notion Edit' },
				run: () => undefined,
			}),
		).toThrow(/approval.escalation must be an escalation group name/);
	});
});
