import { AsyncLocalStorage } from 'node:async_hooks';
import { type HookStateStore, isRendering, requireRenderFrame } from './frame.ts';
import { normalizeJsonValue } from './json-value.ts';

/**
 * Durable agent state: an API over the record log of the agent instance.
 *
 * `usePersistentState` reads the value as of this render (reduced from the instance's
 * `state_write` records) and returns a setter that persists a new value —
 * either directly (`setPhase('drafting')`) or through an updater
 * (`setCount((previous) => previous + 1)`) resolved at call time.
 * Reads are render-time snapshots; writes are silent — they never post a
 * message, never wake the agent, and never re-render mid-run. The next
 * turn's render reads the latest persisted values.
 *
 * ```ts
 * export default function SupportAgent() {
 *   const [phase, setPhase] = usePersistentState<Phase>('phase', 'gathering');
 *
 *   useTool({
 *     name: 'begin_draft',
 *     description: 'Call once the case facts are verified.',
 *     run: () => setPhase('drafting'),
 *   });
 *
 *   return `Current phase: ${phase}.`;
 * }
 * ```
 *
 * Semantics:
 * - Values are JSON: writes are normalized through a JSON round-trip and
 *   throw on non-serializable input. There is no unset — a name, once
 *   written, always has a value (`defaultValue` fills in before the first
 *   write and is never persisted itself).
 * - The updater form is the read-modify-write path: `previous` resolves in
 *   setter call order through the write buffer (this attempt's writes over
 *   the snapshot; `defaultValue` before the first write ever). An updater
 *   whose input still depends on another active parallel tool is evaluated
 *   once that tool commits or discards, so rollback can rebase it without
 *   invoking user code twice. The render value is a snapshot — two callbacks
 *   in one turn each spreading it would drop each other's writes; updaters
 *   compose instead. Any function argument is treated as an updater (a
 *   function was never a legal value — values are JSON).
 * - Writing the current value again is a no-op: no record is appended.
 * - Writes made by tools become durable atomically with the tool batch that
 *   made them — if the batch settles, the write is durable; if recovery
 *   settles the batch as interrupted, the write never happened.
 * - The setter throws during render: a render is a pure read of the record
 *   stream. Write from tool `run` functions and other runtime callbacks.
 * - State is scoped to the agent instance (its whole stream), keyed by
 *   `name`; declaring the same name twice in one render throws.
 * - The type parameter is a compile-time convenience only — nothing parses
 *   persisted values. For runtime enforcement, assert at the call site
 *   (`v.assert(schema, value)`) or compose your own hook over this one
 *   (e.g. a `usePersistentStateWithSchema(name, schema, defaultValue)` that parses
 *   reads and validates writes).
 */
export function usePersistentState<T>(name: string, defaultValue: T): [T, StateSetter<T>];
export function usePersistentState<T = unknown>(
	name: string,
): [T | undefined, StateSetter<T | undefined>];
export function usePersistentState(
	name: string,
	defaultValue?: unknown,
): [unknown, StateSetter<unknown>] {
	const frame = requireRenderFrame('usePersistentState');
	if (frame.kind === 'subagent') {
		throw new Error(
			'[flue] usePersistentState() is not available in a subagent render. Durable state is scoped to the agent instance; delegates run detached tasks with no state channel. Pass what the delegate needs through the task prompt instead.',
		);
	}
	if (typeof name !== 'string' || name.length === 0) {
		throw new Error(
			'[flue] usePersistentState(name, defaultValue?) takes the state name as its first argument — a non-empty string.',
		);
	}
	if (frame.stateNames.has(name)) {
		throw new Error(
			`[flue] Duplicate usePersistentState name "${name}" in one render. State names identify a value across renders and must be unique.`,
		);
	}
	frame.stateNames.add(name);

	const store = frame.state?.store;
	const persisted = readPersisted(name, frame.state?.snapshot, store);
	const value = persisted ? persisted.value : defaultValue;

	const setValue: StateSetter<unknown> = (next) => {
		if (isRendering()) {
			throw new Error(
				`[flue] State "${name}" was written during render. Renders are pure reads of the record stream — write from tool run functions or other runtime callbacks, and use the default value for the initial value.`,
			);
		}
		if (!store) {
			throw new Error(
				`[flue] State "${name}" has no durable runtime behind this render, so writes are unavailable.`,
			);
		}
		if (typeof next === 'function') {
			store.update(name, next as (previous: unknown) => unknown, defaultValue);
			return;
		}
		store.write(name, normalizeStateValue(name, next));
	};
	return [value, setValue];
}

export type StateSetter<T> = (value: T | ((previous: T) => T)) => void;

/** One durable write, in call order, as drained by the session for appending. */
export interface HookStateWrite {
	name: string;
	value: unknown;
}

/**
 * The runtime's write buffer for one harness lifetime (one submission
 * attempt). Setters push into it; the session drains it into the same append
 * batch as the tool batch's `tool_results_committed` record. No-op writes
 * (deep-equal to the current value) are dropped here, so "one actual change →
 * one record" holds no matter how often a setter is called.
 */
export interface HookStateBuffer extends HookStateStore {
	drain(): HookStateWrite[];
	/** Isolate one concurrent tool invocation's writes until it settles. */
	createWriteScope(): HookStateWriteScope;
}

export interface HookStateWriteScope {
	run<T>(callback: () => Promise<T>): Promise<T>;
	commit(): void;
	discard(): void;
}

interface HookStateWriteScopeState {
	owner: HookStateBuffer;
	status: 'active' | 'committed' | 'discarded';
}

interface BufferedHookStateWrite {
	name: string;
	value: unknown;
	resolved: boolean;
	failed: boolean;
	error?: unknown;
	operation:
		| { type: 'set'; value: unknown }
		| { type: 'update'; updater: (previous: unknown) => unknown; defaultValue: unknown };
	scope?: HookStateWriteScopeState;
}

interface PendingHookStateValue {
	resolved: boolean;
	value: unknown;
	activeScopes: Set<HookStateWriteScopeState>;
}

const hookStateWriteScopeStorage = new AsyncLocalStorage<HookStateWriteScopeState>();

export function createHookStateBuffer(snapshot: ReadonlyMap<string, unknown>): HookStateBuffer {
	// Values already drained into a canonical append remain visible to setters
	// for the rest of this attempt. Writes not yet drained stay in one global
	// call-order ledger, regardless of which parallel tool owns them.
	const drainedOverlay = new Map<string, unknown>();
	let pending: BufferedHookStateWrite[] = [];
	let rebaseError: unknown;
	let hasRebaseError = false;
	const baseCurrentValue = (name: string): { value: unknown } | undefined => {
		if (drainedOverlay.has(name)) return { value: drainedOverlay.get(name) };
		if (snapshot.has(name)) return { value: snapshot.get(name) };
		return undefined;
	};
	const resolveOperation = (
		name: string,
		operation: BufferedHookStateWrite['operation'],
		current: { value: unknown } | undefined,
	): unknown => {
		if (operation.type === 'set') return operation.value;
		return normalizeStateValue(
			name,
			operation.updater(current ? current.value : operation.defaultValue),
		);
	};
	const recomputePending = (): Map<string, PendingHookStateValue> => {
		rebaseError = undefined;
		hasRebaseError = false;
		const values = new Map<string, PendingHookStateValue>();
		try {
			for (const write of pending) {
				if (write.scope?.status === 'discarded') continue;
				if (write.failed) throw write.error;
				const base = baseCurrentValue(write.name);
				const current = values.get(write.name) ?? {
					resolved: true,
					value: base?.value,
					activeScopes: new Set<HookStateWriteScopeState>(),
				};
				const ownActiveScope = write.scope?.status === 'active' ? write.scope : undefined;
				if (write.operation.type === 'set') {
					write.value = write.operation.value;
					write.resolved = true;
					values.set(write.name, {
						resolved: true,
						value: write.value,
						activeScopes: new Set(ownActiveScope ? [ownActiveScope] : []),
					});
					continue;
				}
				if (!write.resolved) {
					const dependsOnAnotherActiveScope =
						!current.resolved || [...current.activeScopes].some((scope) => scope !== write.scope);
					if (dependsOnAnotherActiveScope) {
						const activeScopes = new Set(current.activeScopes);
						if (ownActiveScope) activeScopes.add(ownActiveScope);
						values.set(write.name, { resolved: false, value: undefined, activeScopes });
						continue;
					}
					try {
						write.value = resolveOperation(
							write.name,
							write.operation,
							base || current.value !== undefined ? { value: current.value } : undefined,
						);
						write.resolved = true;
					} catch (error) {
						write.failed = true;
						write.error = error;
						throw error;
					}
				}
				// A resolved updater was evaluated only after every dependency
				// outside its own scope was final. Its own writes live or die as a
				// unit, so the value never needs to be evaluated again.
				values.set(write.name, {
					resolved: true,
					value: write.value,
					activeScopes: new Set(ownActiveScope ? [ownActiveScope] : []),
				});
			}
		} catch (error) {
			rebaseError = error;
			hasRebaseError = true;
		}
		return values;
	};
	const currentValue = (name: string): { value: unknown } | undefined => {
		const current = recomputePending().get(name);
		if (hasRebaseError) throw rebaseError;
		if (current && !current.resolved) {
			throw new Error(
				`[flue] State "${name}" cannot be read while its value depends on another active tool.`,
			);
		}
		return current ? { value: current.value } : baseCurrentValue(name);
	};
	const store: HookStateBuffer = {
		current(name) {
			return currentValue(name);
		},
		write(name, value) {
			const scope = hookStateWriteScopeStorage.getStore();
			if (scope?.owner === store) {
				// An abandoned tool keeps its async context until its promise really
				// settles. Once discarded, writes from that orphan are intentionally
				// ignored so they cannot leak into a later turn or attempt.
				if (scope.status !== 'active') return;
				pending.push({
					name,
					value,
					resolved: true,
					failed: false,
					operation: { type: 'set', value },
					scope,
				});
				return;
			}
			pending.push({
				name,
				value,
				resolved: true,
				failed: false,
				operation: { type: 'set', value },
			});
		},
		update(name, updater, defaultValue) {
			const scope = hookStateWriteScopeStorage.getStore();
			if (scope?.owner === store && scope.status !== 'active') return;
			const operation = { type: 'update' as const, updater, defaultValue };
			const write: BufferedHookStateWrite = {
				name,
				value: undefined,
				resolved: false,
				failed: false,
				operation,
				...(scope?.owner === store ? { scope } : {}),
			};
			pending.push(write);
			recomputePending();
			if (hasRebaseError) {
				const error = rebaseError;
				pending = pending.filter((candidate) => candidate !== write);
				recomputePending();
				throw error;
			}
		},
		drain() {
			recomputePending();
			if (hasRebaseError) throw rebaseError;
			const drained: HookStateWrite[] = [];
			const retained: BufferedHookStateWrite[] = [];
			let blocked = false;
			for (const write of pending) {
				if (write.scope?.status === 'discarded') continue;
				if (write.scope?.status === 'active') {
					blocked = true;
					retained.push(write);
					continue;
				}
				// A later updater may have observed an earlier active write. Preserve
				// the call-order suffix until that scope commits or discards, so the
				// updater can be rebased if its dependency is rolled back.
				if (blocked) {
					retained.push(write);
					continue;
				}
				const current = baseCurrentValue(write.name);
				if (current && JSON.stringify(current.value) === JSON.stringify(write.value)) continue;
				drained.push({ name: write.name, value: write.value });
				drainedOverlay.set(write.name, write.value);
			}
			pending = retained;
			return drained;
		},
		createWriteScope() {
			const state: HookStateWriteScopeState = {
				owner: store,
				status: 'active',
			};
			return {
				run: (callback) => hookStateWriteScopeStorage.run(state, callback),
				commit() {
					if (state.status === 'active') {
						state.status = 'committed';
						recomputePending();
					}
				},
				discard() {
					if (state.status === 'active') {
						state.status = 'discarded';
						recomputePending();
					}
				},
			};
		},
	};
	return store;
}

function readPersisted(
	name: string,
	snapshot: ReadonlyMap<string, unknown> | undefined,
	store: HookStateStore | undefined,
): { value: unknown } | undefined {
	// The store's view wins: it overlays writes made since the snapshot was
	// taken (same submission), so a re-render would read its own writes.
	const current = store?.current(name);
	if (current) return current;
	if (snapshot?.has(name)) return { value: snapshot.get(name) };
	return undefined;
}

function normalizeStateValue(name: string, value: unknown): unknown {
	return normalizeJsonValue(value, {
		label: 'State',
		name,
		undefinedMessage: `[flue] State "${name}" cannot be set to undefined. State values are JSON; there is no unset.`,
	});
}
