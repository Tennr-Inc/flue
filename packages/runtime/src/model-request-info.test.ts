import { describe, expect, it } from 'vitest';
import { modelContextCompactionFields } from './model-request-info.ts';

describe('model request compaction telemetry', () => {
	it('marks agent turns that use compacted context', () => {
		expect(modelContextCompactionFields('agent', true)).toEqual({ contextCompacted: true });
	});

	it('omits the field before an agent context is compacted', () => {
		expect(modelContextCompactionFields('agent', false)).toEqual({});
	});

	it.each(['compaction', 'compaction_prefix'] as const)(
		'omits the field from %s summarization turns',
		(purpose) => {
			expect(modelContextCompactionFields(purpose, true)).toEqual({});
		},
	);
});
