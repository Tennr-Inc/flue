import { describe, expect, it } from 'vitest';
import { createHookStateBuffer } from './use-persistent-state.ts';

function increment(buffer: ReturnType<typeof createHookStateBuffer>, name: string): void {
	const current = buffer.current(name)?.value ?? 0;
	buffer.write(name, Number(current) + 1);
}

describe('persistent-state tool write scopes', () => {
	it('preserves setter call order when parallel tools complete in the opposite order', async () => {
		const buffer = createHookStateBuffer(new Map([['count', 0]]));
		const first = buffer.createWriteScope();
		const second = buffer.createWriteScope();
		let releaseFirst = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstWrote = () => {};
		const firstWrite = new Promise<void>((resolve) => {
			firstWrote = resolve;
		});

		const firstRun = first.run(async () => {
			increment(buffer, 'count');
			firstWrote();
			await firstGate;
		});
		await firstWrite;
		await second.run(async () => increment(buffer, 'count'));
		second.commit();
		releaseFirst();
		await firstRun;
		first.commit();

		expect(buffer.drain()).toEqual([
			{ name: 'count', value: 1 },
			{ name: 'count', value: 2 },
		]);
		expect(buffer.current('count')).toEqual({ value: 2 });
	});

	it('keeps a later scoped write when an earlier equal write is discarded', async () => {
		const buffer = createHookStateBuffer(new Map([['phase', 'draft']]));
		const abandoned = buffer.createWriteScope();
		const completed = buffer.createWriteScope();

		await abandoned.run(async () => buffer.write('phase', 'ready'));
		await completed.run(async () => buffer.write('phase', 'ready'));
		abandoned.discard();
		completed.commit();

		expect(buffer.drain()).toEqual([{ name: 'phase', value: 'ready' }]);
	});

	it('rebases a surviving updater when an earlier scoped update is discarded', async () => {
		const buffer = createHookStateBuffer(new Map([['count', 0]]));
		const abandoned = buffer.createWriteScope();
		const completed = buffer.createWriteScope();

		await abandoned.run(async () => buffer.update('count', (value) => Number(value) + 1, 0));
		await completed.run(async () => buffer.update('count', (value) => Number(value) + 1, 0));
		completed.commit();
		abandoned.discard();

		expect(buffer.drain()).toEqual([{ name: 'count', value: 1 }]);
		expect(buffer.current('count')).toEqual({ value: 1 });
	});

	it('evaluates a rebased surviving updater exactly once', async () => {
		const buffer = createHookStateBuffer(new Map([['count', 0]]));
		const abandoned = buffer.createWriteScope();
		const completed = buffer.createWriteScope();
		let survivingUpdaterCalls = 0;

		await abandoned.run(async () => buffer.update('count', (value) => Number(value) + 1, 0));
		await completed.run(async () =>
			buffer.update(
				'count',
				(value) => {
					survivingUpdaterCalls += 1;
					return Number(value) + 1;
				},
				0,
			),
		);
		completed.commit();

		expect(survivingUpdaterCalls).toBe(0);
		abandoned.discard();
		expect(survivingUpdaterCalls).toBe(1);
		expect(buffer.drain()).toEqual([{ name: 'count', value: 1 }]);
		expect(buffer.current('count')).toEqual({ value: 1 });
		expect(survivingUpdaterCalls).toBe(1);
	});

	it('does not retain or retry an updater that throws at setter call time', () => {
		const buffer = createHookStateBuffer(new Map([['count', 0]]));
		let updaterCalls = 0;
		const failure = new Error('cannot update');

		expect(() =>
			buffer.update(
				'count',
				() => {
					updaterCalls += 1;
					throw failure;
				},
				0,
			),
		).toThrow(failure);
		expect(buffer.drain()).toEqual([]);
		expect(buffer.current('count')).toEqual({ value: 0 });
		expect(updaterCalls).toBe(1);
	});

	it('does not retry a delayed updater that throws during a rebase', async () => {
		const buffer = createHookStateBuffer(new Map([['count', 0]]));
		const abandoned = buffer.createWriteScope();
		const completed = buffer.createWriteScope();
		let updaterCalls = 0;
		const failure = new Error('cannot rebase');

		await abandoned.run(async () => buffer.update('count', (value) => Number(value) + 1, 0));
		await completed.run(async () =>
			buffer.update(
				'count',
				() => {
					updaterCalls += 1;
					throw failure;
				},
				0,
			),
		);
		completed.commit();
		abandoned.discard();

		expect(() => buffer.drain()).toThrow(failure);
		expect(() => buffer.drain()).toThrow(failure);
		expect(updaterCalls).toBe(1);
	});

	it('ignores writes made by an orphaned callback after its scope is discarded', async () => {
		const buffer = createHookStateBuffer(new Map([['count', 0]]));
		const abandoned = buffer.createWriteScope();
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = () => {};
		const start = new Promise<void>((resolve) => {
			started = resolve;
		});

		const run = abandoned.run(async () => {
			started();
			await gate;
			buffer.write('count', 1);
		});
		await start;
		abandoned.discard();
		release();
		await run;

		expect(buffer.drain()).toEqual([]);
		expect(buffer.current('count')).toEqual({ value: 0 });
	});
});
