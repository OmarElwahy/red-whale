// Declarative tool definitions (tools/<group>/<tool>/tool.json) and groups (tools/<group>/group.json):
// the seed of the plugin engine. Validated here, so a bad definition fails loudly at load, never mid-run.
import { TARGETABLE_TYPES, TOOL_MODES } from '@redwhale/shared';
import { z } from 'zod';

/** In an argv template, the item that becomes the target. It must be a whole item, never part of one. */
export const TARGET_PLACEHOLDER = '{target}';
/**
 * Optional, at most once, a whole item: becomes the target node's type (`domain`, `subdomain`…). A script that names
 * the target as a finding's parent needs it: the server knows the type, the script must never guess it (a wrong type
 * is another node ID, so a duplicate node).
 */
export const TARGET_TYPE_PLACEHOLDER = '{targetType}';
const PLACEHOLDERS: readonly string[] = [TARGET_PLACEHOLDER, TARGET_TYPE_PLACEHOLDER];

const slug = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'lowercase letters, digits and "-", starting with a letter');

export const toolDefSchema = z
  .object({
    /** Also the contract's `tool` field: a job whose result.json names another tool fails. */
    name: slug,
    group: slug,
    label: z.string().min(1).max(60),
    description: z.string().max(300).optional(),
    mode: z.enum(TOOL_MODES),
    /** Node types the tool can be pointed at (only targetable ones). */
    accepts: z.array(z.enum(TARGETABLE_TYPES)).min(1),
    /** The command, one argv item per entry. Never a shell string. */
    argv: z.array(z.string().min(1)).min(1),
    timeoutSec: z.number().int().min(10).max(24 * 3600),
    /** Outside services the tool contacts (shown in the UI as "external"). */
    external: z.array(z.string().min(1)),
    /**
     * What a run touches, in plain words, for the active-run confirmation: "sends HTTP(S) requests to {target} on
     * ports 80/443". Required for active and intrusive tools. Display text only, never part of a command; the only
     * placeholder is {target}, replaced by the canonical target in the UI.
     */
    contacts: z.string().min(1).max(300).optional(),
    /** Directory in the container the script writes raw.txt and result.json into. */
    outputDir: z.string().regex(/^\/[a-z0-9/_-]*$/),
  })
  .strict()
  .superRefine((def, ctx) => {
    const targets = def.argv.filter((a) => a === TARGET_PLACEHOLDER).length;
    if (targets !== 1) {
      ctx.addIssue({ code: 'custom', path: ['argv'], message: `must contain "${TARGET_PLACEHOLDER}" exactly once, as a whole item` });
    }
    if (def.argv.filter((a) => a === TARGET_TYPE_PLACEHOLDER).length > 1) {
      ctx.addIssue({ code: 'custom', path: ['argv'], message: `may contain "${TARGET_TYPE_PLACEHOLDER}" at most once, as a whole item` });
    }
    def.argv.forEach((a, i) => {
      if (!PLACEHOLDERS.includes(a) && /[{}]/.test(a)) {
        ctx.addIssue({
          code: 'custom',
          path: ['argv', i],
          message: `"${TARGET_PLACEHOLDER}" and "${TARGET_TYPE_PLACEHOLDER}" must be whole argv items; no other braces`,
        });
      }
    });
    if (def.argv[0] !== undefined && PLACEHOLDERS.includes(def.argv[0])) {
      ctx.addIssue({ code: 'custom', path: ['argv', 0], message: 'the program can not be the target or its type' });
    }
    if (def.mode !== 'passive' && def.contacts === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['contacts'],
        message: `required for ${def.mode} tools: what a run touches, e.g. "sends HTTP(S) requests to {target} on ports 80/443"`,
      });
    }
    const braces = (def.contacts ?? '').replaceAll(TARGET_PLACEHOLDER, '');
    if (/[{}]/.test(braces)) {
      ctx.addIssue({ code: 'custom', path: ['contacts'], message: `the only placeholder allowed is "${TARGET_PLACEHOLDER}"` });
    }
  });
export type ToolDef = z.infer<typeof toolDefSchema>;

export const groupDefSchema = z
  .object({
    name: slug,
    /** "subdomain enumeration": the UI says "Run group: <label>". */
    label: z.string().min(1).max(60),
    /** Image repository; the tag is the build context's hash (pnpm tools:build). */
    image: z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/),
    /** The group's tools, in run order. */
    tools: z.array(slug).min(1),
  })
  .strict();
export type GroupDef = z.infer<typeof groupDefSchema>;
