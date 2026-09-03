/**
 * Shared SQL agent execution store implementation.
 *
 * Used by both Cloudflare (DO SQLite) and Node (`node:sqlite`). Contains all
 * SQL-level storage logic — table DDL, row parsing, and the
 * {@link AgentSubmissionStore} implementation.
 *
 * Platform-specific wiring (opening the database, providing a transaction
 * wrapper) lives in `cloudflare/agent-execution-store.ts` and
 * `node/agent-execution-store.ts`.
 *
 * INTERNAL convenience, scoped to the SQLite dialect family (`node:sqlite`
 * and Durable Object SQLite). Do NOT generalize this module across SQL
 * dialects: there is deliberately no generic-SQL abstraction spanning
 * SQLite and Postgres, and `@flue/postgres` implements the store contract
 * directly on purpose. Cross-backend parity is enforced by the documented
 * invariants on the store interfaces and the contract suites in
 * `@flue/runtime/test-utils` — the only shared code is the storage-agnostic
 * admission algorithm (`admitSubmissionWithBackend`) in adapter-helpers.
 */

import { admitSubmissionWithBackend, isSubmissionPayload } from './adapter-helpers.ts';
import type {
	AgentDispatchAdmission,
	AgentSubmission,
	AgentSubmissionStore,
	SubmissionAttemptRef,
	SubmissionClaimRef,
	SubmissionSettlementObligation,
} from './agent-execution-store.ts';
import {
	DURABILITY_DEFAULT_MAX_ATTEMPTS,
	DURABILITY_DEFAULT_TIMEOUT_MS,
	LEASE_DURATION_MS,
} from './agent-execution-store.ts';
import type { SqlStorage } from './sql-storage.ts';

type SqlRow = Record<string, unknown>;

export interface SqlAgentExecutionStoreOptions {
	/** Enable the approval capability and its Durable Object-only schema. */
	toolApprovals?: boolean;
}

import { migrateFlueSqlSchema } from './format-version.ts';
import { hydratePersistedSubmissionAttachments } from './persisted-image-placement.ts';
import {
	type AgentSubmissionInput,
	createDispatchAgentSubmissionInput,
} from './runtime/agent-submissions.ts';
import type { DispatchInput } from './runtime/dispatch-queue.ts';
import {
	createSqlSubmissionChunkStore,
	ensureSqlSubmissionChunkTable,
} from './sql-persisted-chunk-store.ts';
import type {
	ToolApproval,
	ToolApprovalDecisionStatus,
	ToolApprovalProposal,
} from './tool-approval.ts';

export function ensureSqlAgentExecutionTables(
	sql: SqlStorage,
	options: SqlAgentExecutionStoreOptions = {},
): void {
	migrateFlueSqlSchema(sql, () => {
		ensureSubmissionTable(sql, options.toolApprovals === true);
		if (options.toolApprovals) ensureToolApprovalTable(sql);
		ensureSqlSubmissionChunkTable(sql);
	});
}

/**
 * Initialize an {@link AgentSubmissionStore} from raw SQL primitives.
 * Used by both Cloudflare (DO SQLite) and Node (`node:sqlite`).
 *
 * **Does not run DDL.** Call {@link ensureSqlAgentExecutionTables} first
 * to ensure the schema exists.
 */
export function createSqlAgentExecutionStoreFromSql(
	sql: SqlStorage,
	runTransaction: <T>(closure: () => T) => T,
	options: SqlAgentExecutionStoreOptions = {},
): AgentSubmissionStore {
	const store = new AgentSubmissionStoreImpl(sql, runTransaction, options.toolApprovals === true);
	if (!options.toolApprovals) return store;
	return Object.assign(store, {
		listWaitingForApprovalSubmissions: () => store.listWaitingForApprovalSubmissionsImpl(),
		parkSubmissionForApproval: (
			attempt: SubmissionAttemptRef,
			pendingProposalIds: readonly string[],
		) => store.parkSubmissionForApprovalImpl(attempt, pendingProposalIds),
		createToolApproval: (proposal: ToolApprovalProposal) => store.createToolApprovalImpl(proposal),
		getToolApproval: (proposalId: string) => store.getToolApprovalImpl(proposalId),
		listToolApprovals: (submissionId: string) => store.listToolApprovalsImpl(submissionId),
		decideToolApproval: (input: {
			proposalId: string;
			status: ToolApprovalDecisionStatus;
			reason?: string;
		}) => store.decideToolApprovalImpl(input),
		expireToolApprovals: (now?: number) => store.expireToolApprovalsImpl(now),
	});
}

class AgentSubmissionStoreImpl implements AgentSubmissionStore {
	constructor(
		private sql: SqlStorage,
		private transactionSync: <T>(closure: () => T) => T,
		private toolApprovals: boolean,
	) {}

	async getSubmission(submissionId: string): Promise<AgentSubmission | null> {
		const row = this.readSubmissionRow(submissionId);
		return row ? this.parseSubmission(row) : null;
	}

	async replaceSubmissionAttempt(
		attempt: SubmissionAttemptRef,
		nextAttemptId: string,
		lease?: { ownerId: string; leaseExpiresAt: number },
	): Promise<AgentSubmission | null> {
		const now = Date.now();
		const row = this.sql
			.exec(
				`UPDATE flue_agent_submissions
				 SET attempt_id = ?, started_at = ?, attempt_count = attempt_count + 1${
						lease ? ', owner_id = ?, lease_expires_at = ?' : ''
					}
				 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
				 RETURNING ${submissionColumns}`,
				...(lease
					? [
							nextAttemptId,
							now,
							lease.ownerId,
							lease.leaseExpiresAt,
							attempt.submissionId,
							attempt.attemptId,
						]
					: [nextAttemptId, now, attempt.submissionId, attempt.attemptId]),
			)
			.toArray()[0];
		return row ? this.parseSubmission(row) : null;
	}

	async admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission> {
		return this.admitSubmission(createDispatchAgentSubmissionInput(input));
	}

	async admitDirect(input: AgentSubmissionInput): Promise<AgentSubmission> {
		const admission = this.admitSubmission(input);
		if (admission.kind !== 'submission') {
			throw new Error('[flue] Internal direct admission returned an unexpected result.');
		}
		return admission.submission;
	}

	async markSubmissionCanonicalReady(submissionId: string): Promise<AgentSubmission | null> {
		const row = this.sql
			.exec(
				`UPDATE flue_agent_submissions
				 SET canonical_ready_at = COALESCE(canonical_ready_at, ?)
				 WHERE submission_id = ? AND status = 'queued'
				 RETURNING ${submissionColumns}`,
				Date.now(),
				submissionId,
			)
			.toArray()[0];
		return row ? this.parseSubmission(row) : null;
	}

	async hasUnsettledSubmissions(): Promise<boolean> {
		return (
			this.sql
				.exec(
					`SELECT 1
					 FROM flue_agent_submissions
					 WHERE status IN ('queued', 'running', 'waiting_for_approval', 'terminalizing', 'joining', 'joined')
				 LIMIT 1`,
				)
				.toArray().length > 0
		);
	}

	async listUnreadySubmissions(): Promise<AgentSubmission[]> {
		return this.parseOperationalRows(
			this.sql
				.exec(
					`SELECT ${submissionColumns}
					 FROM flue_agent_submissions
					 WHERE status = 'queued' AND canonical_ready_at IS NULL
					 ORDER BY sequence ASC`,
				)
				.toArray(),
			'queued',
		);
	}

	async listRunnableSubmissions(): Promise<AgentSubmission[]> {
		const rows = this.sql
			.exec(
				`SELECT ${submissionColumns}
				 FROM flue_agent_submissions AS current
				 WHERE current.status = 'queued'
				   AND current.canonical_ready_at IS NOT NULL
				   AND NOT EXISTS (
				     SELECT 1
				     FROM flue_agent_submissions AS earlier
				     WHERE earlier.session_key = current.session_key
				       AND earlier.status IN ('queued', 'running', 'waiting_for_approval', 'terminalizing', 'joining', 'joined')
				       AND earlier.sequence < current.sequence
				   )
				 ORDER BY current.sequence ASC`,
			)
			.toArray();
		return this.parseOperationalRows(rows, 'queued');
	}

	async listRunningSubmissions(): Promise<AgentSubmission[]> {
		return this.parseOperationalRows(
			this.sql
				.exec(
					`SELECT ${submissionColumns}
					 FROM flue_agent_submissions
					 WHERE status = 'running'
					 ORDER BY sequence ASC`,
				)
				.toArray(),
			'active',
		);
	}

	async listWaitingForApprovalSubmissionsImpl(): Promise<AgentSubmission[]> {
		return this.parseOperationalRows(
			this.sql
				.exec(
					`SELECT ${submissionColumns}
					 FROM flue_agent_submissions
					 WHERE status = 'waiting_for_approval'
					 ORDER BY sequence ASC`,
				)
				.toArray(),
			'waiting',
		);
	}

	async listPendingSubmissionSettlements(): Promise<SubmissionSettlementObligation[]> {
		return this.sql
			.exec(
				`SELECT submission_id, session_key, attempt_id, settlement_record_id,
				        settlement_record
				 FROM flue_agent_submissions
				 WHERE status = 'terminalizing'
				 ORDER BY sequence ASC`,
			)
			.toArray()
			.map(parseSettlementObligation);
	}

	// ── Lease management ────────────────────────────────────────────────

	async renewLeases(ownerId: string, submissionIds: string[]): Promise<void> {
		if (submissionIds.length === 0) return;
		const now = Date.now();
		const leaseExpiresAt = now + LEASE_DURATION_MS;
		const placeholders = submissionIds.map(() => '?').join(', ');
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET lease_expires_at = ?
			 WHERE owner_id = ? AND status = 'running'
			   AND submission_id IN (${placeholders})`,
			leaseExpiresAt,
			ownerId,
			...submissionIds,
		);
	}

	async listExpiredSubmissions(): Promise<AgentSubmission[]> {
		const now = Date.now();
		return this.parseOperationalRows(
			this.sql
				.exec(
					`SELECT ${submissionColumns}
					 FROM flue_agent_submissions
					 WHERE status = 'running' AND lease_expires_at > 0 AND lease_expires_at < ?
					 ORDER BY sequence ASC`,
					now,
				)
				.toArray(),
			'active',
		);
	}

	async claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null> {
		const now = Date.now();
		const timeoutAt = now + DURABILITY_DEFAULT_TIMEOUT_MS;
		const timeoutUpdate = this.toolApprovals
			? `CASE
		       WHEN approval_timeout_remaining_ms IS NOT NULL
		         THEN ? + MAX(approval_timeout_remaining_ms, 1)
		       WHEN timeout_at = 0 THEN ?
		       ELSE timeout_at
		     END`
			: 'CASE WHEN timeout_at = 0 THEN ? ELSE timeout_at END';
		const row = this.sql
			.exec(
				`UPDATE flue_agent_submissions AS current
				 SET status = 'running', attempt_id = ?, started_at = ?, attempt_count = attempt_count + 1,
				     max_attempts = CASE WHEN input_applied_at IS NULL THEN ? ELSE max_attempts END,
				     timeout_at = ${timeoutUpdate}${this.toolApprovals ? ', approval_timeout_remaining_ms = NULL' : ''},
				     owner_id = ?, lease_expires_at = ?
				 WHERE current.submission_id = ? AND current.status = 'queued'
				   AND current.canonical_ready_at IS NOT NULL
				   AND NOT EXISTS (
				     SELECT 1
				     FROM flue_agent_submissions AS earlier
				     WHERE earlier.session_key = current.session_key
				       AND earlier.status IN ('queued', 'running', 'waiting_for_approval', 'terminalizing', 'joining', 'joined')
				       AND earlier.sequence < current.sequence
				   )
				 RETURNING ${submissionColumns}`,
				claim.attemptId,
				now,
				DURABILITY_DEFAULT_MAX_ATTEMPTS,
				...(this.toolApprovals ? [now] : []),
				timeoutAt,
				claim.ownerId,
				claim.leaseExpiresAt,
				claim.submissionId,
			)
			.toArray()[0];
		return row ? this.parseSubmission(row) : null;
	}

	async markSubmissionInputApplied(
		attempt: SubmissionAttemptRef,
		durability?: { maxAttempts: number; timeoutAt: number },
	): Promise<boolean> {
		return this.updateOwnedSubmission(
			`UPDATE flue_agent_submissions
			 SET input_applied_at = COALESCE(input_applied_at, ?),
			     max_attempts = CASE WHEN input_applied_at IS NULL THEN ? ELSE max_attempts END,
			     timeout_at = CASE WHEN input_applied_at IS NULL THEN ? ELSE timeout_at END
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`,
			Date.now(),
			durability?.maxAttempts ?? DURABILITY_DEFAULT_MAX_ATTEMPTS,
			durability?.timeoutAt ?? Date.now() + DURABILITY_DEFAULT_TIMEOUT_MS,
			attempt.submissionId,
			attempt.attemptId,
		);
	}

	async parkSubmissionForApprovalImpl(
		attempt: SubmissionAttemptRef,
		pendingProposalIds: readonly string[],
	): Promise<boolean> {
		if (pendingProposalIds.length === 0) return false;
		const placeholders = pendingProposalIds.map(() => '?').join(', ');
		const pendingApproval = `EXISTS (
			SELECT 1 FROM flue_tool_approvals
			WHERE submission_id = ? AND status = 'pending'
			  AND proposal_id IN (${placeholders})
		)`;
		const now = Date.now();
		if (
			this.updateOwnedSubmission(
				`UPDATE flue_agent_submissions
			 SET status = 'waiting_for_approval',
			     approval_timeout_remaining_ms = CASE
			       WHEN timeout_at > ? THEN timeout_at - ? ELSE 0 END,
			     timeout_at = 0, attempt_id = NULL, started_at = NULL,
			     owner_id = NULL, lease_expires_at = 0
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			   AND abort_requested_at IS NULL
			   AND ${pendingApproval}
			 RETURNING submission_id`,
				now,
				now,
				attempt.submissionId,
				attempt.attemptId,
				attempt.submissionId,
				...pendingProposalIds,
			)
		) {
			return true;
		}
		// Pi preflights a parallel batch one call at a time. The first approval
		// parks the attempt; later approval calls in that same batch must be able
		// to observe the already-parked submission rather than fail closed merely
		// because its attempt fields were cleared by the first call.
		return (
			this.sql
				.exec(
					`SELECT 1 FROM flue_agent_submissions
					 WHERE submission_id = ? AND status = 'waiting_for_approval'
					   AND abort_requested_at IS NULL
					   AND ${pendingApproval}
					 LIMIT 1`,
					attempt.submissionId,
					attempt.submissionId,
					...pendingProposalIds,
				)
				.toArray().length > 0
		);
	}

	async createToolApprovalImpl(proposal: ToolApprovalProposal): Promise<ToolApproval> {
		const proposalJson = JSON.stringify(proposal);
		return this.transactionSync(() => {
			this.sql.exec(
				`INSERT OR IGNORE INTO flue_tool_approvals
				 (proposal_id, submission_id, status, proposal_json, requested_at, expires_at)
				 VALUES (?, ?, 'pending', ?, ?, ?)`,
				proposal.proposalId,
				proposal.submissionId,
				proposalJson,
				proposal.requestedAt,
				proposal.expiresAt ?? null,
			);
			const row = this.sql
				.exec(`SELECT * FROM flue_tool_approvals WHERE proposal_id = ?`, proposal.proposalId)
				.toArray()[0];
			if (!row) throw new Error('[flue] Tool approval proposal was not persisted.');
			const existing = parseToolApproval(row);
			if (JSON.stringify(stripApprovalState(existing)) !== proposalJson) {
				throw new Error(
					`[flue] Tool approval proposal "${proposal.proposalId}" conflicts with its persisted input snapshot.`,
				);
			}
			return existing;
		});
	}

	async getToolApprovalImpl(proposalId: string): Promise<ToolApproval | null> {
		const row = this.sql
			.exec(`SELECT * FROM flue_tool_approvals WHERE proposal_id = ?`, proposalId)
			.toArray()[0];
		return row ? parseToolApproval(row) : null;
	}

	async listToolApprovalsImpl(submissionId: string): Promise<ToolApproval[]> {
		return this.sql
			.exec(
				`SELECT * FROM flue_tool_approvals WHERE submission_id = ? ORDER BY requested_at ASC, proposal_id ASC`,
				submissionId,
			)
			.toArray()
			.map(parseToolApproval);
	}

	async decideToolApprovalImpl(input: {
		proposalId: string;
		status: ToolApprovalDecisionStatus;
		reason?: string;
	}): Promise<{ approval: ToolApproval; decisionApplied: boolean; resumed: boolean }> {
		if (
			input.status !== 'approved' &&
			input.status !== 'rejected' &&
			input.status !== 'expired' &&
			input.status !== 'canceled' &&
			input.status !== 'aborted'
		) {
			throw new Error('[flue] Tool approval decision status is invalid.');
		}
		if (input.reason !== undefined && typeof input.reason !== 'string') {
			throw new Error('[flue] Tool approval decision reason must be a string.');
		}
		return this.transactionSync(() => {
			const before = this.sql
				.exec(`SELECT * FROM flue_tool_approvals WHERE proposal_id = ?`, input.proposalId)
				.toArray()[0];
			if (!before) throw new Error(`[flue] Unknown tool approval proposal "${input.proposalId}".`);
			const existing = parseToolApproval(before);
			if (existing.status !== 'pending') {
				return { approval: existing, decisionApplied: false, resumed: false };
			}
			const now = Date.now();
			const expired = existing.expiresAt !== undefined && existing.expiresAt <= now;
			const status: ToolApprovalDecisionStatus = expired ? 'expired' : input.status;
			const reason = expired
				? 'Approval expired before a decision was delivered.'
				: (input.reason ?? null);
			this.sql.exec(
				`UPDATE flue_tool_approvals SET status = ?, decided_at = ?, reason = ?
				 WHERE proposal_id = ? AND status = 'pending'`,
				status,
				now,
				reason,
				input.proposalId,
			);
			const updatedRow = this.sql
				.exec(`SELECT * FROM flue_tool_approvals WHERE proposal_id = ?`, input.proposalId)
				.toArray()[0];
			if (!updatedRow) throw new Error('[flue] Tool approval decision was not persisted.');
			const approval = parseToolApproval(updatedRow);
			const pending =
				this.sql
					.exec(
						`SELECT 1 FROM flue_tool_approvals WHERE submission_id = ? AND status = 'pending' LIMIT 1`,
						approval.submissionId,
					)
					.toArray().length > 0;
			let resumed = false;
			if (!pending) {
				const resumedRow = this.sql
					.exec(
						`UPDATE flue_agent_submissions
						 SET status = 'queued',
						     attempt_count = MAX(attempt_count - 1, 0),
						     timeout_at = 0,
						     approval_timeout_remaining_ms = COALESCE(approval_timeout_remaining_ms, 1),
						     attempt_id = NULL, started_at = NULL, owner_id = NULL, lease_expires_at = 0
						 WHERE submission_id = ? AND status = 'waiting_for_approval'
						 RETURNING submission_id`,
						approval.submissionId,
					)
					.toArray()[0];
				resumed = Boolean(resumedRow);
			}
			return { approval, decisionApplied: true, resumed };
		});
	}

	async expireToolApprovalsImpl(
		now = Date.now(),
	): Promise<Array<{ approval: ToolApproval; resumed: boolean }>> {
		return this.transactionSync(() => {
			const rows = this.sql
				.exec(
					`SELECT * FROM flue_tool_approvals
					 WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
					 ORDER BY requested_at ASC`,
					now,
				)
				.toArray();
			const expired: Array<{ approval: ToolApproval; resumed: boolean }> = [];
			for (const row of rows) {
				const proposal = parseToolApproval(row);
				this.sql.exec(
					`UPDATE flue_tool_approvals SET status = 'expired', decided_at = ?, reason = ?
					 WHERE proposal_id = ? AND status = 'pending'`,
					now,
					'Approval expired before a decision was delivered.',
					proposal.proposalId,
				);
				const updatedRow = this.sql
					.exec(`SELECT * FROM flue_tool_approvals WHERE proposal_id = ?`, proposal.proposalId)
					.toArray()[0];
				if (!updatedRow) throw new Error('[flue] Tool approval expiration was not persisted.');
				const updated = parseToolApproval(updatedRow);
				const resumed = this.resumeIfNoPendingApprovals(updated.submissionId);
				expired.push({ approval: updated, resumed });
			}
			return expired;
		});
	}

	private resumeIfNoPendingApprovals(submissionId: string): boolean {
		const pending =
			this.sql
				.exec(
					`SELECT 1 FROM flue_tool_approvals WHERE submission_id = ? AND status = 'pending' LIMIT 1`,
					submissionId,
				)
				.toArray().length > 0;
		if (pending) return false;
		return (
			this.sql
				.exec(
					`UPDATE flue_agent_submissions
					 SET status = 'queued',
					     attempt_count = MAX(attempt_count - 1, 0),
					     timeout_at = 0,
					     approval_timeout_remaining_ms = COALESCE(approval_timeout_remaining_ms, 1),
				     attempt_id = NULL, started_at = NULL, owner_id = NULL, lease_expires_at = 0
				 WHERE submission_id = ? AND status = 'waiting_for_approval'
				 RETURNING submission_id`,
					submissionId,
				)
				.toArray().length > 0
		);
	}

	async requestSessionAbort(sessionKey: string): Promise<string[]> {
		if (!this.toolApprovals) {
			const rows = this.sql
				.exec(
					`UPDATE flue_agent_submissions
					 SET abort_requested_at = COALESCE(abort_requested_at, ?)
					 WHERE session_key = ? AND status IN ('queued', 'running', 'joining', 'joined')
					 RETURNING submission_id`,
					Date.now(),
					sessionKey,
				)
				.toArray();
			return rows.map((row) => String(row.submission_id));
		}
		return this.transactionSync(() => {
			const now = Date.now();
			// This write is deliberately before the submission transition. It
			// acquires the SQLite writer lock so a concurrent park either becomes
			// visible here and is aborted, or observes the abort stamp below and
			// refuses to park a pending proposal.
			this.sql.exec(
				`UPDATE flue_tool_approvals
				 SET status = 'aborted', decided_at = ?,
				     reason = 'Approval canceled because the session was aborted.'
				 WHERE status = 'pending' AND submission_id IN (
				   SELECT submission_id FROM flue_agent_submissions
				   WHERE session_key = ? AND status = 'waiting_for_approval'
				 )`,
				now,
				sessionKey,
			);
			const rows = this.sql
				.exec(
					`UPDATE flue_agent_submissions
				 SET abort_requested_at = COALESCE(abort_requested_at, ?),
				     status = CASE WHEN status = 'waiting_for_approval' THEN 'queued' ELSE status END,
				     input_applied_at = CASE WHEN status = 'waiting_for_approval' THEN NULL ELSE input_applied_at END,
				     approval_timeout_remaining_ms = CASE WHEN status = 'waiting_for_approval' THEN NULL ELSE approval_timeout_remaining_ms END,
				     timeout_at = CASE WHEN status = 'waiting_for_approval' THEN 0 ELSE timeout_at END
				 WHERE session_key = ? AND status IN ('queued', 'running', 'waiting_for_approval', 'joining', 'joined')
				 RETURNING submission_id`,
					now,
					sessionKey,
				)
				.toArray();
			return rows.map((row) => String(row.submission_id));
		});
	}

	async requeueSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
		return (
			this.sql
				.exec(
					`UPDATE flue_agent_submissions
					 SET status = 'queued', attempt_id = NULL, input_applied_at = NULL, started_at = NULL, owner_id = NULL, lease_expires_at = 0
					 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
					 RETURNING submission_id`,
					attempt.submissionId,
					attempt.attemptId,
				)
				.toArray().length > 0
		);
	}

	async reserveSubmissionSettlement(
		attempt: SubmissionAttemptRef,
		settlement: {
			recordId: string;
			record: import('./conversation-records.ts').SubmissionSettledRecord;
		},
	): Promise<SubmissionSettlementObligation | null> {
		if (settlement.record.id !== settlement.recordId) return null;
		const recordJson = JSON.stringify(settlement.record);
		return this.transactionSync(() => {
			// Two reservable shapes, for either submission kind: the submission's
			// own running attempt, or a delivery JOINED into a host that is
			// running under the caller's attempt — the host settles the joined
			// waiter's record under its own authority, adopting the row
			// (attempt_id/started_at) so the terminalizing invariants and
			// finalize fencing hold.
			const inserted = this.sql
				.exec(
					`UPDATE flue_agent_submissions AS current
					 SET status = 'terminalizing', settlement_record_id = ?, settlement_record = ?,
					     attempt_id = ?, started_at = COALESCE(started_at, ?)
					 WHERE current.submission_id = ?
					   AND current.settlement_record_id IS NULL
					   AND (
					     (current.status = 'running' AND current.attempt_id = ? AND current.owner_id IS NOT NULL)
					     OR (current.status = 'joined' AND EXISTS (
					       SELECT 1 FROM flue_agent_submissions AS host
					       WHERE host.submission_id = current.joined_into
					         AND host.status = 'running' AND host.attempt_id = ?
					     ))
					   )
					 RETURNING submission_id, session_key, attempt_id, settlement_record_id,
					           settlement_record`,
					settlement.recordId,
					recordJson,
					attempt.attemptId,
					Date.now(),
					attempt.submissionId,
					attempt.attemptId,
					attempt.attemptId,
				)
				.toArray()[0];
			if (inserted) return parseSettlementObligation(inserted);
			const existing = this.sql
				.exec(
					`SELECT submission_id, session_key, attempt_id, settlement_record_id,
					        settlement_record
					 FROM flue_agent_submissions
					 WHERE submission_id = ? AND status = 'terminalizing'
					   AND attempt_id = ? AND settlement_record_id = ? AND settlement_record = ?`,
					attempt.submissionId,
					attempt.attemptId,
					settlement.recordId,
					recordJson,
				)
				.toArray()[0];
			return existing ? parseSettlementObligation(existing) : null;
		});
	}

	async finalizeSubmissionSettlement(
		attempt: SubmissionAttemptRef,
		recordId: string,
		options?: { errorMessage?: string },
	): Promise<boolean> {
		return this.transactionSync(() => {
			const pending = this.sql
				.exec(
					`SELECT settlement_record FROM flue_agent_submissions
					 WHERE submission_id = ? AND status = 'terminalizing' AND attempt_id = ?
					   AND settlement_record_id = ?`,
					attempt.submissionId,
					attempt.attemptId,
					recordId,
				)
				.toArray()[0];
			if (!pending) return false;
			// The durable settlement record is the outcome authority; the row's
			// error column mirrors it — the caller's raw server-side message when
			// provided, else the record's client-safe one.
			const record = JSON.parse(String(pending.settlement_record)) as {
				outcome?: string;
				error?: { message?: string };
			};
			const errorMessage =
				record.outcome === 'completed'
					? null
					: (options?.errorMessage ?? record.error?.message ?? 'The submission did not complete.');
			const row = this.sql
				.exec(
					`UPDATE flue_agent_submissions
					 SET status = 'settled', settled_at = ?, error = ?
					 WHERE submission_id = ? AND status = 'terminalizing' AND attempt_id = ?
					   AND settlement_record_id = ?
					 RETURNING submission_id`,
					Date.now(),
					errorMessage,
					attempt.submissionId,
					attempt.attemptId,
					recordId,
				)
				.toArray()[0];
			if (!row) return false;
			// A host settles through the outbox; fan its outcome out to joined
			// deliveries the same way completeSubmission/failSubmission do.
			this.settleJoinedSubmissions(attempt.submissionId, errorMessage);
			return true;
		});
	}

	async completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.transactionSync(() => {
			const settled = this.updateOwnedSubmission(
				`UPDATE flue_agent_submissions
				 SET status = 'settled', settled_at = ?, error = NULL
				 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
				 RETURNING submission_id`,
				Date.now(),
				attempt.submissionId,
				attempt.attemptId,
			);
			if (settled) this.settleJoinedSubmissions(attempt.submissionId, null);
			return settled;
		});
	}

	async failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean> {
		const message = error instanceof Error ? error.message : String(error);
		return this.transactionSync(() => {
			const settled = this.updateOwnedSubmission(
				`UPDATE flue_agent_submissions
				 SET status = 'settled', settled_at = ?, error = ?
				 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
				 RETURNING submission_id`,
				Date.now(),
				message,
				attempt.submissionId,
				attempt.attemptId,
			);
			if (settled) this.settleJoinedSubmissions(attempt.submissionId, message);
			return settled;
		});
	}

	async settleQueuedSubmission(
		submissionId: string,
		_outcome: 'failed' | 'aborted',
		error: unknown,
	): Promise<boolean> {
		const message = error instanceof Error ? error.message : String(error);
		// A single queued-gated CAS: no attempt is created and no joined-delivery
		// fan-out is needed — joins attach to a RUNNING host, so a queued row can
		// never have deliveries joined into it.
		return this.updateOwnedSubmission(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = ?
			 WHERE submission_id = ? AND status = 'queued'
			 RETURNING submission_id`,
			Date.now(),
			message,
			submissionId,
		);
	}

	// ── Turn-boundary joins ──────────────────────────────────────────────

	async claimJoinableSubmissions(
		host: SubmissionAttemptRef,
		agentName: string,
	): Promise<AgentSubmission[]> {
		return this.transactionSync(() => {
			const hostRow = this.sql
				.exec(
					`SELECT session_key FROM flue_agent_submissions
					 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
					 LIMIT 1`,
					host.submissionId,
					host.attemptId,
				)
				.toArray()[0];
			if (!hostRow) return [];
			const queued = this.sql
				.exec(
					`SELECT ${submissionColumns}
					 FROM flue_agent_submissions
					 WHERE session_key = ? AND status = 'queued'
					 ORDER BY sequence ASC`,
					String(hostRow.session_key),
				)
				.toArray();
			const claimed: AgentSubmission[] = [];
			for (const row of queued) {
				// Contiguous prefix: the first non-joinable row ends the claim so
				// admission order is preserved (everything behind it stays queued).
				if (row.canonical_ready_at === null || row.abort_requested_at !== null) {
					break;
				}
				// A malformed row is not joinable and must not fail the host's
				// attempt; it stays queued for the head-scan to terminate once it
				// becomes the session head.
				let submission: AgentSubmission;
				try {
					submission = this.parseSubmission(row);
				} catch {
					break;
				}
				if (submission.input.agent !== agentName) break;
				this.sql.exec(
					`UPDATE flue_agent_submissions
					 SET status = 'joining', joined_into = ?
					 WHERE submission_id = ? AND status = 'queued'`,
					host.submissionId,
					submission.submissionId,
				);
				claimed.push({ ...submission, status: 'joining', joinedInto: host.submissionId });
			}
			return claimed;
		});
	}

	async finalizeJoinedSubmission(
		host: SubmissionAttemptRef,
		submissionId: string,
	): Promise<boolean> {
		return this.updateOwnedSubmission(
			`UPDATE flue_agent_submissions
			 SET status = 'joined', input_applied_at = COALESCE(input_applied_at, ?)
			 WHERE submission_id = ? AND status = 'joining' AND joined_into = ?
			   AND EXISTS (
			     SELECT 1 FROM flue_agent_submissions AS host
			     WHERE host.submission_id = ? AND host.status = 'running' AND host.attempt_id = ?
			   )
			 RETURNING submission_id`,
			Date.now(),
			submissionId,
			host.submissionId,
			host.submissionId,
			host.attemptId,
		);
	}

	async revertJoiningSubmission(
		host: SubmissionAttemptRef,
		submissionId: string,
	): Promise<boolean> {
		return this.updateOwnedSubmission(
			`UPDATE flue_agent_submissions
			 SET status = 'queued', joined_into = NULL, input_applied_at = NULL
			 WHERE submission_id = ? AND status = 'joining' AND joined_into = ?
			   AND EXISTS (
			     SELECT 1 FROM flue_agent_submissions AS host
			     WHERE host.submission_id = ? AND host.status = 'running' AND host.attempt_id = ?
			   )
			 RETURNING submission_id`,
			submissionId,
			host.submissionId,
			host.submissionId,
			host.attemptId,
		);
	}

	async listJoinedSubmissions(hostSubmissionId: string): Promise<AgentSubmission[]> {
		return this.parseOperationalRows(
			this.sql
				.exec(
					`SELECT ${submissionColumns}
					 FROM flue_agent_submissions
					 WHERE joined_into = ? AND status IN ('joining', 'joined')
					 ORDER BY sequence ASC`,
					hostSubmissionId,
				)
				.toArray(),
			'active',
		);
	}

	/**
	 * Joined-delivery settle fan-out, run inside the host's settle
	 * transaction: `joined` rows settle with the host's outcome (`error`
	 * copied, NULL on success); `joining` stragglers — a join whose canonical
	 * input was never confirmed (abort or crash window) — revert to `queued`
	 * so the delivery runs as its own submission instead of vanishing.
	 */
	private settleJoinedSubmissions(hostSubmissionId: string, error: string | null): void {
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = ?
			 WHERE joined_into = ? AND status = 'joined'`,
			Date.now(),
			error,
			hostSubmissionId,
		);
		this.sql.exec(
			`UPDATE flue_agent_submissions
			 SET status = 'queued', joined_into = NULL, input_applied_at = NULL
			 WHERE joined_into = ? AND status = 'joining'`,
			hostSubmissionId,
		);
	}

	private admitSubmission(input: AgentSubmissionInput): AgentDispatchAdmission {
		return this.transactionSync(() => {
			const chunkStore = createSqlSubmissionChunkStore(this.sql);
			const admission = admitSubmissionWithBackend<SqlRow>(input, {
				insertIfAbsent: (row) => {
					this.sql.exec(
						`INSERT OR IGNORE INTO flue_agent_submissions
						 (submission_id, session_key, kind, payload, status, accepted_at)
						 VALUES (?, ?, ?, ?, 'queued', ?)`,
						row.submissionId,
						row.sessionKey,
						row.kind,
						row.payload,
						row.acceptedAt,
					);
				},
				getExisting: (submissionId) => this.readSubmissionRow(submissionId),
				readChunks: (submissionId) => chunkStore.read(submissionId),
				replaceChunks: (submissionId, chunks) => chunkStore.replace(submissionId, chunks),
				parseSubmission,
			});
			// Unreachable: every backend callback above is synchronous, so the
			// shared algorithm completes inside `transactionSync`.
			if (admission instanceof Promise) {
				throw new Error('[flue] Internal SQLite admission backend must be synchronous.');
			}
			return admission;
		});
	}

	private updateOwnedSubmission(query: string, ...bindings: unknown[]): boolean {
		return this.sql.exec(query, ...bindings).toArray().length > 0;
	}

	private parseSubmission(row: SqlRow): AgentSubmission {
		return parseSubmission(
			row,
			createSqlSubmissionChunkStore(this.sql).read(String(row.submission_id)),
		);
	}

	private parseOperationalRows(
		rows: SqlRow[],
		status: 'queued' | 'active' | 'waiting',
	): AgentSubmission[] {
		const submissions: AgentSubmission[] = [];
		for (const row of rows) {
			try {
				submissions.push(this.parseSubmission(row));
			} catch (error) {
				if (typeof row.sequence !== 'number') throw error;
				console.error(
					'[flue] Terminating malformed submission (sequence %d):',
					row.sequence,
					error,
				);
				this.failSubmissionSequence(row.sequence, status, error);
			}
		}
		return submissions;
	}

	private failSubmissionSequence(
		sequence: number,
		status: 'queued' | 'active' | 'waiting',
		error: unknown,
	): void {
		const message = error instanceof Error ? error.message : String(error);
		this.transactionSync(() => {
			const row = this.sql
				.exec(
					`UPDATE flue_agent_submissions
					 SET status = 'settled', settled_at = ?, error = ?
						WHERE sequence = ? AND ${status === 'queued' ? "status = 'queued'" : status === 'waiting' ? "status = 'waiting_for_approval'" : "status = 'running'"}
					 RETURNING submission_id`,
					Date.now(),
					message,
					sequence,
				)
				.toArray()[0];
			// A terminated running host can have joined deliveries gated on its
			// attempt; without the fan-out they would stay unsettled forever and
			// wedge the session queue.
			if (row) this.settleJoinedSubmissions(String(row.submission_id), message);
		});
	}

	private readSubmissionRow(submissionId: string): SqlRow | undefined {
		return this.sql
			.exec(
				`SELECT ${submissionColumns}
				 FROM flue_agent_submissions
				 WHERE submission_id = ?
				 LIMIT 1`,
				submissionId,
			)
			.toArray()[0];
	}
}

const submissionColumns =
	'sequence, submission_id, session_key, kind, payload, status, accepted_at, canonical_ready_at, attempt_id, input_applied_at, abort_requested_at, started_at, joined_into, error, settled_at, attempt_count, max_attempts, timeout_at, owner_id, lease_expires_at';

// Row parsers are intentionally adapter-specific: each backend has its own
// column types, coercion rules, and storage representation. Keeping them
// local avoids a shared abstraction that would need to accommodate every
// backend's quirks.

function parseSettlementObligation(row: SqlRow): SubmissionSettlementObligation {
	if (
		typeof row.submission_id !== 'string' ||
		typeof row.session_key !== 'string' ||
		typeof row.attempt_id !== 'string' ||
		typeof row.settlement_record_id !== 'string' ||
		typeof row.settlement_record !== 'string'
	) {
		throw new Error('[flue] Persisted submission settlement obligation is malformed.');
	}
	return {
		submissionId: row.submission_id,
		sessionKey: row.session_key,
		attemptId: row.attempt_id,
		recordId: row.settlement_record_id,
		record: JSON.parse(row.settlement_record),
	};
}

function parseSubmission(
	row: SqlRow,
	chunks: Parameters<typeof hydratePersistedSubmissionAttachments>[1],
): AgentSubmission {
	if (
		typeof row.sequence !== 'number' ||
		typeof row.submission_id !== 'string' ||
		typeof row.session_key !== 'string' ||
		(row.kind !== 'dispatch' && row.kind !== 'direct') ||
		typeof row.payload !== 'string' ||
		(row.status !== 'queued' &&
			row.status !== 'running' &&
			row.status !== 'waiting_for_approval' &&
			row.status !== 'terminalizing' &&
			row.status !== 'settled' &&
			row.status !== 'joining' &&
			row.status !== 'joined') ||
		typeof row.accepted_at !== 'number' ||
		(row.canonical_ready_at !== null &&
			row.canonical_ready_at !== undefined &&
			typeof row.canonical_ready_at !== 'number') ||
		(row.attempt_id !== null &&
			row.attempt_id !== undefined &&
			typeof row.attempt_id !== 'string') ||
		(row.input_applied_at !== null &&
			row.input_applied_at !== undefined &&
			typeof row.input_applied_at !== 'number') ||
		(row.abort_requested_at !== null &&
			row.abort_requested_at !== undefined &&
			typeof row.abort_requested_at !== 'number') ||
		(row.started_at !== null &&
			row.started_at !== undefined &&
			typeof row.started_at !== 'number') ||
		(row.joined_into !== null &&
			row.joined_into !== undefined &&
			typeof row.joined_into !== 'string') ||
		(row.settled_at !== null &&
			row.settled_at !== undefined &&
			typeof row.settled_at !== 'number') ||
		(row.status === 'queued' &&
			(row.attempt_id != null || row.started_at != null || row.joined_into != null)) ||
		((row.status === 'joining' || row.status === 'joined') &&
			typeof row.joined_into !== 'string') ||
		((row.status === 'running' || row.status === 'terminalizing') &&
			(typeof row.attempt_id !== 'string' || typeof row.started_at !== 'number')) ||
		(row.status === 'waiting_for_approval' &&
			(row.attempt_id != null ||
				row.started_at != null ||
				row.owner_id != null ||
				row.lease_expires_at !== 0)) ||
		typeof row.attempt_count !== 'number' ||
		typeof row.max_attempts !== 'number' ||
		typeof row.timeout_at !== 'number'
	) {
		throw new Error('[flue] Persisted agent submission row is malformed.');
	}
	const parsedPayload = JSON.parse(row.payload);
	const input = hydratePersistedSubmissionAttachments(
		parsedPayload as AgentSubmissionInput,
		chunks,
	);
	if (
		!isSubmissionPayload(input, {
			kind: row.kind as string,
			submissionId: row.submission_id as string,
			sessionKey: row.session_key as string,
			acceptedAt: row.accepted_at as number,
		})
	) {
		throw new Error('[flue] Persisted agent submission payload is malformed.');
	}
	return {
		sequence: row.sequence,
		submissionId: row.submission_id,
		sessionKey: row.session_key,
		kind: row.kind,
		input,
		status: row.status,
		acceptedAt: row.accepted_at,
		canonicalReadyAt: typeof row.canonical_ready_at === 'number' ? row.canonical_ready_at : null,
		...(typeof row.attempt_id === 'string' ? { attemptId: row.attempt_id } : {}),
		...(typeof row.input_applied_at === 'number' ? { inputAppliedAt: row.input_applied_at } : {}),
		...(typeof row.abort_requested_at === 'number'
			? { abortRequestedAt: row.abort_requested_at }
			: {}),
		...(typeof row.started_at === 'number' ? { startedAt: row.started_at } : {}),
		...(typeof row.joined_into === 'string' ? { joinedInto: row.joined_into } : {}),
		...(typeof row.error === 'string' ? { error: row.error } : {}),
		...(typeof row.settled_at === 'number' ? { settledAt: row.settled_at } : {}),
		attemptCount: row.attempt_count,
		maxAttempts: row.max_attempts,
		timeoutAt: row.timeout_at,
		...(typeof row.owner_id === 'string' ? { ownerId: row.owner_id } : {}),
		leaseExpiresAt: typeof row.lease_expires_at === 'number' ? row.lease_expires_at : 0,
	};
}

function ensureSubmissionTable(sql: SqlStorage, toolApprovals: boolean): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_agent_submissions (
		 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
		 submission_id TEXT NOT NULL UNIQUE,
		 session_key TEXT NOT NULL,
		 kind TEXT NOT NULL,
		 payload TEXT NOT NULL,
		 status TEXT NOT NULL,
		 accepted_at INTEGER NOT NULL,
		 canonical_ready_at INTEGER,
		 attempt_id TEXT,
		 input_applied_at INTEGER,
		 abort_requested_at INTEGER,
		 started_at INTEGER,
		 joined_into TEXT,
		 settled_at INTEGER,
		 error TEXT,
		 attempt_count INTEGER NOT NULL DEFAULT 0,
			max_attempts INTEGER NOT NULL DEFAULT ${DURABILITY_DEFAULT_MAX_ATTEMPTS},
			timeout_at INTEGER NOT NULL DEFAULT 0,
			${toolApprovals ? 'approval_timeout_remaining_ms INTEGER,' : ''}
		 owner_id TEXT,
		 lease_expires_at INTEGER NOT NULL DEFAULT 0,
		 settlement_record_id TEXT,
		 settlement_record TEXT
		)`,
	);
	if (toolApprovals) {
		ensureSqlColumn(sql, 'flue_agent_submissions', 'approval_timeout_remaining_ms', 'INTEGER');
	}
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_agent_submissions_status_sequence_idx ON flue_agent_submissions (status, sequence ASC)',
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_agent_submissions_session_status_sequence_idx ON flue_agent_submissions (session_key, status, sequence ASC)',
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_agent_submissions_joined_into_idx ON flue_agent_submissions (joined_into) WHERE joined_into IS NOT NULL',
	);
}

function ensureSqlColumn(sql: SqlStorage, table: string, column: string, definition: string): void {
	const columns = sql.exec(`PRAGMA table_info(${table})`).toArray();
	if (!columns.some((row) => row.name === column)) {
		sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}

function ensureToolApprovalTable(sql: SqlStorage): void {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS flue_tool_approvals (
			proposal_id TEXT PRIMARY KEY,
			submission_id TEXT NOT NULL,
			status TEXT NOT NULL,
			proposal_json TEXT NOT NULL,
			requested_at INTEGER NOT NULL,
			expires_at INTEGER,
			decided_at INTEGER,
			reason TEXT
		)`,
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_tool_approvals_submission_idx ON flue_tool_approvals (submission_id, requested_at ASC)',
	);
	sql.exec(
		'CREATE INDEX IF NOT EXISTS flue_tool_approvals_pending_expiry_idx ON flue_tool_approvals (status, expires_at)',
	);
}

function stripApprovalState(approval: ToolApproval): ToolApprovalProposal {
	const { status: _status, decidedAt: _decidedAt, reason: _reason, ...proposal } = approval;
	return proposal;
}

function parseToolApproval(row: SqlRow): ToolApproval {
	if (
		typeof row.proposal_id !== 'string' ||
		typeof row.proposal_json !== 'string' ||
		(row.status !== 'pending' &&
			row.status !== 'approved' &&
			row.status !== 'rejected' &&
			row.status !== 'expired' &&
			row.status !== 'canceled' &&
			row.status !== 'aborted')
	) {
		throw new Error('[flue] Persisted tool approval row is malformed.');
	}
	const proposal = JSON.parse(row.proposal_json) as ToolApprovalProposal;
	if (
		proposal.proposalId !== row.proposal_id ||
		typeof proposal.submissionId !== 'string' ||
		typeof proposal.instanceId !== 'string' ||
		typeof proposal.conversationId !== 'string' ||
		typeof proposal.assistantMessageId !== 'string' ||
		typeof proposal.toolCallId !== 'string' ||
		typeof proposal.toolName !== 'string' ||
		typeof proposal.toolVersion !== 'string' ||
		typeof proposal.requestedAt !== 'number'
	) {
		throw new Error('[flue] Persisted tool approval proposal is malformed.');
	}
	return {
		...proposal,
		status: row.status as ToolApproval['status'],
		...(typeof row.decided_at === 'number' ? { decidedAt: row.decided_at } : {}),
		...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
	};
}
