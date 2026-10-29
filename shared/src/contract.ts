// Zod schema for the tool-output contract v1 (docs/contract.md).
// Rejects exactly what tools/validate_output.py reports as ERROR; its warnings live in lint.ts.
import { z } from 'zod';
import { CONTRACT_VERSION, NODE_TYPES, RELATIONS, RELATION_TYPES, SCAN_STATUSES, SEVERITIES } from './enums';
import { lintContract } from './lint';
import { checkValue } from './values';

// The documented form only: 2026-10-29T10:00:00Z, optionally with a fraction of a second.
// (Python's datetime.fromisoformat also accepts other ISO shapes; we deliberately don't.)
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

/** Returns a key that sorts chronologically, or null if `value` is not a valid contract timestamp. */
export function timestampKey(value: string): string | null {
  const m = TIMESTAMP_RE.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number, number, number, number, number, number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  const realDate = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!realDate || hour > 23 || minute > 59 || second > 59) return null;
  return `${value.slice(0, 19)}.${(m[7] ?? '').padEnd(20, '0')}`;
}

type Issue = { code: string; input?: unknown };

/** Error message for a top-level field: missing vs. wrong type. */
function fieldError(name: string, typeName: string) {
  return (iss: Issue) =>
    iss.input === undefined ? `missing required field '${name}'` : `'${name}' must be of type ${typeName}`;
}

function timestamp(name: string, example: string) {
  return z.string({ error: fieldError(name, 'str') }).refine((s) => timestampKey(s) !== null, {
    message: `'${name}' must be ISO 8601 UTC ending in Z, e.g. ${example}`,
  });
}

const typeList = NODE_TYPES.join(', ');

export const parentSchema = z.strictObject(
  {
    type: z.enum(NODE_TYPES, {
      error: (iss) => `parent type '${String(iss.input)}' is not a valid node type`,
    }),
    value: z.string({
      error: (iss) =>
        iss.input === undefined
          ? `'parent' must be exactly {"type": ..., "value": ...}`
          : 'value must be a non-empty string',
    }),
  },
  { error: () => `'parent' must be exactly {"type": ..., "value": ...}` },
);

export const findingSchema = z
  .strictObject(
    {
      type: z.enum(NODE_TYPES, {
        error: (iss) => `type '${String(iss.input)}' is not one of ${typeList}`,
      }),
      value: z.string({ error: 'value must be a non-empty string' }),
      // Python treats an explicit null parent/relation the same as an absent one.
      parent: parentSchema.nullish(),
      relation: z
        .enum(RELATION_TYPES, {
          error: (iss) => `relation '${String(iss.input)}' is not one of ${RELATION_TYPES.join(', ')}`,
        })
        .nullish(),
      severity: z.enum(SEVERITIES, { error: `severity must be one of ${SEVERITIES.join(', ')}` }).optional(),
      data: z.record(z.string(), z.unknown(), { error: "'data' must be an object" }).optional(),
    },
    {
      error: (iss) => {
        if (iss.code === 'unrecognized_keys') {
          return iss.keys
            .map((k) =>
              k === 'id'
                ? 'do not create IDs; the server generates them'
                : `unknown field '${k}' (put extra details inside 'data')`,
            )
            .join('; ');
        }
        return 'must be an object';
      },
    },
  )
  .superRefine((f, ctx) => {
    const valueError = checkValue(f.type, f.value);
    if (valueError) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: `${f.type} value '${f.value}' ${valueError}` });
    }

    const { parent, relation } = f;
    if (parent == null) {
      if (relation != null) {
        ctx.addIssue({ code: 'custom', path: ['relation'], message: "has 'relation' but no 'parent'" });
      }
      return;
    }

    const parentError = checkValue(parent.type, parent.value);
    if (parentError) {
      ctx.addIssue({
        code: 'custom',
        path: ['parent', 'value'],
        message: `parent ${parent.type} value '${parent.value}' ${parentError}`,
      });
    }

    if (relation == null) {
      ctx.addIssue({ code: 'custom', path: ['relation'], message: "has 'parent' but no 'relation'" });
      return;
    }
    const rule = RELATIONS[relation];
    if (!rule.parents.includes(parent.type) || !rule.children.includes(f.type)) {
      ctx.addIssue({
        code: 'custom',
        path: ['relation'],
        message:
          `'${relation}' can't link ${parent.type} -> ${f.type} ` +
          `(allowed: ${rule.parents.join(', ')} -> ${rule.children.join(', ')})`,
      });
    }
  });

export const contractFileSchema = z
  .strictObject(
    {
      contract_version: z.literal(CONTRACT_VERSION, {
        error: (iss) =>
          iss.input === undefined
            ? "missing required field 'contract_version'"
            : `contract_version must be ${String(CONTRACT_VERSION)}`,
      }),
      tool: z
        .string({ error: fieldError('tool', 'str') })
        .refine((s) => s === s.toLowerCase(), { message: "'tool' must be lowercase" }),
      tool_version: z.string({ error: "'tool_version' must be of type str" }).optional(),
      target: z.string({ error: fieldError('target', 'str') }),
      command: z.string({ error: fieldError('command', 'str') }),
      started_at: timestamp('started_at', '2026-10-29T10:00:00Z'),
      finished_at: timestamp('finished_at', '2026-10-29T10:01:00Z'),
      status: z.enum(SCAN_STATUSES, {
        error: (iss) =>
          iss.input === undefined
            ? "missing required field 'status'"
            : `'status' must be one of ${SCAN_STATUSES.join(', ')}`,
      }),
      errors: z.array(z.string({ error: "'errors' must be a list of strings" }), {
        error: fieldError('errors', 'list'),
      }),
      findings: z.array(findingSchema, { error: fieldError('findings', 'list') }),
    },
    {
      error: (iss) => {
        if (iss.code === 'unrecognized_keys') {
          return iss.keys.map((k) => `unknown top-level field '${k}'`).join('; ');
        }
        return 'top level must be a JSON object';
      },
    },
  )
  .superRefine((doc, ctx) => {
    const start = timestampKey(doc.started_at);
    const end = timestampKey(doc.finished_at);
    if (start !== null && end !== null && end < start) {
      ctx.addIssue({ code: 'custom', path: ['finished_at'], message: "'finished_at' is before 'started_at'" });
    }
  });

export type ContractFile = z.infer<typeof contractFileSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type FindingParent = z.infer<typeof parentSchema>;

/** Formats a Zod path like the Python validator: findings[3].parent.value */
function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((seg, i) => (typeof seg === 'number' ? `[${String(seg)}]` : `${i === 0 ? '' : '.'}${String(seg)}`))
    .join('');
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = formatPath(issue.path);
    return where ? `${where}: ${issue.message}` : issue.message;
  });
}

export type ValidationResult =
  | { ok: true; data: ContractFile; warnings: string[] }
  | { ok: false; errors: string[] };

/** Validates parsed JSON against contract v1. Errors reject the file; warnings don't. */
export function validateContract(input: unknown): ValidationResult {
  const result = contractFileSchema.safeParse(input);
  if (!result.success) return { ok: false, errors: formatIssues(result.error) };
  return { ok: true, data: result.data, warnings: lintContract(result.data) };
}
