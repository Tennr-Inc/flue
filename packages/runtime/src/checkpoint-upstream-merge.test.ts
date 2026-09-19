import { describe, expect, it } from 'vitest';
import {
	decodeReducedInstanceState,
	encodeReducedInstanceState,
	seedReducedConversationState,
	writeFoldCheckpoint,
} from './conversation-fold-checkpoint.ts';
import { loadReducedConversationState } from './conversation-reader.ts';
import { REDUCED_STATE_FORMAT } from './conversation-reducer.ts';
import { ConversationRecordWriter } from './conversation-writer.ts';
import { InMemoryConversationStreamStore } from './runtime/conversation-stream-store.ts';

// Both pre-merge histories independently used checkpoint format 3. An old
// checkpoint must be ignored even when its JSON still decodes successfully.
describe('checkpoints across the upstream merge', () => {
	it.each(['fork', 'upstream'] as const)(
		'refolds a format-3 %s checkpoint and roundtrips the combined state',
		async (history) => {
			const store = new InMemoryConversationStreamStore();
			const path = `/checkpoint-merge/${history}`;
			const writer = await ConversationRecordWriter.create({
				store,
				path,
				identity: { agentName: 'TestAgent', instanceId: history },
				producerId: 'test',
			});
			const timestamp = '2026-09-19T00:00:00.000Z';
			await writer.append([
				{
					v: 1,
					id: 'create',
					type: 'conversation_created',
					conversationId: 'conv',
					harness: 'default',
					session: 'default',
					timestamp,
					kind: 'root',
					affinityKey: 'test',
					createdAt: timestamp,
				},
				{
					v: 1,
					id: 'state',
					type: 'state_write',
					conversationId: 'conv',
					harness: 'default',
					session: 'default',
					timestamp,
					name: 'counter',
					value: 42,
				},
			]);
			const expected = await loadReducedConversationState({ store, path });
			const legacy = JSON.parse(encodeReducedInstanceState(expected));
			// A same-shape fork checkpoint can encode stale fold semantics. The
			// upstream checkpoint also lacks the fork's retained outcome record map.
			legacy.state = [['counter', -1]];
			if (history === 'upstream') delete legacy.conversations[0][1].toolOutcomeRecords;
			const meta = await store.getMeta(path);
			if (!meta) throw new Error('Expected the test stream.');
			await store.putFoldCheckpoint(path, {
				offset: expected.recordsThroughOffset,
				incarnation: meta.incarnation,
				formatVersion: 3,
				data: JSON.stringify(legacy),
			});
			expect((await seedReducedConversationState(store, path)).recordsThroughOffset).toBe('-1');
			const rebuilt = await loadReducedConversationState({ store, path });
			expect(rebuilt.state.get('counter')).toBe(42);
			expect(rebuilt.conversations.get('conv')?.toolOutcomeRecords).toBeInstanceOf(Map);
			expect(encodeReducedInstanceState(rebuilt)).toBe(encodeReducedInstanceState(expected));
			writeFoldCheckpoint(store, path, rebuilt, meta.incarnation);
			expect(REDUCED_STATE_FORMAT).toBeGreaterThan(3);
			expect((await store.getFoldCheckpoint(path))?.formatVersion).toBe(REDUCED_STATE_FORMAT);
			expect(encodeReducedInstanceState(await seedReducedConversationState(store, path))).toBe(
				encodeReducedInstanceState(expected),
			);
			expect(
				encodeReducedInstanceState(decodeReducedInstanceState(encodeReducedInstanceState(rebuilt))),
			).toBe(encodeReducedInstanceState(expected));
		},
	);
});
