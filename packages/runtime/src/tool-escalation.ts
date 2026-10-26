import type {
	ToolApprovalPresentation,
	ToolEscalationGrant,
	ToolEscalationMode,
} from './tool-approval.ts';
import type { ToolDefinition } from './tool-types.ts';

/** A grant as the execution store keeps it, including its revocation. */
export interface StoredToolEscalationGrant extends ToolEscalationGrant {
	readonly revokedAt?: number;
	readonly revokedBy?: string;
	readonly revokeReason?: string;
}

/** One render's `useToolEscalation()` declaration, frozen. */
export interface ToolEscalationDeclaration {
	readonly group: string;
	readonly mode: ToolEscalationMode;
	readonly expiresInMs?: number;
	readonly presentation?: ToolApprovalPresentation;
}

/**
 * Session-facing escalation wiring for one root harness: the initial
 * render's declarations, and the refresh the session runs before each
 * re-render so `useToolEscalation()` reads current grants.
 */
export interface SessionToolEscalationRuntime {
	readonly initial: ReadonlyMap<string, ToolEscalationDeclaration>;
	refreshGrants(): Promise<void>;
}

/**
 * Every mounted approval-gated tool that names an escalation group must find
 * that group declared by the same render, so a typo fails at mount instead of
 * silently asking for approval forever.
 */
export function assertToolEscalationsDeclared(
	tools: readonly ToolDefinition[],
	declarations: ReadonlyMap<string, ToolEscalationDeclaration>,
): void {
	for (const tool of tools) {
		const group = tool.approval?.escalation;
		if (group === undefined || declarations.has(group)) continue;
		throw new Error(
			`[flue] Tool "${tool.name}" names escalation group "${group}", which this render did not declare. Declare it with useToolEscalation('${group}').`,
		);
	}
}

/** Index active grants by group, keeping the most recent per group. */
export function indexToolEscalationGrants(
	grants: readonly ToolEscalationGrant[],
): ReadonlyMap<string, ToolEscalationGrant> {
	const byGroup = new Map<string, ToolEscalationGrant>();
	for (const grant of grants) {
		const current = byGroup.get(grant.group);
		if (!current || current.grantedAt < grant.grantedAt) byGroup.set(grant.group, grant);
	}
	return byGroup;
}
