// Bug-report drafts for a vulnerability, secret or leak node: GET /api/nodes/:id/report (docs/architecture.md §6).
// Everything comes from what's stored. Tool data is untrusted (it comes from target pages), so every value from it
// is escaped for Markdown or put in a code fence: it can't form a link, an image, HTML or a heading. The analyst's
// own notes go in as Markdown.
import { isReportNodeType, type NodeReport, type NodeType, type ReportNodeType } from '@redwhale/shared';
import type { Db } from '../db/client';
import { nodeDetail } from '../routes/nodes';

type Detail = NonNullable<ReturnType<typeof nodeDetail>>;

export interface PathNode {
  id: string;
  type: NodeType;
  label: string;
}

export interface ReportInput {
  detail: Detail;
  /** Root → node, along the shortest way up (ties by value). */
  path: PathNode[];
  /** The other direct parents, each with its own path root → parent. */
  alsoAffects: PathNode[][];
  /** How many direct parents were left out of `alsoAffects` (the cap). */
  moreParents: number;
}

/** "Also affects" lists at most this many other parents. */
export const ALSO_AFFECTS_CAP = 20;

/** Keys a section already shows; the rest go under Evidence ▸ Other data so nothing is dropped. */
const SHOWN_KEYS = new Set([
  'description',
  'name',
  'template',
  'template_id',
  'tags',
  'cves',
  'cvss',
  'references',
  'reference',
  'remediation',
  'matched_at',
  'matcher',
  'extracted',
  'preview',
]);

// ---------------------------------------------------------------- Markdown helpers

/**
 * Keeps tool text as text: line breaks fold into spaces, the characters that start a link, image, autolink, HTML,
 * entity, emphasis, code span, strikethrough or table cell are backslash-escaped anywhere. With `blockStart` (the
 * text starts a line or a list item), a leading heading, list, quote or rule marker is escaped too. The rest (`.`,
 * `/`, `:`, `-` mid-line) stays readable.
 */
export function escapeMarkdown(text: string, blockStart = false): string {
  const inline = text
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim()
    .replace(/[\\`*_[\]<>&~|]/g, '\\$&');
  return blockStart ? inline.replace(/^([#+=-])/, '\\$1').replace(/^(\d+)([.)])/, '$1\\$2') : inline;
}

const escapeBlock = (text: string) => escapeMarkdown(text, true);
const escapeInline = (text: string) => escapeMarkdown(text);

/** A fenced code block whose fence is longer than any backtick run inside. */
export function codeBlock(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text.replace(/\r\n?/g, '\n')}\n${fence}`;
}

/** An http(s) URL as an autolink, anything else as escaped text. */
function linkOrText(raw: string): string {
  try {
    const url = new URL(raw.trim());
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !/[\s<>]/.test(url.href)) return `<${url.href}>`;
  } catch {
    // not a URL: text
  }
  return escapeBlock(raw);
}

// ---------------------------------------------------------------- data helpers

function strings(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() === '' ? [] : [v];
  if (typeof v === 'number' || typeof v === 'boolean') return [String(v)];
  if (Array.isArray(v)) return v.flatMap(strings);
  return [];
}

const first = (v: unknown): string | undefined => strings(v)[0];

function scalar(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // A list of plain values reads as a list; anything nested stays JSON.
  if (Array.isArray(v) && v.every((x) => ['string', 'number', 'boolean'].includes(typeof x))) return v.map(String).join(', ');
  return JSON.stringify(v);
}

/** nuclei stores `cvss` as a score; other tools may give `{ score, vector }` or a vector string. */
function cvssLine(v: unknown): string | null {
  if (typeof v === 'number') return `CVSS ${String(v)}`;
  if (typeof v === 'string' && v.trim() !== '') return `CVSS ${escapeMarkdown(v)}`;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const score = typeof o.score === 'number' || typeof o.score === 'string' ? String(o.score) : null;
    const vector = typeof o.vector === 'string' ? o.vector : null;
    if (score === null && vector === null) return null;
    return ['CVSS', score === null ? null : escapeMarkdown(score), vector === null ? null : `(${escapeMarkdown(vector)})`]
      .filter((p) => p !== null)
      .join(' ');
  }
  return null;
}

const SEVERITY_WORD: Record<string, string> = { info: 'Info', low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };

/** 2026-10-29T10:12:30.000Z → 2026-10-29 10:12:30 UTC */
function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? escapeMarkdown(iso) : `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

const chain = (p: PathNode[]) => p.map((n) => `${n.type} ${escapeMarkdown(n.label)}`).join(' → ');

// ---------------------------------------------------------------- the draft

/** The draft. Pure, so it's unit-tested with hand-made input. */
export function buildReport(input: ReportInput, now: Date): NodeReport {
  const { detail, path, alsoAffects, moreParents } = input;
  const node = detail.node;
  if (!isReportNodeType(node.type)) throw new Error(`no report for a ${node.type} node`);
  const type: ReportNodeType = node.type;
  const data = node.data;
  const findings = detail.observations.filter((o) => o.role === 'finding');
  const asset = path.length >= 2 ? path[path.length - 2] : undefined;

  const name = first(data.name) ?? node.label;
  const title = asset ? `${name} on ${asset.label}` : name;
  const out: string[] = [];
  const section = (heading: string, ...body: string[]) => out.push(`## ${heading}`, '', ...body, '');

  out.push(`# ${escapeMarkdown(title)}`, '');

  // Severity
  const sev = node.severity === null ? 'Not set' : (SEVERITY_WORD[node.severity] ?? node.severity);
  const cvss = cvssLine(data.cvss);
  section('Severity', `**${sev}**${cvss === null ? '' : ` · ${cvss}`}`);

  // Affected asset
  const assetLines = path.map((n, i) => `${String(i + 1)}. ${n.type}: ${escapeMarkdown(n.label)}`);
  if (alsoAffects.length > 0) {
    assetLines.push('', 'Also affects:', '');
    for (const p of alsoAffects) assetLines.push(`- ${chain(p)}`);
    if (moreParents > 0) assetLines.push(`- …and ${String(moreParents)} more`);
  }
  section('Affected asset', ...assetLines);

  // Description
  const description = first(data.description);
  const descLines: string[] = [];
  if (description !== undefined) descLines.push(escapeBlock(description));
  else if (name === node.value) descLines.push(`A ${type}: ${escapeMarkdown(node.value)}.`);
  else descLines.push(`${escapeBlock(name)} (${type} ${escapeMarkdown(node.value)}).`);
  const template = strings(data.template ?? data.template_id);
  if (template.length > 0) descLines.push('', `Template: ${template.map(escapeInline).join(', ')}`);
  const cves = strings(data.cves);
  if (cves.length > 0) descLines.push('', `CVEs: ${cves.map(escapeInline).join(', ')}`);
  const tags = strings(data.tags);
  if (tags.length > 0) descLines.push('', `Tags: ${tags.map(escapeInline).join(', ')}`);
  section('Description', ...descLines);

  // References
  const refs = strings(data.references ?? data.reference);
  section('References', ...(refs.length > 0 ? refs.map((r) => `- ${linkOrText(r)}`) : ['_None recorded._']));

  // Steps to reproduce
  const steps: string[] = [];
  const matchedAt = strings(data.matched_at);
  if (matchedAt.length > 0) steps.push('Matched at:', '', ...matchedAt.map((m) => `- ${escapeBlock(m)}`), '');
  if (findings.length === 0) steps.push('_No tool reported this node as a finding._');
  findings.forEach((o, i) => {
    steps.push(`### ${String(i + 1)}. ${escapeMarkdown(o.tool)}, ${when(o.observedAt)}`, '');
    const at = strings(o.data.matched_at);
    if (at.length > 0) steps.push(`Matched at: ${at.map(escapeInline).join(', ')}`, '');
    steps.push(codeBlock(o.command), '');
  });
  if (steps[steps.length - 1] === '') steps.pop();
  section('Steps to reproduce', ...steps);

  // Evidence
  const evidence: string[] = [];
  const matcher = strings(data.matcher);
  if (matcher.length > 0) evidence.push(`Matcher: ${matcher.map(escapeInline).join(', ')}`, '');
  const preview = strings(data.preview);
  if (preview.length > 0) evidence.push(`Preview (masked): ${preview.map(escapeInline).join(', ')}`, '');
  const extracted = strings(data.extracted);
  if (extracted.length > 0) evidence.push('Extracted values (masked):', '', codeBlock(extracted.join('\n')), '');
  const other = Object.entries(data).filter(([k]) => !SHOWN_KEYS.has(k));
  if (other.length > 0) {
    evidence.push('Other data:', '', ...other.map(([k, v]) => `- ${escapeBlock(k)}: ${escapeMarkdown(scalar(v))}`), '');
  }
  const jobs = [...new Set(findings.flatMap((o) => (o.jobId === null ? [] : [o.jobId])))].sort((a, b) => a - b);
  const files = [...new Set(findings.filter((o) => o.jobId === null).map((o) => o.scanId))];
  if (jobs.length > 0) {
    evidence.push(`The full, unmasked output is in the raw output of ${jobs.map((j) => `job ${String(j)}`).join(', ')} (local only).`);
  }
  if (files.length > 0) evidence.push(`Ingested from a file: scan ${files.map(escapeInline).join(', ')}.`);
  if (evidence.length === 0) evidence.push('_None recorded._');
  if (evidence[evidence.length - 1] === '') evidence.pop();
  section('Evidence', ...evidence);

  // Remediation
  const remediation = first(data.remediation);
  section('Remediation', remediation === undefined ? 'TODO' : escapeBlock(remediation));

  // Analyst notes: the analyst's own Markdown.
  section('Analyst notes', node.notes.trim() === '' ? '_None._' : node.notes.trim());

  // Timeline
  const tools = [...new Set(findings.map((o) => o.tool))].sort();
  section(
    'Timeline',
    `- First seen: ${when(node.firstSeen)}`,
    `- Last seen: ${when(node.lastSeen)}`,
    `- Tools: ${tools.length > 0 ? tools.map(escapeInline).join(', ') : '_none_'}`,
    `- Confidence: ${node.confidence}`,
  );

  out.push('---', '', `_Drafted by RED WHALE on ${when(now.toISOString())}._`, '');
  return { nodeId: node.id, type, label: node.label, title, markdown: out.join('\n'), generatedAt: now.toISOString() };
}

// ---------------------------------------------------------------- from the database

interface ParentRow extends PathNode {
  value: string;
}

/** Root → `startId`: breadth-first up the incoming edges, parents in value order; the first root reached wins. */
export function pathToRoot(db: Db, startId: string): PathNode[] {
  const parentsOf = db.$client.prepare(
    `SELECT n.id, n.type, n.value, n.label FROM edges e JOIN nodes n ON n.id = e.source_id
     WHERE e.target_id = ? ORDER BY n.value, n.type`,
  );
  const self = db.$client.prepare('SELECT id, type, value, label FROM nodes WHERE id = ?').get(startId) as
    | ParentRow
    | undefined;
  if (!self) return [];
  const known = new Map<string, ParentRow>([[startId, self]]);
  /** id → the child it was reached from (one step closer to the start). */
  const toward = new Map<string, string | null>([[startId, null]]);
  const queue = [startId];
  let top = startId;
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] ?? '';
    const parents = parentsOf.all(id) as ParentRow[];
    top = id;
    if (parents.length === 0) break; // a root
    for (const p of parents) {
      if (toward.has(p.id)) continue;
      toward.set(p.id, id);
      known.set(p.id, p);
      queue.push(p.id);
    }
  }
  // A rootless cycle: `top` is the last node reached.
  const path: PathNode[] = [];
  for (let id: string | null = top; id !== null; id = toward.get(id) ?? null) {
    const n = known.get(id);
    if (n) path.push({ id: n.id, type: n.type, label: n.label });
  }
  return path;
}

/** The draft for a node: null if there's no such node, 'unsupported' for a type that has no report. */
export function nodeReport(db: Db, id: string, now: Date = new Date()): NodeReport | null | 'unsupported' {
  const detail = nodeDetail(db, id);
  if (!detail) return null;
  if (!isReportNodeType(detail.node.type)) return 'unsupported';
  const path = pathToRoot(db, id);
  const mainParent = path.length >= 2 ? path[path.length - 2]?.id : undefined;
  const others = [
    ...new Map(detail.edges.filter((e) => e.direction === 'in' && e.other.id !== mainParent).map((e) => [e.other.id, e.other])).values(),
  ].sort((a, b) => a.value.localeCompare(b.value));
  const alsoAffects = others.slice(0, ALSO_AFFECTS_CAP).map((o) => pathToRoot(db, o.id));
  return buildReport({ detail, path, alsoAffects, moreParents: Math.max(0, others.length - ALSO_AFFECTS_CAP) }, now);
}
