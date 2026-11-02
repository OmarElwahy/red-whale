// Declarative tool definitions (tools/<group>/<tool>/tool.json) and groups (tools/<group>/group.json):
// the seed of the plugin engine. Validated here, so a bad definition fails loudly at load, never mid-run.
import { TARGETABLE_TYPES, TOOL_MODES } from '@redwhale/shared';
import { z } from 'zod';

/** In an argv template, the item that becomes the target. It must be a whole item, never part of one. */
export const TARGET_PLACEHOLDER = '{target}';

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
    /** Directory in the container the script writes raw.txt and result.json into. */
    outputDir: z.string().regex(/^\/[a-z0-9/_-]*$/),
  })
  .strict()
  .superRefine((def, ctx) => {
    const targets = def.argv.filter((a) => a === TARGET_PLACEHOLDER).length;
    if (targets !== 1) {
      ctx.addIssue({ code: 'custom', path: ['argv'], message: `must contain "${TARGET_PLACEHOLDER}" exactly once, as a whole item` });
    }
    def.argv.forEach((a, i) => {
      if (a !== TARGET_PLACEHOLDER && /[{}]/.test(a)) {
        ctx.addIssue({ code: 'custom', path: ['argv', i], message: `"${TARGET_PLACEHOLDER}" must be a whole argv item; no other braces` });
      }
    });
    if (def.argv[0] === TARGET_PLACEHOLDER) {
      ctx.addIssue({ code: 'custom', path: ['argv', 0], message: 'the program can not be the target' });
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
