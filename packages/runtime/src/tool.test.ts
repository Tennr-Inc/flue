import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { createParsedToolContext, defineTool, parseToolInput } from './tool.ts';
import { MAX_TOOL_APPROVAL_PROPOSAL_ID_LENGTH, toolApprovalProposalId } from './tool-approval.ts';

describe('durable tool input recovery', () => {
	it('does not run a transformed approval argument through the schema twice', () => {
		const tool = defineTool({
			name: 'append_marker',
			description: 'Marks the input once.',
			input: v.object({
				value: v.pipe(
					v.string(),
					v.transform((value) => `${value}!`),
				),
			}),
			run: async () => {},
		});

		const initial = parseToolInput(tool, { value: 'once' });
		expect(initial.data).toEqual({ value: 'once!' });

		const recovered = createParsedToolContext(tool, initial.data);
		expect(recovered.data).toEqual({ value: 'once!' });
	});
});

describe('tool approval proposal identities', () => {
	it('rejects an identity that is too large for durable approval storage', () => {
		expect(() =>
			toolApprovalProposalId(
				'submission',
				'message',
				'x'.repeat(MAX_TOOL_APPROVAL_PROPOSAL_ID_LENGTH),
			),
		).toThrow('proposal identity exceeds');
	});
});
