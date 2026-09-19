import type { ToolDefinition } from './types.ts';

export type HarnessToolLineage = ReadonlySet<ToolDefinition>;

export const EMPTY_HARNESS_TOOL_LINEAGE: HarnessToolLineage = new Set();

/**
 * Enter one harness-tool invocation on this delegation branch. Tool definition
 * identity distinguishes the same tool inherited by a child harness from an
 * unrelated tool with the same public name. Returning a fresh set keeps
 * parallel sibling calls independent.
 */
export function enterHarnessTool(
	lineage: HarnessToolLineage,
	tool: ToolDefinition,
): HarnessToolLineage {
	if (lineage.has(tool)) {
		throw new Error(
			`[flue] Harness tool "${tool.name}" cannot be invoked recursively while it is already active.`,
		);
	}
	return new Set([...lineage, tool]);
}
