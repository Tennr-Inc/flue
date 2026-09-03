import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
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
			const rows = expectsRows
				? (statement.all(...(bindings as never[])) as Record<string, unknown>[])
				: (statement.run(...(bindings as never[])), []);
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
