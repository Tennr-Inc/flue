import type { Provider } from '@earendil-works/pi-ai';

/**
 * Wraps a faux provider so every request runs with prompt caching disabled.
 *
 * Since pi 1.5 the faux provider simulates a prompt cache whenever a request
 * carries a `sessionId` (which the runtime always sends): it reports every
 * prompt token as `cacheRead` or `cacheWrite` and leaves `input` at 0. pi's
 * silent-overflow check counts only `input + cacheRead`, so the cache-written
 * half of a prompt no longer counts toward the context window. Tests that
 * stage a silent overflow need the whole prompt reported as `input`, which
 * the faux provider does when `cacheRetention` is `'none'`.
 */
export function uncachedFauxProvider(provider: Provider): Provider {
	return {
		...provider,
		stream: (model, context, options) =>
			provider.stream(model, context, { ...options, cacheRetention: 'none' } as typeof options),
		streamSimple: (model, context, options) =>
			provider.streamSimple(model, context, {
				...options,
				cacheRetention: 'none',
			} as typeof options),
	};
}
