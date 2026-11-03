// Scope guard API hooks (docs/architecture.md §10): rules, the passive-only setting, the "test a target" check
// and the decision log. A rule or setting change is broadcast as `scope.changed`, which refetches every view
// (every node's inScope may change); the hooks here also refetch on their own success, for this tab.
import {
  scopeCheckResponseSchema,
  scopeLogResponseSchema,
  scopeRuleSchema,
  scopeRulesResponseSchema,
  scopeSettingsSchema,
  type ScopeAction,
  type ScopeKind,
  type ScopeMode,
  type ScopeCheckResponse,
  type ScopeRule,
  type ScopeSettings,
  type ScopeSource,
  type NodeType,
} from '@redwhale/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { z } from 'zod';
import { getJson, sendJson } from './client';
import { queryKeys } from './query';

export type ScopeLogPage = z.infer<typeof scopeLogResponseSchema>;

export const SCOPE_LOG_PANEL_SIZE = 25;

export function useScopeRules(includeRemoved = false): UseQueryResult<ScopeRule[]> {
  return useQuery({
    queryKey: queryKeys.scopeRules(includeRemoved),
    queryFn: async ({ signal }) =>
      (await getJson(`/api/scope/rules${includeRemoved ? '?removed=1' : ''}`, scopeRulesResponseSchema, { signal })).rules,
  });
}

export function useScopeSettings(): UseQueryResult<ScopeSettings> {
  return useQuery({
    queryKey: queryKeys.scopeSettings,
    queryFn: ({ signal }) => getJson('/api/scope/settings', scopeSettingsSchema, { signal }),
  });
}

/** Newest first. `sources` = which entries: runs only by default, plus the test box's checks if asked. */
export function useScopeLog(sources: readonly ScopeSource[], page: number): UseQueryResult<ScopeLogPage> {
  const list = [...sources].sort().join(',');
  return useQuery({
    queryKey: queryKeys.scopeLog(list, page),
    queryFn: ({ signal }) =>
      getJson(
        `/api/scope/log?${new URLSearchParams({ source: list, page: String(page), pageSize: String(SCOPE_LOG_PANEL_SIZE) }).toString()}`,
        scopeLogResponseSchema,
        { signal },
      ),
    placeholderData: keepPreviousData,
  });
}

/** After a rule or setting change: every node's inScope may differ, so refetch everything. */
function useRefreshAll() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: queryKeys.all });
}

export interface NewRule {
  kind: ScopeKind;
  value: string;
  action: ScopeAction;
  note: string;
}

export function useAddScopeRule() {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (rule: NewRule) => sendJson('POST', '/api/scope/rules', rule, scopeRuleSchema),
    onSuccess: refresh,
  });
}

export function usePatchScopeRule() {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: number; note?: string; removed?: true }) =>
      sendJson('PATCH', `/api/scope/rules/${String(id)}`, patch, scopeRuleSchema),
    onSuccess: refresh,
  });
}

export function usePatchScopeSettings() {
  const refresh = useRefreshAll();
  return useMutation({
    mutationFn: (patch: { passiveOnly: boolean }) => sendJson('PATCH', '/api/scope/settings', patch, scopeSettingsSchema),
    onSuccess: refresh,
  });
}

/** The "test a target" box, on submit only: POST, so the server logs it (source `check`). */
/**
 * What the scope says about a target right now, from GET /scope/check: NOT logged (the active-run dialog asks it
 * on open; only the real run is logged, by the server). null input: nothing to ask yet.
 */
export function useScopeDecision(input: { type: NodeType; value: string; mode: ScopeMode } | null): UseQueryResult<ScopeCheckResponse> {
  const params = input ? new URLSearchParams({ type: input.type, value: input.value, mode: input.mode }).toString() : '';
  return useQuery({
    queryKey: queryKeys.scopeCheck(input?.type ?? '', input?.value ?? '', input?.mode ?? ''),
    queryFn: ({ signal }) => getJson(`/api/scope/check?${params}`, scopeCheckResponseSchema, { signal }),
    enabled: input !== null,
    staleTime: 0,
  });
}

export function useCheckTarget() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { type: NodeType; value: string; mode: ScopeMode }) =>
      sendJson('POST', '/api/scope/check', input, scopeCheckResponseSchema),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.scopeLogAll }),
  });
}

/** Default deny: with no active include rule, nothing is in scope. */
export function scopeIsEmpty(rules: readonly ScopeRule[]): boolean {
  return !rules.some((r) => r.action === 'include');
}
