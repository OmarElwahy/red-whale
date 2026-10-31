// The scope guard's gate (docs/architecture.md §10). authorize() is the ONLY producer of ScopedTarget, and the
// tool runner (Phase 6B, server/src/runner/) will only accept a ScopedTarget, so no code path can run a tool
// against a target that wasn't checked against the current scope and logged.
//
// Three locks, so a forged target fails even if one is bypassed:
// 1. Type: ScopedTarget carries a brand keyed by a `unique symbol` that isn't exported; an object literal can't
//    produce it, and outside this file there is no name to write it with.
// 2. Lint: `as ScopedTarget` / `<ScopedTarget>` casts are an error everywhere but here (eslint.config.js).
// 3. Runtime: every target authorize() issues is remembered in a WeakSet; assertScoped() rejects anything else.
import {
  canonicalTarget,
  compileScope,
  isTargetable,
  type NodeType,
  type ScopeDecision,
  type ScopeMode,
  type ScopeRule,
  type TargetableType,
} from '@redwhale/shared';
import type { Db } from '../db/client';
import { appendLog, currentScope } from './store';

declare const scoped: unique symbol;

/** A target that passed the scope guard. Only authorize() creates one; check it with assertScoped() before use. */
export type ScopedTarget = Readonly<{
  type: TargetableType;
  /** Canonical text (canonicalTarget): exactly what was judged, so exactly what a tool may be run against. */
  value: string;
  mode: ScopeMode;
  /** The include rule that put it in scope. */
  ruleId: number;
  /** Its row in scope_log. */
  logId: number;
  authorizedAt: string;
}> & { readonly [scoped]: true };

export interface TargetRequest {
  type: NodeType;
  value: string;
}

export type AuthorizeResult =
  | { ok: true; target: ScopedTarget }
  | { ok: false; decision: Exclude<ScopeDecision, 'in'>; rule: ScopeRule | null; reason: string; logId: number };

const issued = new WeakSet<object>();

export class ScopeViolation extends Error {
  override name = 'ScopeViolation';
}

/** Decides against the scope as it is right now, and logs it. */
function decideAndLog(db: Db, target: TargetRequest, mode: ScopeMode, source: 'check' | 'run') {
  const result = compileScope(currentScope(db)).check(target.type, target.value, mode);
  const logId = appendLog(db, {
    source,
    targetType: target.type,
    targetValue: target.value,
    mode,
    decision: result.decision,
    ruleId: result.rule?.id ?? null,
    reason: result.reason,
  });
  return { ...result, rule: result.rule ?? null, logId };
}

/**
 * The only way to get a ScopedTarget. Checks `target` against the current rules and passive-only setting, logs
 * the decision as `run` (allowed or not), and returns the target only if it is `in`. Call it immediately before
 * running a tool, never earlier: a rule may be removed in between. `n/a` (not targetable) is refused.
 */
export function authorize(db: Db, target: TargetRequest, mode: ScopeMode): AuthorizeResult {
  const result = decideAndLog(db, target, mode, 'run');
  if (result.decision !== 'in' || result.rule === null || !isTargetable(target.type)) {
    const decision = result.decision === 'in' ? 'out' : result.decision;
    return { ok: false, decision, rule: result.rule, reason: result.reason, logId: result.logId };
  }
  const scopedTarget = Object.freeze({
    type: target.type,
    value: canonicalTarget(target.type, target.value),
    mode,
    ruleId: result.rule.id,
    logId: result.logId,
    authorizedAt: new Date().toISOString(),
  }) as ScopedTarget;
  issued.add(scopedTarget);
  return { ok: true, target: scopedTarget };
}

/**
 * The "test a target" box: the same decision, logged as `check`. Never produces a ScopedTarget, so nothing can
 * run on the strength of a check.
 */
export function recordCheck(db: Db, target: TargetRequest, mode: ScopeMode) {
  return decideAndLog(db, target, mode, 'check');
}

/** True only for objects authorize() returned. */
export function isScopedTarget(value: unknown): value is ScopedTarget {
  return typeof value === 'object' && value !== null && issued.has(value);
}

/** The runner calls this first. Throws for anything authorize() didn't issue (a cast, a copy, a spread). */
export function assertScoped(value: ScopedTarget): void {
  if (!isScopedTarget(value)) throw new ScopeViolation('target did not come from authorize(); refusing to run');
}
