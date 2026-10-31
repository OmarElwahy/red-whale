// /api/scope/* (docs/architecture.md §6, §10): rules, settings, the "test a target" check, and the decision log.
// Every change is broadcast as `scope.changed`, so open tabs refetch (each node's inScope may differ).
import {
  compileScope,
  scopeCheckInputSchema,
  scopeLogQuerySchema,
  scopeRuleCreateSchema,
  scopeRulePatchSchema,
  scopeRulesQuerySchema,
  scopeSettingsPatchSchema,
} from '@redwhale/shared';
import { z } from 'zod';
import { parseInput } from '../http';
import { recordCheck } from '../scope/authorize';
import { addRule, currentScope, getSettings, listRules, logPage, patchRule, setSettings } from '../scope/store';
import type { RouteContext } from './context';

const ruleIdSchema = z.strictObject({ id: z.coerce.number().int().min(1) });

export function scopeRoutes({ app, db, broadcaster }: RouteContext): void {
  const changed = () => {
    broadcaster.send({ type: 'scope.changed' });
  };

  app.get('/api/scope/rules', (req) => {
    const { removed } = parseInput(scopeRulesQuerySchema, req.query);
    return { rules: listRules(db, { includeRemoved: removed === '1' }) };
  });

  app.post('/api/scope/rules', (req, reply) => {
    const rule = addRule(db, parseInput(scopeRuleCreateSchema, req.body));
    changed();
    return reply.code(201).send(rule);
  });

  app.patch<{ Params: { id: string } }>('/api/scope/rules/:id', (req) => {
    const { id } = parseInput(ruleIdSchema, req.params);
    const rule = patchRule(db, id, parseInput(scopeRulePatchSchema, req.body));
    changed();
    return rule;
  });

  // Not logged: for scripts, and safe for anything to call. A GET must not write (an <img> on any web page can
  // send one without an Origin header).
  app.get('/api/scope/check', (req) => {
    const input = parseInput(scopeCheckInputSchema, req.query);
    const result = compileScope(currentScope(db)).check(input.type, input.value, input.mode);
    return { ...input, decision: result.decision, reason: result.reason, rule: result.rule ?? null, logId: null };
  });

  // The UI's "test a target" box, on submit: the same answer, logged with source `check`.
  app.post('/api/scope/check', (req) => {
    const input = parseInput(scopeCheckInputSchema, req.body);
    const result = recordCheck(db, input, input.mode);
    return { ...input, decision: result.decision, reason: result.reason, rule: result.rule, logId: result.logId };
  });

  app.get('/api/scope/log', (req) => {
    const { page, pageSize, source } = parseInput(scopeLogQuerySchema, req.query);
    return logPage(db, { page, pageSize, sources: source });
  });

  app.get('/api/scope/settings', () => getSettings(db));

  app.patch('/api/scope/settings', (req) => {
    const settings = setSettings(db, parseInput(scopeSettingsPatchSchema, req.body));
    changed();
    return settings;
  });
}
