import {
	assertToolEscalationGroup,
	type ToolEscalationMode,
	type ToolEscalationOptions,
	type ToolEscalationState,
	toolEscalationGrantCovers,
} from '../tool-approval.ts';
import type { ToolEscalationDeclaration } from '../tool-escalation.ts';
import { requireRenderFrame } from './frame.ts';

const OPTION_KEYS = new Set(['mode', 'expiresInMs', 'presentation']);
const PRESENTATION_KEYS = new Set(['title', 'description']);
const MODES: readonly ToolEscalationMode[] = ['ask', 'granted', 'denied'];

/**
 * Declare an escalation group for this render and read its state.
 *
 * Tools join a group through their approval policy —
 * `defineTool({ approval: { required: true, escalation: 'notion-edit' } })`,
 * or `approval.escalation` on an MCP connection. The first call in a group
 * asks for approval as usual; a host approval (unless it passes
 * `escalate: false`) grants the group to the agent instance, and later calls
 * in the group run without asking. Tools stay mounted throughout: only the
 * approval requirement changes, so the model's tool list never does.
 *
 * `mode` is read from the render that produced each call:
 *
 * - `ask` (default): ask until a grant exists.
 * - `granted`: approve every call without asking.
 * - `denied`: reject every call without asking.
 *
 * A new mode applies to calls made after it; pending approvals keep their
 * state. The returned state is a render-time snapshot, like
 * `usePersistentState` — use it to adjust instructions:
 *
 * ```ts
 * const notion = useToolEscalation('notion-edit', { expiresInMs: 2 * 60 * 60_000 });
 * useInstruction(notion.grant ? 'Notion editing is enabled.' : 'Ask before editing Notion.');
 * ```
 *
 * Every mounted tool naming a group must find it declared in the same
 * render; declaring a group twice throws, and subagent renders cannot
 * declare groups (approval-gated tools are root-only).
 */
export function useToolEscalation(
	group: string,
	options: ToolEscalationOptions = {},
): ToolEscalationState {
	const frame = requireRenderFrame('useToolEscalation');
	if (frame.kind === 'subagent') {
		throw new Error(
			'[flue] useToolEscalation() is not available in a subagent render. Approval-gated tools, and their escalation groups, belong to the root agent.',
		);
	}
	assertToolEscalationGroup(group, 'useToolEscalation() group');
	const declaration = parseOptions(group, options);
	if (frame.toolEscalations.has(group)) {
		throw new Error(
			`[flue] useToolEscalation('${group}') was called twice in one render. Declare each escalation group once.`,
		);
	}
	frame.toolEscalations.set(group, declaration);
	const grant = frame.state?.toolEscalationGrants?.get(group);
	return Object.freeze({
		group,
		mode: declaration.mode,
		grant: grant && toolEscalationGrantCovers(grant, Date.now()) ? grant : null,
	});
}

function parseOptions(group: string, options: unknown): ToolEscalationDeclaration {
	const label = `useToolEscalation('${group}')`;
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new Error(`[flue] ${label} options must be an object.`);
	}
	for (const key of Object.keys(options)) {
		if (!OPTION_KEYS.has(key)) {
			throw new Error(
				`[flue] ${label} received unknown option "${key}". Accepted options: ${[...OPTION_KEYS].join(', ')}.`,
			);
		}
	}
	const { mode = 'ask', expiresInMs, presentation } = options as ToolEscalationOptions;
	if (!MODES.includes(mode)) {
		throw new Error(`[flue] ${label} mode must be one of ${MODES.join(', ')}.`);
	}
	if (
		expiresInMs !== undefined &&
		(typeof expiresInMs !== 'number' || !Number.isFinite(expiresInMs) || expiresInMs <= 0)
	) {
		throw new Error(`[flue] ${label} expiresInMs must be a positive finite number.`);
	}
	if (presentation !== undefined) {
		if (typeof presentation !== 'object' || presentation === null || Array.isArray(presentation)) {
			throw new Error(`[flue] ${label} presentation must be an object.`);
		}
		for (const key of Object.keys(presentation)) {
			if (!PRESENTATION_KEYS.has(key)) {
				throw new Error(
					`[flue] ${label} presentation received unknown field "${key}". Accepted fields: ${[...PRESENTATION_KEYS].join(', ')}.`,
				);
			}
		}
		for (const key of PRESENTATION_KEYS) {
			const value = (presentation as Record<string, unknown>)[key];
			if (value !== undefined && typeof value !== 'string') {
				throw new Error(`[flue] ${label} presentation.${key} must be a string.`);
			}
		}
	}
	return Object.freeze({
		group,
		mode,
		...(expiresInMs !== undefined ? { expiresInMs } : {}),
		...(presentation !== undefined ? { presentation: Object.freeze({ ...presentation }) } : {}),
	});
}
