import type { ToolApproval, ToolApprovalProvider } from '../tool-approval.ts';

let provider: ToolApprovalProvider | undefined;

/** Install the host adapter notified when a durable approval is requested. */
export function setToolApprovalProvider(next: ToolApprovalProvider | undefined): void {
	if (next !== undefined && (typeof next !== 'object' || typeof next.requested !== 'function')) {
		throw new Error('[flue] setToolApprovalProvider() requires an adapter with requested().');
	}
	if (next?.decided !== undefined && typeof next.decided !== 'function') {
		throw new Error('[flue] setToolApprovalProvider() adapter decided must be a function.');
	}
	provider = next;
}

/**
 * Tell the provider about a decision Flue made itself (an escalation grant or
 * mode). Best-effort and never awaited: a failing hook is reported through
 * `onError` and does not affect the call.
 */
export function notifyToolApprovalDecided(
	approval: ToolApproval,
	onError: (error: unknown) => void,
): void {
	const current = provider;
	const decided = current?.decided;
	if (!current || !decided) return;
	void Promise.resolve()
		.then(() => decided.call(current, approval))
		.catch(onError);
}

/** Runtime-internal lookup used while constructing a session. */
export function getToolApprovalProvider(): ToolApprovalProvider | undefined {
	return provider;
}

/** Test/runtime teardown helper. */
export function resetToolApprovalProvider(): void {
	provider = undefined;
}
