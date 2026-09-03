import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { describe, expect, it } from 'vitest';
import { type CanonicalSubmissionEntry, classifySubmissionState } from './submission-state.ts';

function terminalBatch(): CanonicalSubmissionEntry[] {
	return [
		{
			id: 'assistant-1',
			type: 'message',
			message: fauxAssistantMessage(
				[
					fauxToolCall('action', {}, { id: 'call-1' }),
					fauxToolCall('action', {}, { id: 'call-2' }),
				],
				{ stopReason: 'toolUse' },
			),
		},
		...[1, 2].map((index): CanonicalSubmissionEntry => ({
			id: `result-${index}`,
			type: 'message',
			toolTerminate: true,
			message: {
				role: 'toolResult',
				toolCallId: `call-${index}`,
				toolName: 'action',
				content: [{ type: 'text', text: 'done' }],
				isError: false,
				timestamp: 1,
			},
		})),
	];
}

function signal(type: string): CanonicalSubmissionEntry {
	return {
		id: `signal-${type}`,
		type: 'message',
		message: { role: 'signal', type, content: 'Updated.', timestamp: 2 },
	};
}

const options = { contextWindow: 0, ownSubmissionId: 'submission-1' };

describe('terminal tool batch recovery', () => {
	it('preserves termination across persisted render narration', () => {
		const history = [
			...terminalBatch(),
			signal('instructions'),
			signal('resources'),
			signal('environment'),
		];
		expect(classifySubmissionState(history, options)).toMatchObject({
			kind: 'completed',
			terminalToolBatch: true,
		});
	});

	it.each(['follow_up', 'stream_interrupted', 'stream_continued'])(
		'continues for a %s signal even when followed by render narration',
		(type) => {
			const history = [...terminalBatch(), signal(type), signal('resources')];
			expect(classifySubmissionState(history, options)).toMatchObject({
				kind: 'resume',
				mode: 'tool_results',
			});
		},
	);

	it('continues for a joined user message after a terminal batch', () => {
		const history: CanonicalSubmissionEntry[] = [
			...terminalBatch(),
			{
				id: 'joined-input',
				type: 'message',
				submissionId: 'joined-1',
				message: { role: 'user', content: 'One more action.', timestamp: 2 },
			},
			signal('instructions'),
		];
		expect(classifySubmissionState(history, options)).toMatchObject({
			kind: 'resume',
			mode: 'tool_results',
		});
	});

	it('requires every result to terminate before ignoring render narration', () => {
		const history = terminalBatch().map((entry) =>
			entry.type === 'message' && entry.id === 'result-2'
				? { ...entry, toolTerminate: false }
				: entry,
		);
		expect(classifySubmissionState([...history, signal('resources')], options)).toMatchObject({
			kind: 'resume',
			mode: 'tool_results',
		});
	});

	it('does not treat narration as a missing tool result', () => {
		const history = [...terminalBatch().slice(0, 2), signal('resources')];
		expect(classifySubmissionState(history, options).kind).not.toBe('completed');
	});
});
