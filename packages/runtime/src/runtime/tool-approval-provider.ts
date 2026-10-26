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
 * mode). Best-effort: a failing hook is reported through `onError` and never
 * affects the call. The returned promise never rejects; callers need not await
 * it, but a host that can (`waitUntil`) should keep it alive.
 */
export function notifyToolApprovalDecided(
	approval: ToolApproval,
	onError: (error: unknown) => void,
): Promise<void> {
	const current = provider;
	const decided = current?.decided;
	if (!current || !decided) return Promise.resolve();
	return Promise.resolve()
		.then(() => decided.call(current, approval))
		.then(
			() => undefined,
			(error: unknown) => onError(error),
		);
}

/** Runtime-internal lookup used while constructing a session. */
export function getToolApprovalProvider(): ToolApprovalProvider | undefined {
	return provider;
}

/** Test/runtime teardown helper. */
export function resetToolApprovalProvider(): void {
	provider = undefined;
}
