/**
 * Structural, in-band content truncation — the safety net behind
 * `contentAttribute()` and, via the exported `truncateContent`, the helper
 * for tighter policy budgets inside a content transform. One algorithm, one
 * sentinel vocabulary, so policy truncation and physical truncation are
 * indistinguishable to whatever reads the traces.
 *
 * Contract: the result always serializes to valid JSON, the serialized form
 * fits the byte budget, what was removed is represented inside the payload
 * itself by `[flue]`-prefixed sentinels (the greppable marker that replaces
 * side-channel `*.truncated` attributes), and the input value is never
 * mutated.
 */

const ENCODER = new TextEncoder();

export const CONTENT_UNSERIALIZABLE = '[flue] content unserializable';
export const CONTENT_TRANSFORM_FAILED = '[flue] content transform failed; content omitted';
export const CONTENT_BUDGET_EXCEEDED = '[flue] content exceeds attribute budget';

/** Sentinels must themselves fit, so pathologically small budgets are refused. */
export const MIN_BUDGET_BYTES = 128;
export type ContentArrayKind =
	'input_messages' | 'output_messages' | 'tool_definitions' | 'system_instructions';
/** Below this, string leaves stop being worth splitting and we bail instead. */
const MIN_LEAF_BYTES = 64;

export function truncateContent(content: unknown, options: { maxBytes: number }): unknown {
	if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < MIN_BUDGET_BYTES) {
		throw new TypeError(`maxBytes must be a safe integer of at least ${MIN_BUDGET_BYTES}.`);
	}
	return fitWithin(content, options.maxBytes);
}

/** Serialized UTF-8 byte length, or undefined when JSON can't represent it. */
function measure(value: unknown): number | undefined {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		return undefined;
	}
	if (serialized === undefined) return undefined;
	return ENCODER.encode(serialized).byteLength;
}

function fitWithin(value: unknown, budget: number): unknown {
	const size = measure(value);
	if (size === undefined) {
		const kind = Array.isArray(value) ? arrayKind(value) : undefined;
		return kind ? [contentSentinel(CONTENT_UNSERIALIZABLE, kind)] : CONTENT_UNSERIALIZABLE;
	}
	if (size <= budget) return value;
	if (typeof value === 'string') return truncateString(value, budget);
	if (Array.isArray(value)) return truncateArray(value, budget);
	if (value !== null && typeof value === 'object') return shrinkStringLeaves(value, budget);
	// Non-string primitives serialize in a handful of bytes and never get here.
	return CONTENT_BUDGET_EXCEEDED;
}

/**
 * Longest prefix (binary-searched, surrogate-safe) whose serialized form plus
 * the in-band suffix fits the budget.
 */
function truncateString(value: string, budget: number): string {
	const totalBytes = ENCODER.encode(value).byteLength;
	let low = 0;
	let high = value.length - 1;
	let best: string | undefined;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const prefix = safeSlice(value, mid);
		const dropped = totalBytes - ENCODER.encode(prefix).byteLength;
		const candidate = `${prefix} [flue:truncated, ${dropped} more bytes]`;
		if (ENCODER.encode(JSON.stringify(candidate)).byteLength <= budget) {
			best = candidate;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return best ?? `[flue:truncated, ${totalBytes} bytes]`;
}

/** Slice that never ends on the high half of a surrogate pair. */
function safeSlice(value: string, end: number): string {
	if (end > 0 && end < value.length) {
		const code = value.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) return value.slice(0, end - 1);
	}
	return value.slice(0, end);
}

/**
 * Drop whole elements from the front (for messages: oldest first) until the
 * rest fits, then represent the drop as one sentinel element matching the
 * array's item shape. A single element that is itself over budget gets its
 * content strings shrunk on a copy; tool definitions only shorten descriptions.
 */
function truncateArray(value: unknown[], budget: number): unknown {
	const kind = arrayKind(value);
	const items = [...value];
	let droppedCount = 0;
	let droppedBytes = 0;
	const sizes = measurePlainArrayElements(items);
	if (sizes) {
		// A suffix sum lets us find the first fitting tail without serializing the
		// entire remaining array after every dropped element.
		const tailBytes = new Array<number>(items.length + 1).fill(0);
		for (let index = items.length - 1; index >= 0; index -= 1) {
			tailBytes[index] = tailBytes[index + 1]! + sizes[index]!;
		}
		while (droppedCount < items.length - 1) {
			droppedBytes += sizes[droppedCount]! + 1;
			droppedCount += 1;
			const sentinel = sentinelItem(kind, droppedCount, droppedBytes);
			const tailLength = items.length - droppedCount;
			// Two brackets, the sentinel, the tail, and one comma per tail item.
			const size = 2 + (measure(sentinel) ?? 0) + tailBytes[droppedCount]! + tailLength;
			if (size <= budget) {
				const candidate = [sentinel, ...items.slice(droppedCount)];
				// Keep actual serialization authoritative at the selected boundary.
				const measured = measure(candidate);
				if (measured !== undefined && measured <= budget) return candidate;
			}
		}
		items.splice(0, droppedCount);
	} else {
		// Preserve the public helper's behavior for exotic values whose
		// serialization can depend on array position or repeated evaluation.
		while (items.length > 1) {
			const removed = items.shift();
			droppedCount += 1;
			droppedBytes += (measure(removed) ?? 0) + 1;
			const candidate = [sentinelItem(kind, droppedCount, droppedBytes), ...items];
			const size = measure(candidate);
			if (size !== undefined && size <= budget) return candidate;
		}
	}
	const sentinel = droppedCount > 0 ? sentinelItem(kind, droppedCount, droppedBytes) : undefined;
	const overhead = (sentinel ? (measure(sentinel) ?? 0) + 1 : 0) + 4;
	// Shrink the last element only when a workable slice of the budget is left
	// beside the sentinel, and re-measure the result: nested fitWithin() calls bottom
	// out in fixed-size markers that can overshoot a tight budget.
	const innerBudget = budget - overhead;
	if (innerBudget >= MIN_LEAF_BYTES) {
		// A parameter schema is executable metadata: shortening its string
		// leaves can corrupt refs, patterns, enums, or required property names.
		const shrunk =
			kind === 'tool_definitions'
				? shrinkToolDescription(items[0], innerBudget)
				: fitWithin(items[0], innerBudget);
		const candidate = sentinel ? [sentinel, shrunk] : [shrunk];
		const size = measure(candidate);
		// Shrinking can return a diagnostic string when structure alone is too
		// large or cloning fails. It must not become a structured array item.
		if (size !== undefined && size <= budget && (!kind || arrayKind(candidate) === kind)) {
			return candidate;
		}
	}
	// Nothing fits beside the sentinel: count the last element as dropped too,
	// then use a compact marker when the detailed sentinel is too big.
	const allDropped = [
		sentinelItem(kind, droppedCount + 1, droppedBytes + (measure(items[0]) ?? 0) + 1),
	];
	const allDroppedSize = measure(allDropped);
	if (allDroppedSize !== undefined && allDroppedSize <= budget) return allDropped;
	// The compact typed marker fits the public 128-byte floor even when
	// the detailed omission count (or output finish_reason) does not.
	if (kind) {
		const compact = [contentSentinel(CONTENT_BUDGET_EXCEEDED, kind)];
		if ((measure(compact) ?? Infinity) <= budget) return compact;
	}
	return CONTENT_BUDGET_EXCEEDED;
}

function arrayKind(value: unknown[]): ContentArrayKind | undefined {
	if (isMessageArray(value)) {
		return isOutputMessageArray(value) ? 'output_messages' : 'input_messages';
	}
	if (value.length === 0) return undefined;
	if (
		value.every(
			(item) => isRecord(item) && typeof item.type === 'string' && typeof item.name === 'string',
		)
	) {
		return 'tool_definitions';
	}
	if (value.every((item) => isRecord(item) && typeof item.type === 'string')) {
		return 'system_instructions';
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function shrinkToolDescription(value: unknown, budget: number): unknown {
	if (!isRecord(value) || typeof value.description !== 'string') return CONTENT_BUDGET_EXCEEDED;
	const clone = { ...value, description: '' };
	const overhead = measure(clone);
	if (overhead === undefined) return CONTENT_UNSERIALIZABLE;
	const descriptionBudget = budget - overhead + 2; // Empty JSON string already counted.
	if (descriptionBudget < MIN_LEAF_BYTES) return CONTENT_BUDGET_EXCEEDED;
	clone.description = truncateString(value.description, descriptionBudget);
	return clone;
}

/**
 * Measure ordinary JSON data once per array element. Values with custom
 * serialization, accessors, unsupported leaves, or cycles use the legacy
 * path because repeated JSON.stringify calls can be observably different.
 */
function measurePlainArrayElements(items: unknown[]): number[] | undefined {
	const sizes: number[] = [];
	for (const item of items) {
		if (!isPlainJsonValue(item, new Set())) return undefined;
		const size = measure(item);
		if (size === undefined) return undefined;
		sizes.push(size);
	}
	return sizes;
}

function isPlainJsonValue(value: unknown, ancestors: Set<object>): boolean {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		(typeof value === 'number' && Number.isFinite(value))
	) {
		return true;
	}
	if (typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
		return false;
	}
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (Array.isArray(value) && key === 'length') continue;
		if (!('value' in descriptor) || !isPlainJsonValue(descriptor.value, ancestors)) {
			ancestors.delete(value);
			return false;
		}
	}
	ancestors.delete(value);
	return true;
}

function isMessageArray(value: unknown[]): boolean {
	return (
		value.length > 0 &&
		value.every(
			(item) =>
				item !== null &&
				typeof item === 'object' &&
				typeof (item as { role?: unknown }).role === 'string' &&
				Array.isArray((item as { parts?: unknown }).parts),
		)
	);
}

function isOutputMessageArray(value: unknown[]): boolean {
	return value.every(
		(item) => typeof (item as { finish_reason?: unknown }).finish_reason === 'string',
	);
}

/**
 * `role: 'flue'` is deliberate: honest, filterable, and never confused with a
 * real conversation turn.
 */
function sentinelItem(kind: ContentArrayKind | undefined, count: number, bytes: number): unknown {
	const messageShaped = kind === 'input_messages' || kind === 'output_messages';
	const text = `[flue] ${count} ${messageShaped ? 'messages' : 'items'} omitted (${bytes} bytes) to fit the attribute budget`;
	return contentSentinel(text, kind);
}

/** In-band diagnostics retain the schema of the surrounding array. */
export function contentSentinel(text: string, kind?: ContentArrayKind): unknown {
	switch (kind) {
		case 'input_messages':
		case 'output_messages':
			return messageSentinel(text, kind === 'output_messages');
		case 'tool_definitions':
			// A generic diagnostic definition, never an actual callable function.
			return { type: 'flue', name: '[flue]', description: text };
		case 'system_instructions':
			return { type: 'text', content: text };
		default:
			return text;
	}
}

/** A diagnostic is message content, never a bare string in a message array. */
export function messageSentinel(text: string, output = false): unknown {
	return {
		role: 'flue',
		parts: [{ type: 'text', content: text }],
		// Output messages require a finish reason; this synthetic diagnostic
		// reports omitted content rather than a successful generation.
		...(output ? { finish_reason: 'error' } : {}),
	};
}

/**
 * Repeatedly halve the longest string leaf (on a detached copy) until the
 * value fits. When every leaf is already small and the structure alone is
 * over budget, bail to the sentinel rather than mangle the shape.
 */
function shrinkStringLeaves(value: object, budget: number): unknown {
	let clone: unknown;
	try {
		clone = structuredClone(value);
	} catch {
		return CONTENT_UNSERIALIZABLE;
	}
	let previousSize = Number.POSITIVE_INFINITY;
	for (;;) {
		const size = measure(clone);
		if (size === undefined) return CONTENT_UNSERIALIZABLE;
		if (size <= budget) return clone;
		// A sentinel-bearing replacement is never shorter than ~126 bytes, so a
		// short leaf can come back equal or larger. The size of each pass must
		// strictly decrease or no sequence of leaf truncations can ever fit.
		if (size >= previousSize) return CONTENT_BUDGET_EXCEEDED;
		previousSize = size;
		const leaf = longestStringLeaf(clone);
		if (!leaf) return CONTENT_BUDGET_EXCEEDED;
		const leafBytes = ENCODER.encode(leaf.value).byteLength;
		if (leafBytes < MIN_LEAF_BYTES) return CONTENT_BUDGET_EXCEEDED;
		leaf.set(truncateString(leaf.value, Math.max(Math.floor(leafBytes / 2), MIN_BUDGET_BYTES)));
	}
}

interface StringLeaf {
	value: string;
	set(replacement: string): void;
}

function longestStringLeaf(value: unknown): StringLeaf | undefined {
	let best: StringLeaf | undefined;
	walk(value);
	return best;

	function walk(node: unknown): void {
		if (Array.isArray(node)) {
			node.forEach((child, index) => {
				visit(child, (replacement) => (node[index] = replacement));
			});
			return;
		}
		if (node !== null && typeof node === 'object') {
			for (const [key, child] of Object.entries(node)) {
				visit(child, (replacement) => ((node as Record<string, unknown>)[key] = replacement));
			}
		}
	}

	function visit(child: unknown, set: (replacement: string) => void): void {
		if (typeof child === 'string') {
			if (!best || child.length > best.value.length) best = { value: child, set };
			return;
		}
		walk(child);
	}
}
