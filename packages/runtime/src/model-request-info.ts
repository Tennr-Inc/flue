import type { LlmTurnPurpose, ModelRequestInfo } from './types.ts';

/**
 * Telemetry fields describing whether a request uses a compacted conversation
 * view. Compaction is persistent context state, but only ordinary agent turns
 * carry the semantic-convention attribute; summarization calls do not.
 */
export function modelContextCompactionFields(
	purpose: LlmTurnPurpose,
	contextCompacted: boolean,
): Pick<ModelRequestInfo, 'contextCompacted'> {
	return purpose === 'agent' && contextCompacted ? { contextCompacted: true } : {};
}
