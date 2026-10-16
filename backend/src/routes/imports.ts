import type { FastifyPluginAsync, preHandlerHookHandler } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { ok } from "../responses.js";
import {
  IMPORT_FORMAT_VERSION,
  IMPORT_MAX_ROWS,
  type DataImportService,
} from "../services/dataImport.js";
import type { ImportService } from "../services/importService.js";
import { requireServiceAuth } from "../middleware/service-auth.js";
import { importBatchParams, importPreviewBody } from "../schemas/imports.js";

export interface DuplicateReport {
  key: string;
  severity: "exact" | "ambiguous";
  indexes: number[];
}

const importBody = z.object({
  format_version: z.literal(IMPORT_FORMAT_VERSION),
  /** Defaults to a dry run: committing requires an explicit `dry_run: false`. */
  dry_run: z.boolean().default(true),
  records: z.array(z.unknown()).max(IMPORT_MAX_ROWS),
});

/**
 * POST /imports/saved-pools (#773): wallet-scoped user import.
 * Requires `own.data.import`; the wallet is taken from the session, never the body.
 */
export const importsRoutes =
  (svc: DataImportService, guard: preHandlerHookHandler): FastifyPluginAsync =>
  async (app) => {
    app.post("/imports/saved-pools", { preHandler: [guard] }, async (req) => {
      const body = importBody.parse(req.body);
      const wallet = req.principal?.walletAddress;
      if (!wallet)
        throw AppError.forbidden("a wallet session is required to import data");
      const result = await svc.run({
        wallet,
        records: body.records,
        dryRun: body.dry_run,
      });
      const duplicates = detectDuplicates(body.records);
      if (duplicates.length > 0) {
        const exact = duplicates.filter((d) => d.severity === "exact");
        if (exact.length > 0) {
          throw AppError.conflict("exact duplicate records detected", {
            duplicates: exact,
          });
        }
        return ok({
          ...result,
          duplicates: duplicates.map((d) => ({ ...d, reviewRequired: true })),
        });
      }
      return ok(result);
    });
  };

/**
 * Secure import pipeline endpoints (#imports). Service-secret protected:
 * imports are operator tooling, never a public API surface.
 *
 *   POST /internal/imports/preview        — validate + quarantine (no writes)
 *   POST /internal/imports/:id/commit     — apply accepted rows (idempotent)
 *   POST /internal/imports/:id/rollback   — undo not-yet-broadcast rows
 *   GET  /internal/imports/:id            — traceable batch + row report
 */
export const internalImportsRoutes =
  (svc: ImportService, internalSecret: string): FastifyPluginAsync =>
  async (app) => {
    const guard = requireServiceAuth(internalSecret);

    app.post(
      "/internal/imports/preview",
      { preHandler: guard },
      async (req, reply) => {
        const body = importPreviewBody.parse(req.body);
        const result = await svc.preview({
          kind: body.kind,
          content: body.content,
          sourceName: body.source_name,
          createdBy: body.created_by,
          idempotencyKey: body.idempotency_key,
        });
        reply.status(result.created ? 201 : 200);
        return ok({ batch: result.batch, preview: true });
      },
    );

    app.post(
      "/internal/imports/:id/commit",
      { preHandler: guard },
      async (req) => {
        const params = importBatchParams.parse(req.params);
        const result = await svc.commit(params.id);
        return ok({
          batch: result.batch,
          already_committed: result.alreadyCommitted,
        });
      },
    );

    app.post(
      "/internal/imports/:id/rollback",
      { preHandler: guard },
      async (req) => {
        const params = importBatchParams.parse(req.params);
        const result = await svc.rollback(params.id);
        return ok({
          batch: result.batch,
          already_rolled_back: result.alreadyRolledBack,
        });
      },
    );

    app.get("/internal/imports/:id", { preHandler: guard }, async (req) => {
      const params = importBatchParams.parse(req.params);
      const batch = await svc.getBatch(params.id);
      if (!batch)
        throw AppError.notFound(`import batch ${params.id} not found`);
      return ok(batch);
    });
  };

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim().toLowerCase();
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map(canonicalize).join("|");
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, canonicalize(v)] as [string, string])
      .sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([i, v]) => `${i}:${v}`).join("|");
  }
  return String(value);
}

function duplicateKey(record: unknown): string {
  if (record === null || typeof record !== "object")
    return canonicalize(record);
  const r = record as Record<string, unknown>;
  const fields = [
    "vaultAddress",
    "walletAddress",
    "chainId",
    "asset",
    "amount",
    "name",
  ];
  const parts = fields
    .filter((f) => f in r)
    .map((f) => `${f}:${canonicalize(r[f])}`);
  if (parts.length > 0) return parts.join("|");
  return canonicalize(r);
}

export function detectDuplicates(records: unknown[]): DuplicateReport[] {
  const byKey = new Map<string, number[]>();
  records.forEach((record, index) => {
    const key = duplicateKey(record);
    const existing = byKey.get(key);
    if (existing) existing.push(index);
    else byKey.set(key, [index]);
  });
  const reports: DuplicateReport[] = [];
  for (const [key, indexes] of byKey) {
    if (indexes.length > 1) reports.push({ key, severity: "exact", indexes });
  }
  return reports;
}
