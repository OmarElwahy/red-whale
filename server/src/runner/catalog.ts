// Loads the tool definitions from tools/ (docs/architecture.md §11): one folder per group (group.json,
// Dockerfile) with one folder per tool (tool.json, run.py, fixtures/). Validated as a whole: a bad or inconsistent
// definition is a startup error naming every problem, never a surprise mid-run.
//
// Each group's image is tagged with a hash of exactly the files that go into it (its build context), so the
// server can tell "built", "outdated" (scripts changed since the build) and "missing" apart.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupDefSchema, toolDefSchema, type GroupDef, type ToolDef } from './defs';
import type { ToolCatalog } from './orchestrator';
import type { ContainerRuntime } from './runtime';

export const TOOLS_DIR = fileURLToPath(new URL('../../../tools', import.meta.url));

export const LABEL_GROUP = 'redwhale.group';
export const LABEL_CONTEXT = 'redwhale.context';

export type ImageStatus = 'built' | 'outdated' | 'missing' | 'unknown';

export interface GroupInfo {
  def: GroupDef;
  tools: ToolDef[];
  /** Dockerfile path inside the build context (tools/). */
  dockerfile: string;
  /** Files sent to the build, relative to tools/, '/'-separated, sorted. */
  contextFiles: string[];
  contextHash: string;
  /** repo:tag of the image these files make. */
  imageRef: string;
}

export class CatalogError extends Error {
  constructor(readonly issues: string[]) {
    super(`tool definitions in tools/ are invalid:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'CatalogError';
  }
}

/** Mirrors tools/.dockerignore: what never goes into an image (and so doesn't change its hash). */
export function inBuildContext(relPath: string): boolean {
  const parts = relPath.split('/');
  const base = parts.at(-1) ?? '';
  if (parts.some((p) => p === 'fixtures' || p === 'tests' || p === '__pycache__')) return false;
  return !(/^test_.*\.py$/.test(base) || base === 'README.md' || base === 'NOTE.md' || base.endsWith('.pyc'));
}

function walk(root: string, rel: string): string[] {
  return readdirSync(join(root, rel), { withFileTypes: true })
    .flatMap((e) => {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) return walk(root, path);
      return e.isFile() ? [path] : [];
    })
    .filter(inBuildContext);
}

/** sha256 over each file's path and content hash, in the given order: a build context's identity. */
export function hashFiles(root: string, files: readonly string[]): string {
  const h = createHash('sha256');
  for (const f of files) {
    h.update(`${f}\0${createHash('sha256').update(readFileSync(join(root, f))).digest('hex')}\n`);
  }
  return h.digest('hex');
}

function readJson(path: string, issues: string[]): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    issues.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

export class Catalog implements ToolCatalog {
  private readonly byGroup: Map<string, GroupInfo>;
  private readonly byTool: Map<string, ToolDef>;

  constructor(readonly groups: GroupInfo[]) {
    this.byGroup = new Map(groups.map((g) => [g.def.name, g]));
    this.byTool = new Map(groups.flatMap((g) => g.tools.map((t) => [t.name, t] as const)));
  }

  tool(name: string): ToolDef | undefined {
    return this.byTool.get(name);
  }

  group(name: string): GroupDef | undefined {
    return this.byGroup.get(name)?.def;
  }

  info(name: string): GroupInfo | undefined {
    return this.byGroup.get(name);
  }

  imageRef(group: string): string {
    const info = this.byGroup.get(group);
    if (!info) throw new Error(`unknown tool group '${group}'`);
    return info.imageRef;
  }

  /** Every tool, groups in folder order, tools in each group's run order. */
  tools(): ToolDef[] {
    return this.groups.flatMap((g) => g.tools);
  }
}

/** Reads and checks every group under `dir`. Throws CatalogError listing all problems. */
export function loadCatalog(dir: string = TOOLS_DIR): Catalog {
  const issues: string[] = [];
  const groups: GroupInfo[] = [];
  const seenTools = new Map<string, string>();

  const groupDirs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'group.json')))
    .map((e) => e.name)
    .sort();

  for (const name of groupDirs) {
    const where = `tools/${name}`;
    const parsed = groupDefSchema.safeParse(readJson(join(dir, name, 'group.json'), issues));
    if (!parsed.success) {
      issues.push(...parsed.error.issues.map((i) => `${where}/group.json: ${i.path.join('.')}: ${i.message}`));
      continue;
    }
    const group = parsed.data;
    if (group.name !== name) issues.push(`${where}/group.json: name '${group.name}' must be the folder name '${name}'`);
    if (!existsSync(join(dir, name, 'Dockerfile'))) issues.push(`${where}: no Dockerfile`);

    const toolDirs = readdirSync(join(dir, name), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, name, e.name, 'tool.json')))
      .map((e) => e.name);
    const tools: ToolDef[] = [];
    for (const toolName of group.tools) {
      if (!toolDirs.includes(toolName)) {
        issues.push(`${where}/group.json lists '${toolName}', but there is no ${where}/${toolName}/tool.json`);
        continue;
      }
      const toolWhere = `${where}/${toolName}/tool.json`;
      const def = toolDefSchema.safeParse(readJson(join(dir, name, toolName, 'tool.json'), issues));
      if (!def.success) {
        issues.push(...def.error.issues.map((i) => `${toolWhere}: ${i.path.join('.')}: ${i.message}`));
        continue;
      }
      if (def.data.name !== toolName) issues.push(`${toolWhere}: name '${def.data.name}' must be the folder name '${toolName}'`);
      if (def.data.group !== name) issues.push(`${toolWhere}: group '${def.data.group}' must be '${name}'`);
      const other = seenTools.get(def.data.name);
      if (other !== undefined) issues.push(`${toolWhere}: tool name '${def.data.name}' is already used in tools/${other}`);
      seenTools.set(def.data.name, name);
      tools.push(def.data);
    }
    for (const toolName of toolDirs) {
      if (!group.tools.includes(toolName)) issues.push(`${where}/${toolName} has a tool.json but ${where}/group.json doesn't list it`);
    }

    const contextFiles = ['.dockerignore', 'validate_output.py', ...walk(dir, 'lib'), ...walk(dir, name)]
      .filter((f) => existsSync(join(dir, f)) && statSync(join(dir, f)).isFile())
      .sort();
    const contextHash = hashFiles(dir, contextFiles);
    groups.push({
      def: group,
      tools,
      dockerfile: `${name}/Dockerfile`,
      contextFiles,
      contextHash,
      imageRef: `${group.image}:${contextHash.slice(0, 12)}`,
    });
  }

  if (issues.length > 0) throw new CatalogError(issues);
  return new Catalog(groups);
}

/** built = this exact build exists; outdated = an older build of the group exists; missing = none; unknown = no Docker. */
export async function imageStatus(runtime: ContainerRuntime, info: GroupInfo): Promise<ImageStatus> {
  try {
    if (await runtime.inspectImage(info.imageRef)) return 'built';
    return (await runtime.listImages(LABEL_GROUP, info.def.name)).length > 0 ? 'outdated' : 'missing';
  } catch {
    return 'unknown';
  }
}
