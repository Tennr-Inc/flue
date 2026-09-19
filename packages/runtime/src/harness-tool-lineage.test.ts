import { describe, expect, it } from 'vitest';
import { EMPTY_HARNESS_TOOL_LINEAGE, enterHarnessTool } from './harness-tool-lineage.ts';
import type { ToolDefinition } from './types.ts';

function harnessTool(name: string): ToolDefinition {
	return { name } as ToolDefinition;
}

describe('harness tool lineage', () => {
	it('rejects direct and indirect recursive entry', () => {
		const phaseA = harnessTool('phase_a');
		const phaseB = harnessTool('phase_b');
		const insideA = enterHarnessTool(EMPTY_HARNESS_TOOL_LINEAGE, phaseA);
		const insideB = enterHarnessTool(insideA, phaseB);

		expect(() => enterHarnessTool(insideA, phaseA)).toThrow(
			'Harness tool "phase_a" cannot be invoked recursively while it is already active',
		);
		expect(() => enterHarnessTool(insideB, phaseA)).toThrow(
			'Harness tool "phase_a" cannot be invoked recursively while it is already active',
		);
	});

	it('keeps sibling branches independent', () => {
		const phase = harnessTool('phase');

		expect(() => enterHarnessTool(EMPTY_HARNESS_TOOL_LINEAGE, phase)).not.toThrow();
		expect(() => enterHarnessTool(EMPTY_HARNESS_TOOL_LINEAGE, phase)).not.toThrow();
	});

	it('allows unrelated definitions with the same public name', () => {
		const parentPhase = harnessTool('phase');
		const childPhase = harnessTool('phase');
		const lineage = enterHarnessTool(EMPTY_HARNESS_TOOL_LINEAGE, parentPhase);

		expect(() => enterHarnessTool(lineage, childPhase)).not.toThrow();
	});
});
