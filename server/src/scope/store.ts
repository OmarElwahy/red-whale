// Scope rules, settings and log in the workspace database (docs/architecture.md §10). Rules are never deleted:
// removing one stamps `removed_at`, so the log can still say which rule made each decision.
import {
  normalizeScopeRule,
  type Scope,
  type ScopeLogEntry,
  type ScopeRule,
  type ScopeSettings,
  type ScopeSource,
  type scopeRuleCreateSchema,
} from '@redwhale/shared';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../db/client';
import { scopeLog, scopeRules, scopeSettings } from '../db/schema';
import { HttpError, notFound } from '../http';

const ruleColumns = {
  id: scopeRules.id,
  kind: scopeRules.kind,
  value: scopeRules.value,
  action: scopeRules.action,
  note: scopeRules.note,
  createdAt: scopeRules.createdAt,
  removedAt: scopeRules.removedAt,
};

/** Active rules, oldest first; with `includeRemoved`, removed ones too. */
export function listRules(db: Db, { includeRemoved = false } = {}): ScopeRule[] {
  const q = db.select(ruleColumns).from(scopeRules);
  return (includeRemoved ? q : q.where(isNull(scopeRules.removedAt))).orderBy(asc(scopeRules.id)).all();
}

export function getSettings(db: Db): ScopeSettings {
  const row = db
    .select({ passiveOnly: scopeSettings.passiveOnly, updatedAt: scopeSettings.updatedAt })
    .from(scopeSettings)
    .where(eq(scopeSettings.id, 1))
    .get();
  // The migration creates the row; without it, fall back to the safe default rather than fail open.
  return row ?? { passiveOnly: true, updatedAt: new Date(0).toISOString() };
}

/** What checkScope needs: the active rules and the passive-only setting, read now. */
export function currentScope(db: Db): Scope<ScopeRule> {
  return { rules: listRules(db), passiveOnly: getSettings(db).passiveOnly };
}

export type NewRule = z.input<typeof scopeRuleCreateSchema>;

/** Validates, normalizes and stores a rule. 400 with the reason if it's refused, 409 if an active twin exists. */
export function addRule(db: Db, input: NewRule): ScopeRule {
  const normalized = normalizeScopeRule(input.kind, input.action, input.value);
  if (!normalized.ok) throw new HttpError(400, 'scope rule refused', [normalized.error]);
  return db.transaction((tx) => {
    const twin = tx
      .select({ id: scopeRules.id })
      .from(scopeRules)
      .where(
        and(
          eq(scopeRules.kind, input.kind),
          eq(scopeRules.value, normalized.value),
          eq(scopeRules.action, input.action),
          isNull(scopeRules.removedAt),
        ),
      )
      .get();
    if (twin) {
      throw new HttpError(409, `rule #${String(twin.id)} already ${input.action}s ${input.kind} ${normalized.value}`);
    }
    return tx
      .insert(scopeRules)
      .values({
        kind: input.kind,
        value: normalized.value,
        action: input.action,
        note: input.note ?? '',
        createdAt: new Date().toISOString(),
      })
      .returning(ruleColumns)
      .get();
  });
}

/** Edits a note, or removes the rule (one-way; add it again to restore). 404 for an unknown ID. */
export function patchRule(db: Db, id: number, patch: { note?: string; removed?: true }): ScopeRule {
  return db.transaction((tx) => {
    const current = tx.select(ruleColumns).from(scopeRules).where(eq(scopeRules.id, id)).get();
    if (!current) throw notFound(`scope rule ${String(id)}`);
    if (patch.removed && current.removedAt !== null) throw new HttpError(409, `rule #${String(id)} is already removed`);
    const next = {
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.removed ? { removedAt: new Date().toISOString() } : {}),
    };
    return tx.update(scopeRules).set(next).where(eq(scopeRules.id, id)).returning(ruleColumns).get();
  });
}

export function setSettings(db: Db, patch: { passiveOnly: boolean }): ScopeSettings {
  db.update(scopeSettings)
    .set({ passiveOnly: patch.passiveOnly, updatedAt: new Date().toISOString() })
    .where(eq(scopeSettings.id, 1))
    .run();
  return getSettings(db);
}

export interface LogRow {
  source: ScopeSource;
  targetType: ScopeLogEntry['targetType'];
  targetValue: string;
  mode: ScopeLogEntry['mode'];
  decision: ScopeLogEntry['decision'];
  ruleId: number | null;
  reason: string;
}

/** Appends one decision to the log; returns its ID. Only authorize.ts calls this. */
export function appendLog(db: Db, row: LogRow): number {
  return db
    .insert(scopeLog)
    .values({ ...row, at: new Date().toISOString() })
    .returning({ id: scopeLog.id })
    .get().id;
}

/** Newest first, with each entry's rule as it is now. */
export function logPage(
  db: Db,
  { page, pageSize, sources }: { page: number; pageSize: number; sources: readonly ScopeSource[] },
): { items: ScopeLogEntry[]; page: number; pageSize: number; total: number } {
  const where = inArray(scopeLog.source, [...sources]);
  const total = db.select({ n: sql<number>`COUNT(*)` }).from(scopeLog).where(where).get()?.n ?? 0;
  const rows = db
    .select({
      id: scopeLog.id,
      source: scopeLog.source,
      targetType: scopeLog.targetType,
      targetValue: scopeLog.targetValue,
      mode: scopeLog.mode,
      decision: scopeLog.decision,
      ruleId: scopeLog.ruleId,
      reason: scopeLog.reason,
      at: scopeLog.at,
    })
    .from(scopeLog)
    .where(where)
    .orderBy(desc(scopeLog.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();
  const rules = new Map(listRules(db, { includeRemoved: true }).map((r) => [r.id, r]));
  return {
    items: rows.map(({ ruleId, ...r }) => ({ ...r, rule: ruleId === null ? null : (rules.get(ruleId) ?? null) })),
    page,
    pageSize,
    total,
  };
}
