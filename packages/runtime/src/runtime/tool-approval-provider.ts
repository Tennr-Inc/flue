import type { ToolApprovalProvider } from '../tool-approval.ts';

let provider: ToolApprovalProvider | undefined;

/** Install the host adapter notified when a durable approval is requested. */
export function setToolApprovalProvider(next: ToolApprovalProvider | undefined): void {
	if (next !== undefined && (typeof next !== 'object' || typeof next.requested !== 'function')) {
		throw new Error('[flue] setToolApprovalProvider() requires an adapter with requested().');
	}
	provider = next;
}

/** Runtime-internal lookup used while constructing a session. */
export function getToolApprovalProvider(): ToolApprovalProvider | undefined {
	return provider;
}

/** Test/runtime teardown helper. */
export function resetToolApprovalProvider(): void {
	provider = undefined;
}
