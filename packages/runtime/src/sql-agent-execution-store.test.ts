import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
	assertSupportedFlueFormatVersion,
	FLUE_DURABLE_TOOL_APPROVAL_FORMAT_VERSION,
} from './format-version.ts';
import { sqlite } from './node/agent-execution-store.ts';
import {
	createSqlAgentExecutionStoreFromSql,
	ensureSqlAgentExecutionTables,
} from './sql-agent-execution-store.ts';
import type { SqlStorage } from './sql-storage.ts';
import { defineStoreContractTests } from './test-utils/define-store-contract-tests.ts';

let database: DatabaseSync | undefined;

afterEach(() => {
	database?.close();
	database = undefined;
});

function createSqlStorage(db: DatabaseSync): SqlStorage {
	return {
		exec(query: string, ...bindings: unknown[]) {
			const statement = db.prepare(query);
			const normalized = query.trimStart().toUpperCase();
			const expectsRows =
				normalized.startsWith('SELECT') ||
				normalized.startsWith('WITH') ||
				normalized.startsWith('PRAGMA') ||
				/\bRETURNING\b/i.test(query);
			let rows: Record<string, unknown>[] = [];
			if (expectsRows) {
				rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
			} else {
				statement.run(...(bindings as never[]));
			}
			return { toArray: () => rows };
		},
	};
}

function createTransaction(db: DatabaseSync): <T>(closure: () => T) => T {
	return <T>(closure: () => T): T => {
		db.exec('BEGIN');
		try {
			const result = closure();
			db.exec('COMMIT');
			return result;
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	};
}

defineStoreContractTests('Durable Object SQLite submission store', {
	durableToolApprovals: true,
	create() {
		database = new DatabaseSync(':memory:');
		const sql = createSqlStorage(database);
		ensureSqlAgentExecutionTables(sql, { toolApprovals: true });
		return createSqlAgentExecutionStoreFromSql(sql, createTransaction(database), {
			toolApprovals: true,
		});
	},
});

describe('SQLite approval capability scope', () => {
	it('stamps approval-enabled stores so a pre-approval runtime fails closed on rollback', () => {
		database = new DatabaseSync(':memory:');
		const sql = createSqlStorage(database);
		ensureSqlAgentExecutionTables(sql, { toolApprovals: true });
		const stored = String(
			sql.exec(`SELECT value FROM flue_meta WHERE key = 'format_version'`).toArray()[0]?.value,
		);

		expect(stored).toBe(FLUE_DURABLE_TOOL_APPROVAL_FORMAT_VERSION);
		expect(() => assertSupportedFlueFormatVersion(stored)).not.toThrow();
		expect(stored).not.toBe('1');
	});

	it('stamps the approval format before approval-specific schema changes', () => {
		database = new DatabaseSync(':memory:');
		const underlying = createSqlStorage(database);
		const sql: SqlStorage = {
			exec(query, ...bindings) {
				if (query.includes('CREATE TABLE IF NOT EXISTS flue_tool_approvals')) {
					throw new Error('simulated migration interruption');
				}
				return underlying.exec(query, ...bindings);
			},
		};

		expect(() => ensureSqlAgentExecutionTables(sql, { toolApprovals: true })).toThrow(
			'simulated migration interruption',
		);
		const stored = String(
			underlying.exec(`SELECT value FROM flue_meta WHERE key = 'format_version'`).toArray()[0]
				?.value,
		);
		expect(stored).toBe(FLUE_DURABLE_TOOL_APPROVAL_FORMAT_VERSION);
	});

	it('upgrades the first approval format marker before enabling maintenance state', () => {
		database = new DatabaseSync(':memory:');
		const sql = createSqlStorage(database);
		ensureSqlAgentExecutionTables(sql);
		sql.exec(
			`UPDATE flue_meta SET value = '1+durable-tool-approvals-v1' WHERE key = 'format_version'`,
		);

		ensureSqlAgentExecutionTables(sql, { toolApprovals: true });

		expect(
			String(
				sql.exec(`SELECT value FROM flue_meta WHERE key = 'format_version'`).toArray()[0]?.value,
			),
		).toBe(FLUE_DURABLE_TOOL_APPROVAL_FORMAT_VERSION);
	});

	it('does not expose approval storage through the Node SQLite adapter', async () => {
		const adapter = sqlite();
		try {
			await adapter.migrate?.();
			const stores = await adapter.connect();
			expect(stores.submissionStore.createToolApproval).toBeUndefined();
			expect(stores.submissionStore.listWaitingForApprovalSubmissions).toBeUndefined();
			expect(stores.submissionStore.decideToolApproval).toBeUndefined();
		} finally {
			await adapter.close?.();
		}
	});
});
