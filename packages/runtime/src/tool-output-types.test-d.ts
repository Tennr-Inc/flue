import * as v from 'valibot';
import { useTool } from './hooks/use-tool.ts';
import { defineTool } from './tool.ts';
import type { ToolRunEnvelope } from './tool-types.ts';

declare const alreadyDone: boolean;
declare const factCount: number;
declare const summaryCount: number;

useTool({
	name: 'inline_union_output',
	description: 'Return one of two valid JSON object shapes.',
	input: v.object({ value: v.string() }),
	async run({ data }) {
		void data;
		if (alreadyDone) {
			return { output: { committed: false, alreadyCommitted: true } };
		}
		return { output: { committed: true, factCount, summaryCount } };
	},
});

defineTool({
	name: 'defined_union_output',
	description: 'Return one of two valid JSON object shapes.',
	async run() {
		if (alreadyDone) {
			return { output: { committed: false, alreadyCommitted: true } };
		}
		return { output: { committed: true, factCount, summaryCount } };
	},
});

const optionalObjectProperty: ToolRunEnvelope<undefined> = {
	output: { included: true, omitted: undefined },
};
void optionalObjectProperty;

const readonlyArray: ToolRunEnvelope<undefined> = { output: ['one', 'two'] as const };
void readonlyArray;

const explicitUndefined: ToolRunEnvelope<undefined> = { output: undefined };
void explicitUndefined;

// Undefined array elements do not have a JSON representation and remain invalid.
const undefinedArrayElement: ToolRunEnvelope<undefined> = {
	// @ts-expect-error -- object properties may be omitted, array elements may not
	output: ['included', undefined],
};
void undefinedArrayElement;
