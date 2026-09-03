import type { JsonValue } from './json-snapshot.ts';

/** Bounds proposal keys persisted in Durable Object SQLite and carried over internal requests. */
export const MAX_TOOL_APPROVAL_PROPOSAL_ID_LENGTH = 512;

/** The states a persisted approval request may occupy. */
export type ToolApprovalStatus =
	'pending' | 'approved' | 'rejected' | 'expired' | 'canceled' | 'aborted';

export type ToolApprovalDecisionStatus = Exclude<ToolApprovalStatus, 'pending'>;

/** Optional presentation hints for an approval UI. They never affect execution. */
export interface ToolApprovalPresentation {
	readonly title?: string;
	readonly description?: string;
}

/** Definition-level policy for a tool that must be approved before execution. */
export interface ToolApprovalPolicy {
	readonly required: true;
	readonly expiresInMs?: number;
	readonly presentation?: ToolApprovalPresentation;
}

/** The immutable, validated proposal exposed to a host approval adapter. */
export interface ToolApprovalProposal {
	readonly proposalId: string;
	readonly submissionId: string;
	readonly agentName?: string;
	readonly instanceId: string;
	readonly conversationId: string;
	readonly harness: string;
	readonly session: string;
	readonly assistantMessageId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly toolVersion: string;
	/** Tool schemas are required to have a top-level object, so proposals do too. */
	readonly arguments: Record<string, JsonValue>;
	readonly requestedAt: number;
	readonly expiresAt?: number;
	readonly presentation?: ToolApprovalPresentation;
}

/** A durable approval row, including the exact proposal being decided. */
export interface ToolApproval extends ToolApprovalProposal {
	readonly status: ToolApprovalStatus;
	readonly decidedAt?: number;
	readonly reason?: string;
}

/** A host decision delivered through the runtime's safe decision seam. */
export interface ToolApprovalDecision {
	readonly proposalId: string;
	readonly status: ToolApprovalDecisionStatus;
	readonly reason?: string;
}

/** Host integration for notifications. Decisions use `resolveToolApproval`. */
export interface ToolApprovalProvider {
	requested(proposal: ToolApprovalProposal): void | Promise<void>;
}

export function toolApprovalProposalId(
	submissionId: string,
	assistantMessageId: string,
	toolCallId: string,
): string {
	const proposalId = `approval_${encodeStablePart(submissionId)}_${encodeStablePart(assistantMessageId)}_${encodeStablePart(toolCallId)}`;
	if (proposalId.length > MAX_TOOL_APPROVAL_PROPOSAL_ID_LENGTH) {
		throw new Error(
			`[flue] Tool approval proposal identity exceeds ${MAX_TOOL_APPROVAL_PROPOSAL_ID_LENGTH} characters. Shorten the submission, message, or tool-call identifier.`,
		);
	}
	return proposalId;
}

function encodeStablePart(value: string): string {
	// encodeURIComponent leaves `_` untouched; encode it after URI encoding so
	// the underscore separators cannot collide with a character in a component.
	return encodeURIComponent(value).replaceAll('_', '%5F');
}
