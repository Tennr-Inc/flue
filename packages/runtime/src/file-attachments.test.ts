import type { Context } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { toPublicAttachment } from './document-attachments.ts';
import { init, useAgentStart, useDelivery, useModel, useSubagent } from './index.ts';
import { sqlite, start } from './node/index.ts';
import { assertImagesWithinLimit, MAX_IMAGE_DATA_LENGTH } from './persisted-images.ts';
import { parseDeliveredMessage } from './runtime/schemas.ts';
import type { DeliveredAttachment, DeliveredMessage } from './types.ts';

const CSV = btoa('id,total\n1,42\n');
const PNG = 'iVBORw0KGgo=';
const PDF = 'JVBERi0xLjQK';

function rejectionOf(value: unknown): unknown {
	try {
		parseDeliveredMessage(value);
	} catch (error) {
		return error;
	}
	throw new Error('expected the message to be rejected');
}

describe('file attachment shapes', () => {
	it('accepts every file MIME type on the wire', () => {
		const attachments = [
			'text/plain',
			'text/csv',
			'application/json',
			'application/x-ndjson',
			'application/har+json',
		].map((mimeType) => ({ type: 'file', data: CSV, mimeType }));

		expect(
			parseDeliveredMessage({
				kind: 'user',
				body: 'hi',
				attachments: [...attachments, { ...attachments[1], filename: 'report.csv' }],
			}),
		).toEqual({
			kind: 'user',
			body: 'hi',
			attachments: [...attachments, { ...attachments[1], filename: 'report.csv' }],
		});
	});

	it('rejects an unsupported file MIME type', () => {
		expect(
			rejectionOf({
				kind: 'user',
				body: 'hi',
				attachments: [{ type: 'file', data: CSV, mimeType: 'text/html' }],
			}),
		).toMatchObject({
			details:
				'File mimeType must be one of: text/plain, text/csv, application/json, application/x-ndjson, application/har+json.',
		});
	});

	it('rejects an image that declares a file MIME type', () => {
		expect(
			rejectionOf({
				kind: 'user',
				body: 'hi',
				attachments: [{ type: 'image', data: CSV, mimeType: 'text/csv' }],
			}),
		).toMatchObject({
			details: 'Image mimeType "text/csv" is a text file type; send it as type "file".',
		});
	});

	it('rejects file data over the attachment limit', () => {
		expect(
			rejectionOf({
				kind: 'user',
				body: 'hi',
				attachments: [
					{ type: 'file', data: 'a'.repeat(MAX_IMAGE_DATA_LENGTH + 1), mimeType: 'text/plain' },
				],
			}),
		).toMatchObject({
			details: `File data exceeds the ${MAX_IMAGE_DATA_LENGTH} character limit.`,
		});
		expect(() =>
			assertImagesWithinLimit([
				{ type: 'image', data: 'a'.repeat(MAX_IMAGE_DATA_LENGTH + 1), mimeType: 'text/plain' },
			]),
		).toThrow(`[flue] File data exceeds the ${MAX_IMAGE_DATA_LENGTH} character limit.`);
	});

	it('restores the public type from the stored MIME type', () => {
		expect(
			[
				{ data: CSV, mimeType: 'text/csv', filename: 'report.csv' },
				{ data: PDF, mimeType: 'application/pdf' },
				{ data: PNG, mimeType: 'image/png' },
			].map(toPublicAttachment),
		).toEqual([
			{ type: 'file', data: CSV, mimeType: 'text/csv', filename: 'report.csv' },
			{ type: 'document', data: PDF, mimeType: 'application/pdf' },
			{ type: 'image', data: PNG, mimeType: 'image/png' },
		]);
	});
});

describe('file attachments end to end', () => {
	it('gives the agent the bytes and the model only a manifest entry', async () => {
		const delivered: DeliveredAttachment[][] = [];
		function FileAgent() {
			useModel('faux/model', { compaction: false });
			const delivery = useDelivery();
			useAgentStart(() => {
				if (delivery.kind === 'user') delivered.push(delivery.attachments ?? []);
			});
			return 'Reply to the user.';
		}
		const faux = fauxProvider({ models: [{ id: 'model', input: ['text', 'image'] }] });
		const contexts: Context[] = [];
		faux.setResponses(
			['Read it.', 'Still here.'].map((text) => (context: Context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage([fauxText(text)], { stopReason: 'stop' });
			}),
		);
		const runtime = await start({
			agents: [FileAgent],
			db: sqlite(),
			providers: [faux.provider],
			env: {},
		});
		const agent = init(FileAgent, { id: 'file-attachments' });
		const attachments: DeliveredAttachment[] = [
			{ type: 'file', data: CSV, mimeType: 'text/csv', filename: 'report "q3".csv' },
			{ type: 'image', data: PNG, mimeType: 'image/png' },
		];
		try {
			await expect(
				agent.read(
					await agent.dispatch({
						message: { kind: 'user', body: 'Total the report.', attachments },
					}),
				),
			).resolves.toMatchObject({ text: 'Read it.' });
			await expect(agent.read(await agent.dispatch('Thanks.'))).resolves.toMatchObject({
				text: 'Still here.',
			});
		} finally {
			await agent.abort();
			await runtime.stop();
		}

		expect(delivered).toEqual([attachments, []]);
		expect(contexts).toHaveLength(2);
		for (const context of contexts) {
			const user = context.messages.find((message) => message.role === 'user');
			if (!user || !Array.isArray(user.content)) throw new Error('user message missing');
			const text = user.content.find((block) => block.type === 'text');
			expect(text?.type === 'text' && text.text).toMatch(
				/^Total the report\.\n\n<attachments>\n<file id="att_[^"]+" filename="report &quot;q3&quot;\.csv" mimeType="text\/csv" size="14" \/>\n<image id="att_[^"]+" mimeType="image\/png" \/>\n<\/attachments>$/,
			);
			expect(user.content.filter((block) => block.type === 'image')).toEqual([
				{ type: 'image', data: PNG, mimeType: 'image/png' },
			]);
			expect(JSON.stringify(context)).not.toContain(CSV);
		}
	});

	it('forwards a file to a subagent by attachment id', async () => {
		const childDeliveries: DeliveredMessage[] = [];
		function Analyst() {
			childDeliveries.push(useDelivery());
			return 'Total the attached report.';
		}
		function ParentAgent() {
			useModel('faux/model', { compaction: false });
			useSubagent({ name: 'analyst', description: 'Totals reports.', agent: Analyst });
			return 'Delegate report totals to the analyst.';
		}
		const faux = fauxProvider({ models: [{ id: 'model', input: ['text', 'image'] }] });
		const contexts: Context[] = [];
		faux.setResponses([
			(context) => {
				contexts.push(structuredClone(context));
				const id = JSON.stringify(context).match(/<file id=\\"([^"\\]+)\\"/)?.[1];
				if (!id) throw new Error('file manifest entry missing');
				return fauxAssistantMessage(
					[fauxToolCall('task', { agent: 'analyst', prompt: 'Total it.', attachments: [{ id }] })],
					{ stopReason: 'toolUse' },
				);
			},
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage([fauxText('Total is 42.')], { stopReason: 'stop' });
			},
			fauxAssistantMessage([fauxText('The total is 42.')], { stopReason: 'stop' }),
		]);
		const runtime = await start({
			agents: [ParentAgent],
			db: sqlite(),
			providers: [faux.provider],
			env: {},
		});
		const agent = init(ParentAgent, { id: 'file-subagent' });
		try {
			await expect(
				agent.read(
					await agent.dispatch({
						message: {
							kind: 'user',
							body: 'Total the report.',
							attachments: [
								{ type: 'file', data: CSV, mimeType: 'text/csv', filename: 'report.csv' },
							],
						},
					}),
				),
			).resolves.toMatchObject({ text: 'The total is 42.' });
		} finally {
			await agent.abort();
			await runtime.stop();
		}

		expect(childDeliveries[0]).toEqual({
			kind: 'user',
			body: 'Total it.',
			attachments: [{ type: 'file', data: CSV, mimeType: 'text/csv', filename: 'report.csv' }],
		});
		const childContext = contexts[1];
		if (!childContext) throw new Error('subagent model was not called');
		expect(JSON.stringify(childContext)).toMatch(
			/<file id=\\"att_[^"\\]+\\" filename=\\"report\.csv\\" mimeType=\\"text\/csv\\" size=\\"14\\" \/>/,
		);
		for (const context of contexts) expect(JSON.stringify(context)).not.toContain(CSV);
	});
});
