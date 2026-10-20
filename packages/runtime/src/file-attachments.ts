/**
 * Text file attachments on user messages.
 *
 * Flue stores a file's bytes like any other attachment but never sends them
 * to a model. The model context carries only a `<file>` entry in the
 * attachment manifest; the agent decides where the bytes go, for example an
 * `useAgentStart` hook that reads them from `useDelivery()` and writes them to
 * the sandbox.
 *
 * The canonical record keeps an attachment's MIME type but not its wire
 * `type`, so the MIME type alone marks an attachment as a file at every later
 * step. That is why an `image` attachment may not use one of these types.
 */

/** MIME types accepted on `file` attachments. */
export const FILE_MIME_TYPES = [
	'text/plain',
	'text/csv',
	'application/json',
	'application/x-ndjson',
	'application/har+json',
] as const;

export type FileMimeType = (typeof FILE_MIME_TYPES)[number];

const fileMimeTypes: ReadonlySet<string> = new Set(FILE_MIME_TYPES);

export function isFileMimeType(mimeType: string): mimeType is FileMimeType {
	return fileMimeTypes.has(mimeType);
}
