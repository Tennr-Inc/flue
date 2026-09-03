/**
 * Persisted-store format versioning.
 *
 * Every persisted Flue store durably records the format version it was
 * created with, and refuses to open a store recorded with an unknown or newer
 * version. This is a storage-agnostic obligation of the
 * {@link PersistenceAdapter} contract: the built-in SQL backends implement it
 * with a one-row `flue_meta` key/value table; non-SQL adapters implement the
 * same obligation natively (a key, a meta document, etc.).
 */

import { PersistedFormatVersionError } from './errors.ts';
import type { SqlStorage } from './sql-storage.ts';

/**
 * Current format version of Flue's built-in persisted stores.
 *
 * Bump this when a persisted format changes incompatibly. Stores recorded
 * with another version are rejected and must be cleared.
 */
export const FLUE_FORMAT_VERSION = 1;

/**
 * Cloudflare Durable Object SQLite stores that have enabled parked approvals.
 * Keeping this distinct from the cross-adapter base format makes a rollback to
 * 2.0.3 fail closed without forcing migrations onto unrelated adapters.
 */
const PREVIOUS_FLUE_DURABLE_TOOL_APPROVAL_FORMAT_VERSION = '1+durable-tool-approvals-v1';
export const FLUE_DURABLE_TOOL_APPROVAL_FORMAT_VERSION = '1+durable-tool-approvals-v2';

/**
 * Throw {@link PersistedFormatVersionError} unless the stored version matches
 * the current {@link FLUE_FORMAT_VERSION}.
 *
 * Adapters call this with the version value they recorded at store creation.
 * A version greater than the current one means the store was written by a
 * newer Flue version and must not be read; any other mismatch means the
 * version marker is unrecognized.
 */
export function assertSupportedFlueFormatVersion(storedVersion: string): void {
	if (
		storedVersion === String(FLUE_FORMAT_VERSION) ||
		storedVersion === PREVIOUS_FLUE_DURABLE_TOOL_APPROVAL_FORMAT_VERSION ||
		storedVersion === FLUE_DURABLE_TOOL_APPROVAL_FORMAT_VERSION
	) {
		return;
	}
	throw new PersistedFormatVersionError({
		storedVersion,
		supportedVersion: FLUE_FORMAT_VERSION,
	});
}

/** Stamp a SQLite store before it can persist a state older runtimes cannot understand. */
export function markFlueSqlDurableToolApprovalFormat(sql: SqlStorage): void {
	const stored = sql
		.exec(`SELECT value FROM flue_meta WHERE key = 'format_version'`)
		.toArray()[0]?.value;
	assertSupportedFlueFormatVersion(String(stored));
	if (String(stored) === FLUE_DURABLE_TOOL_APPROVAL_FORMAT_VERSION) return;
	const updated = sql
		.exec(
			`UPDATE flue_meta SET value = ?
			 WHERE key = 'format_version' AND value IN (?, ?)
			 RETURNING value`,
			FLUE_DURABLE_TOOL_APPROVAL_FORMAT_VERSION,
			String(FLUE_FORMAT_VERSION),
			PREVIOUS_FLUE_DURABLE_TOOL_APPROVAL_FORMAT_VERSION,
		)
		.toArray()[0];
	if (!updated) {
		throw new PersistedFormatVersionError({
			storedVersion: String(stored),
			supportedVersion: FLUE_FORMAT_VERSION,
		});
	}
}

export function migrateFlueSqlSchema(sql: SqlStorage, ensureCurrentSchema: () => void): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_meta (
		 key TEXT PRIMARY KEY,
		 value TEXT NOT NULL
		)`,
	);
	const stored = sql
		.exec(`SELECT value FROM flue_meta WHERE key = 'format_version'`)
		.toArray()[0]?.value;
	if (stored !== undefined && stored !== null) {
		assertSupportedFlueFormatVersion(String(stored));
	} else {
		const legacy = sql
			.exec(`SELECT value FROM flue_meta WHERE key = 'schema_version'`)
			.toArray()[0]?.value;
		if (legacy !== undefined && legacy !== null) {
			// Nightly-era stores stamped `schema_version` 8 hold storage shapes
			// byte-for-byte identical to format 1, so adoption is a pure
			// relabel of the stamp — no data rewrite. Any other value at the
			// old key names a store this runtime cannot read.
			if (String(legacy) !== '8') {
				throw new PersistedFormatVersionError({
					storedVersion: String(legacy),
					supportedVersion: FLUE_FORMAT_VERSION,
				});
			}
			// One UPDATE renames the row in place: atomic even on node:sqlite,
			// where nothing wraps this in a transaction, so the store is never
			// observable without a stamp at either key.
			sql.exec(
				`UPDATE flue_meta SET key = 'format_version', value = ? WHERE key = 'schema_version'`,
				String(FLUE_FORMAT_VERSION),
			);
		} else {
			const existing = sql
				.exec(
					String.raw`SELECT name FROM sqlite_master
					 WHERE type = 'table' AND name LIKE 'flue\_%' ESCAPE '\' AND name <> 'flue_meta'
					 LIMIT 1`,
				)
				.toArray()[0];
			if (existing) {
				throw new PersistedFormatVersionError({
					storedVersion: 'unversioned',
					supportedVersion: FLUE_FORMAT_VERSION,
				});
			}
			// Nothing wraps this in a transaction on node:sqlite, so the stamp
			// must land BEFORE any other DDL: a crash inside ensureCurrentSchema()
			// then leaves a versioned store that re-migrates cleanly instead of
			// tripping the unversioned-legacy rejection forever.
			sql.exec(
				`INSERT OR IGNORE INTO flue_meta (key, value) VALUES ('format_version', ?)`,
				String(FLUE_FORMAT_VERSION),
			);
		}
	}

	ensureCurrentSchema();
}
