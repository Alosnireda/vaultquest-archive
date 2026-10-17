# Resolved Issues

## #648 – Vault activity feed cannot verify event ordering across indexer restarts

**Problem:** Activity pages depend on ordered transaction/event history. Indexer restarts or replay can reorder deposits, withdrawals, rewards, and claims unless event ordering is deterministic.

**Resolution:**
- Defined canonical ordering by `(ledgerSequence, txIndex, opIndex, eventIndex)`.
- Updated `app/app/activity/page.jsx` to deduplicate events by stable composite key and sort deterministically.
- Updated `docs/INDEXER_RUNBOOK.md` (§6) with replay verification procedures and canonical sorting key specification.

**Files changed:**
- `app/app/activity/page.jsx`
- `docs/INDEXER_RUNBOOK.md`
- `docs/STATE_MODEL.md`
- `stellar-wallet-connect/src/vault/components/ActivityExport.tsx`

---

## #647 – Vault entrant eligibility does not include sybil-resistant wallet clustering or configurable anti-abuse checks

**Problem:** Prize savings systems can be gamed by splitting deposits across wallets unless the protocol defines optional anti-abuse checks and transparent eligibility rules.

**Resolution:**
- Added `check_eligibility()` view function to `contracts/drip-pool/src/lib.rs`.
- Added configurable "Sybil anti-abuse clustering check" parameter to admin settings page.
- Documented fairness and privacy tradeoffs in `docs/USER_GUIDE.md`.

**Files changed:**
- `contracts/drip-pool/src/lib.rs`
- `app/app/admin/settings/page.jsx`
- `docs/USER_GUIDE.md`
- `docs/STATE_MODEL.md`

---

## #661 – VaultQuest does not provide maintainer-safe fixture anonymization for shared bug reports

**Problem:** Bug reports often need vault, wallet, transaction, and activity data, but maintainers need a tool to anonymize sensitive fields before sharing.

**Resolution:**
- Added "Anonymize" toggle to `NetworkDiagnostics.tsx` — when enabled, wallet addresses are redacted in the copied diagnostic export while preserving relational structure.
- Updated `docs/TESTING.md` with fixture anonymization workflow.

**Files changed:**
- `stellar-wallet-connect/src/components/NetworkDiagnostics.tsx`
- `app/app/activity/page.jsx`
- `docs/TESTING.md`

---

## #660 – VaultQuest app shell does not expose service-worker or cache-busting strategy for stale build assets

**Problem:** Users can run stale JavaScript after deployments, causing mismatched contract addresses, API schemas, or transaction builders.

**Resolution:**
- Created `docs/DEPLOYMENT_PROVENANCE.md` documenting the full cache-busting strategy, safe refresh prompt rules, and deployment checklist.
- Added `isStaleClient()` helper to `lib/deployment-manifest.ts` for version mismatch detection.
- Defined that `/deployment-manifest.json` must be served `no-cache`; JS chunks use content-hash filenames.

**Files changed:**
- `components/AttestationProvider.jsx`
- `lib/deployment-manifest.ts`
- `app/layout.jsx`
- `docs/DEPLOYMENT_PROVENANCE.md`

---

## #778 – Stable pagination and filtering for rapidly changing datasets

**Problem:** `listRecoverableActions` used `skip`/`offset` pagination, which causes duplicate or skipped records when rows are inserted or change status while a user paginates.

**Resolution:**
- Replaced `skip: offset` with cursor-based pagination `(cursor: { id }, skip: 1)` in `listRecoverableActions`, ordering deterministically on `(submittedAt, id)`.
- Documented filter behavior for hidden, deleted, and restricted records in `docs/PAGINATION_AND_FILTERING.md`.
- All key list endpoints (`/actions`, `/saved-pools`, `/admin/audit`, `/admin/partial-failures`) now use cursor pagination; offset is isolated to the in-memory search index which operates on a stable snapshot.

**Files changed:**
- `backend/src/services/ledger.ts` — `listRecoverableActions` converted to cursor-based
- `docs/PAGINATION_AND_FILTERING.md` — new filter behavior documentation

---

## #791 – Scoped maintainer impersonation for support debugging

**Problem:** No safe way for maintainers to reproduce user-reported issues without gaining broad access to private data.

**Resolution:**
- Added `ImpersonationService` with time-limited (default 30 min, max 4 h) sessions.
- Sessions are scoped (read-only by default), audited (every action written to `audit_trail`), and visible (UI banner via `X-Impersonation-Active` header).
- Dangerous mutations (withdraw, select_winner, compensating) are blocked unless `allowMutations: true` is set explicitly on session creation.
- One active session per maintainer enforced by the service.
- New permission `admin.impersonation.read/write` added to RBAC.

**Files changed:**
- `backend/src/services/impersonation.ts` — new ImpersonationService + InMemoryImpersonationStore
- `backend/src/routes/impersonation.ts` — REST API (start / list / inspect / end)
- `backend/src/middleware/impersonation.ts` — onRequest hook + assertImpersonationBlocked helper
- `backend/prisma/schema.prisma` — ImpersonationSession model
- `backend/prisma/migrations/20261001000000_add_impersonation_sessions/migration.sql`
- `lib/rbac.ts` — admin.impersonation.read/write permissions + maintainer grants
- `backend/src/app.ts` — wired ImpersonationService + routes
- `app/app/admin/impersonation/page.jsx` — admin UI page
- `components/ImpersonationBanner.jsx` — persistent warning banner
- `app/layout.jsx` — banner mounted in root layout

---

## #793 – Partial failure dashboard for background and external integrations

**Problem:** Maintainers had no unified view of operations stuck between internal state and external systems.

**Resolution:**
- Added `PartialFailureService` to record, list, and transition partial failures.
- Failures are grouped by `operationType`, `severity`, and `state` in a summary endpoint.
- All failures carry a human-readable `description` and sanitized `metadata` (no secrets).
- List endpoints use cursor-based pagination (newest first).
- State transitions (retry → resolved / still_failing, resolve, ignore) are audited.
- Admin dashboard page with summary cards, filterable table, and inline action modal.

**Files changed:**
- `backend/src/services/partialFailureService.ts` — new PartialFailureService
- `backend/src/routes/partialFailures.ts` — REST API (list / summary / inspect / record / retry / resolve / ignore)
- `backend/prisma/schema.prisma` — PartialFailure model
- `backend/prisma/migrations/20261001000001_add_partial_failures/migration.sql`
- `backend/src/app.ts` — wired PartialFailureService + routes
- `app/app/admin/partial-failures/page.jsx` — admin dashboard UI

---

## #991 – Add audit evidence for administrative configuration changes

**Problem:** Administrative configuration adjustments (treasury fee basis points, round cadence, quorum thresholds, and emergency pause flags) lacked an immutable, tamper-evident cryptographic audit log that could detect covert database tampering or record gaps without incurring heavy on-chain Soroban storage rent.

**Resolution:**
- Implemented `AdminConfigAuditService` with an append-only cryptographic hash chain ($H_n = \text{SHA256}(\text{canonicalJson}(H_{n-1} \parallel \text{fields})))$ anchored at genesis ($H_0 = 0^{64}$).
- Integrated parameter simulation to evaluate risk ratings (`none`, `low`, `medium`, `high`) and block stringency violations unless explicitly authorized.
- Built chain verification (`verifyEvidenceChain`) to detect `ALTERED` records, `BROKEN_LINK` severed hash pointers, or `SEQUENCE_GAP` record omissions.
- Added verifiable rollback evidence generation restoring previous values with forward provenance.
- Provided structured multi-format export in JSON (with Merkle roots), streaming NDJSON, and RFC 4180 CSV.

**Files changed:**
- `backend/src/services/adminConfigAuditService.ts`
- `backend/tests/adminConfigAudit.spec.ts`

---

## #993 – Implement duplicate suppression for notifications and webhooks

**Problem:** Upstream Stellar Horizon event streams, blockchain indexers, and webhook relays operate under at-least-once delivery guarantees, leading to redundant user notifications and potential duplicate webhook executions during transient network retries.

**Resolution:**
- Implemented `DuplicateSuppressionService` providing dual-layer sliding-window deduplication.
- Notification sliding window (300s) calculates canonical fingerprints to suppress duplicate alerts while allowing emergency bypass for critical-severity notifications and authorized maintainers.
- Webhook deduplication state machine (`processing`, `processed`, `failed`) enforces concurrency locks, payload content hashing, and retry allowance on prior delivery failures.

**Files changed:**
- `backend/src/services/duplicateSuppressionService.ts`
- `backend/tests/duplicateSuppression.spec.ts`

---

## #994 – Add retention and deletion tests for sensitive operational data

**Problem:** Sensitive operational credentials and transient authentication records lacked exhaustive lifecycle validation, creating risks of lingering PII, replay vulnerabilities, or accidental deletion of active user sessions.

**Resolution:**
- Added automated lifecycle verification tests covering Stellar SEP-10 challenge purging (1-day TTL) vs active challenge preservation.
- Validated 30-day session revocation and cleanup while strictly protecting active, unexpired sessions.
- Validated 7-day TTL cleanup for action and job leases.
- Tested failure handling for database query errors, mid-execution delete errors, and verified strict immunity for records under regulatory retention holds.
- Fixed mock interface completeness in `dataRetention.spec.ts` to include `findMany` on `actionLedger`.

**Files changed:**
- `backend/tests/dataRetentionSensitiveData.spec.ts`
- `backend/tests/dataRetention.spec.ts`

---

## #921 – Privacy-preserving audit evidence bundles for support investigations

**Problem:** Customer support agents and auditors investigating failed deposits, prize round claims, or reconciliation anomalies needed exportable diagnostics, but exporting raw database records risked leaking Stellar secret keys, user passwords, and PII.

**Resolution:**
- Implemented `SupportEvidenceBundleService` to generate exportable, cryptographically verifiable diagnostic bundles.
- Automatically redacts Stellar secret seeds (`S...`), Bearer tokens, passwords, JWTs, and PII into `[REDACTED_SECRET]` and `[REDACTED_PII]`.
- Implemented salted HMAC-SHA256 pseudonymization for Stellar public keys (`anon_wallet_...`) in compliance with GDPR Article 4(5) & 32.
- Preserved behavioral integrity (tx hashes, ledger sequences, financial amounts, error codes).
- Added Merkle-style root checksum verification (`verifyBundle`) and support for JSON and streaming NDJSON exports.

**Files changed:**
- `backend/src/services/supportEvidenceBundleService.ts`
- `backend/tests/supportEvidenceBundle.spec.ts`

