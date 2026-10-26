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
	/**
	 * Escalation group for this tool. Approving one call in the group can
	 * approve later calls in it for the rest of the agent instance's life.
	 * The render that mounts the tool must declare the group with
	 * `useToolEscalation()`.
	 */
	readonly escalation?: string;
}

/**
 * How a render treats an escalation group's approval-gated calls:
 *
 * - `ask` (default): calls need approval until a host approval grants the group.
 * - `granted`: calls run without asking anyone.
 * - `denied`: calls are rejected without asking anyone.
 */
export type ToolEscalationMode = 'ask' | 'granted' | 'denied';

/** Options for one `useToolEscalation()` declaration. */
export interface ToolEscalationOptions {
	/** Defaults to `'ask'`. */
	readonly mode?: ToolEscalationMode;
	/**
	 * How long a grant lasts, measured from the approval that creates it.
	 * Omit to keep a grant for the agent instance's life (until revoked).
	 */
	readonly expiresInMs?: number;
	/** UI hints the host can show on an approval that would escalate the group. */
	readonly presentation?: ToolApprovalPresentation;
}

/** An active escalation: later calls in the group are approved by Flue. */
export interface ToolEscalationGrant {
	readonly group: string;
	readonly instanceId: string;
	/** The approval whose decision created the grant. */
	readonly proposalId: string;
	readonly grantedAt: number;
	readonly expiresAt?: number;
	/** Opaque host principal recorded with the approval, e.g. a Slack user id. */
	readonly actor?: string;
}

/** Render-time snapshot of one escalation group, returned by `useToolEscalation()`. */
export interface ToolEscalationState {
	readonly group: string;
	readonly mode: ToolEscalationMode;
	/** The active (unexpired, unrevoked) grant, if any. */
	readonly grant: ToolEscalationGrant | null;
}

/** Escalation details frozen into a grouped proposal. */
export interface ToolApprovalEscalation {
	readonly group: string;
	/**
	 * The mode of the render that produced the call. Flue decides `granted` and
	 * `denied` calls itself, so a proposal waiting for a host was made under
	 * `ask`. A grant never approves a call made under `denied`.
	 */
	readonly mode: ToolEscalationMode;
	/** Lifetime a grant created by approving this proposal would get. */
	readonly expiresInMs?: number;
	readonly presentation?: ToolApprovalPresentation;
}

/** Who decided an approval. Absent for decisions the runtime makes on interruption (abort, expiry, failure). */
export type ToolApprovalDecidedVia =
	| { readonly kind: 'host'; readonly actor?: string }
	| { readonly kind: 'escalation'; readonly grantProposalId: string; readonly actor?: string }
	| { readonly kind: 'mode'; readonly mode: 'granted' | 'denied' };

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
	/**
	 * Present when the tool belongs to an escalation group. Approving this
	 * proposal grants the group unless the host passes `escalate: false`.
	 */
	readonly escalation?: ToolApprovalEscalation;
}

/** A durable approval row, including the exact proposal being decided. */
export interface ToolApproval extends ToolApprovalProposal {
	readonly status: ToolApprovalStatus;
	readonly decidedAt?: number;
	readonly reason?: string;
	readonly decidedVia?: ToolApprovalDecidedVia;
}

/** A host decision delivered through the runtime's safe decision seam. */
export interface ToolApprovalDecision {
	readonly proposalId: string;
	readonly status: ToolApprovalDecisionStatus;
	readonly reason?: string;
	/**
	 * For an approval of a grouped proposal: `true` (default) grants the group,
	 * `false` approves only this call. Ignored otherwise.
	 */
	readonly escalate?: boolean;
	/** Opaque host principal recorded on the decision and on any grant it creates. */
	readonly actor?: string;
}

/** Host integration for notifications. Decisions use `resolveToolApproval`. */
export interface ToolApprovalProvider {
	/** A proposal needs a decision. */
	requested(proposal: ToolApprovalProposal): void | Promise<void>;
	/**
	 * Optional: Flue approved or rejected a call itself, through an active
	 * escalation grant or the render's escalation mode. Delivered best-effort
	 * for audit and UI; never asked to decide. The canonical conversation
	 * stream holds the durable record.
	 */
	decided?(approval: ToolApproval): void | Promise<void>;
}

/** Bounds the opaque host principal recorded on decisions, grants, and every record that copies it. */
export const MAX_TOOL_APPROVAL_ACTOR_LENGTH = 256;

export function assertToolApprovalActor(value: unknown, label: string): void {
	if (
		value !== undefined &&
		(typeof value !== 'string' || value.length > MAX_TOOL_APPROVAL_ACTOR_LENGTH)
	) {
		throw new Error(
			`[flue] ${label} must be a string of at most ${MAX_TOOL_APPROVAL_ACTOR_LENGTH} characters.`,
		);
	}
}

/** Escalation group names: lowercase letters, digits, `_` and `-`, at most 64 characters. */
export const TOOL_ESCALATION_GROUP_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertToolEscalationGroup(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || !TOOL_ESCALATION_GROUP_PATTERN.test(value)) {
		throw new Error(
			`[flue] ${label} must be an escalation group name matching ${TOOL_ESCALATION_GROUP_PATTERN} (lowercase letters, digits, "_" and "-", at most 64 characters).`,
		);
	}
}

/** Whether a grant still covers a call requested at `requestedAt`. Revocation is the store's concern. */
export function toolEscalationGrantCovers(
	grant: ToolEscalationGrant,
	requestedAt: number,
): boolean {
	return grant.expiresAt === undefined || grant.expiresAt > requestedAt;
}

/** The model-facing reason for a call rejected by a `denied` escalation mode. */
export function toolEscalationDeniedReason(group: string): string {
	return `Tool calls in escalation group "${group}" are denied in this context; the tool was not executed.`;
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
