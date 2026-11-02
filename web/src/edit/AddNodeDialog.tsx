// "Add node…" / "Add child node…": a node typed by the analyst, checked live with the contract validator's rules and
// wording, then POSTed to /api/nodes, which puts it through the normal ingest as a scan by tool `manual`.
import {
  NEEDS_SEVERITY,
  NODE_TYPES,
  SEVERITIES,
  TAGS,
  childTypesOf,
  describeManualValue,
  manualWarnings,
  parentTypesOf,
  relationsBetween,
  type ManualNodeInput,
  type NodeType,
  type Relation,
  type Severity,
  type Tag,
} from '@redwhale/shared';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '@/api/client';
import { useAddNode, useExistingNode, useParentSearch } from '@/api/edit';
import { NotesMarkdown } from '@/components/NotesMarkdown';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { TypeIcon } from './TypeIcon';

export interface NodeRef {
  id: string;
  type: NodeType;
  value: string;
  label: string;
}

export interface AddNodeDialogProps {
  /** "Add child node…": the node it hangs under (the analyst can still change or clear it). */
  parent: NodeRef | null;
  /** Where the node goes on the canvas (graph coordinates), saved like a dragged node. Null: laid out automatically. */
  position: { x: number; y: number } | null;
  /** The node was created (or linked): select it and open the path to it. */
  onDone: (id: string) => void;
  /** "Select existing node". */
  onSelectExisting: (id: string) => void;
  onClose: () => void;
}

/** The value after the analyst stops typing for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => {
      setSettled(value);
    }, ms);
    return () => {
      clearTimeout(t);
    };
  }, [value, ms]);
  return settled;
}

const input =
  'border-input bg-background focus-visible:ring-ring h-8 w-full rounded-md border px-2 text-sm outline-none focus-visible:ring-2';

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-muted-foreground text-xs font-medium">
        {label}
      </label>
      {children}
      {hint}
    </div>
  );
}

/** The type picker: a dropdown listing each type with its icon. */
function TypeSelect({ value, types, onChange }: { value: NodeType; types: readonly NodeType[]; onChange: (t: NodeType) => void }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !ref.current?.contains(e.target)) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Type"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        className={cn(input, 'flex items-center gap-2 text-left')}
        onClick={() => {
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          const i = types.indexOf(value) + (e.key === 'ArrowDown' ? 1 : -1);
          const next = types[(i + types.length) % types.length];
          if (next) onChange(next);
        }}
      >
        <TypeIcon type={value} />
        {value}
        <span className="text-muted-foreground ml-auto">▾</span>
      </button>
      {open && (
        <ul id={listId} role="listbox" aria-label="Node types" className="bg-popover absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-md border p-1 shadow-lg">
          {types.map((t) => (
            <li
              key={t}
              role="option"
              aria-selected={t === value}
              className={cn('hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm', t === value && 'bg-accent')}
              onClick={() => {
                onChange(t);
                setOpen(false);
              }}
            >
              <TypeIcon type={t} />
              {t}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Search existing nodes that can be this type's parent. */
function ParentPicker({ childType, onPick }: { childType: NodeType; onPick: (n: NodeRef) => void }) {
  const [q, setQ] = useState('');
  const types = parentTypesOf(childType);
  const search = useParentSearch(useDebounced(q, 250), types);
  if (types.length === 0) return <p className="text-muted-foreground text-xs">A {childType} has no parent type: it is a root.</p>;
  return (
    <div className="flex flex-col gap-1">
      <input
        aria-label="Search for a parent"
        className={input}
        placeholder={`Search ${types.join(', ')}…`}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
        }}
      />
      {q.trim() !== '' && (
        <ul aria-label="Parent matches" className="max-h-40 overflow-auto rounded-md border text-sm">
          {search.data?.items.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className="hover:bg-accent flex w-full items-center gap-2 px-2 py-1 text-left"
                onClick={() => {
                  onPick({ id: n.id, type: n.type, value: n.value, label: n.label });
                  setQ('');
                }}
              >
                <TypeIcon type={n.type} />
                <span className="truncate font-mono text-xs">{n.label}</span>
              </button>
            </li>
          ))}
          {search.data?.items.length === 0 && <li className="text-muted-foreground px-2 py-1 text-xs">No {types.join(' or ')} matches.</li>}
          {search.isError && <li className="px-2 py-1 text-xs text-red-600">{search.error.message}</li>}
        </ul>
      )}
    </div>
  );
}

export function AddNodeDialog({ parent: initialParent, position, onDone, onSelectExisting, onClose }: AddNodeDialogProps) {
  const titleId = useId();
  const [parent, setParent] = useState<NodeRef | null>(initialParent);
  const types = parent ? childTypesOf(parent.type) : NODE_TYPES;
  const [type, setType] = useState<NodeType>(types.at(0) ?? 'domain');
  const [value, setValue] = useState('');
  const [relation, setRelation] = useState<Relation | null>(null);
  const [severity, setSeverity] = useState<Severity | ''>('');
  const [label, setLabel] = useState('');
  const [tag, setTag] = useState<Tag | ''>('');
  const [notes, setNotes] = useState('');
  const [notesTab, setNotesTab] = useState<'edit' | 'preview'>('edit');
  const [serverIssues, setServerIssues] = useState<string[]>([]);
  const [linkResult, setLinkResult] = useState<string | null>(null);
  const add = useAddNode();
  const valueRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    valueRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const check = value === '' ? null : describeManualValue(type, value);
  const existing = useExistingNode(useDebounced(check?.ok ? check.id : null, 250));
  const found = check?.ok && existing.data && existing.data.node.id === check.id ? existing.data.node : null;

  const allowed = parent ? relationsBetween(parent.type, type) : [];
  const chosenRelation = relation !== null && allowed.includes(relation) ? relation : (allowed[0] ?? null);
  const parentProblem = parent && allowed.length === 0 ? `A ${type} can't hang under a ${parent.type}.` : null;
  const askSeverity = NEEDS_SEVERITY.includes(type);
  const finding = {
    type,
    value,
    ...(parent && chosenRelation ? { parent: { type: parent.type, value: parent.value }, relation: chosenRelation } : {}),
    ...(askSeverity && severity !== '' ? { severity } : {}),
  };
  const warnings = check?.ok ? manualWarnings(finding) : [];
  const canSubmit = check?.ok === true && found === null && parentProblem === null && !add.isPending;

  const body = (ifExists: 'return' | 'link'): ManualNodeInput => ({
    type,
    value,
    ifExists,
    ...(parent && chosenRelation ? { parentId: parent.id, relation: chosenRelation } : {}),
    ...(askSeverity && severity !== '' ? { severity } : {}),
    ...(label.trim() !== '' ? { label: label.trim() } : {}),
    ...(tag !== '' ? { tag } : {}),
    ...(notes.trim() !== '' ? { notes } : {}),
    ...(position ? { x: position.x, y: position.y } : {}),
  });

  const submit = (ifExists: 'return' | 'link') => {
    setServerIssues([]);
    setLinkResult(null);
    add.mutate(body(ifExists), {
      onSuccess: (res) => {
        if (res.created || res.linked) onDone(res.id);
        else if (ifExists === 'link') setLinkResult(`It already hangs under ${parent?.label ?? 'that parent'}.`);
        // created: false without a link: someone added it meanwhile; the exists check below now says so.
        else void existing.refetch();
      },
      onError: (e) => {
        setServerIssues(e instanceof ApiError && e.issues.length > 0 ? e.issues : [e.message]);
      },
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-background flex max-h-full w-full max-w-md flex-col gap-3 overflow-auto rounded-lg border p-4 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) submit('return');
        }}
      >
        <h2 id={titleId} className="text-sm font-semibold">
          {initialParent ? `Add child node under ${initialParent.label}` : 'Add node'}
        </h2>

        <Field label="Type">
          <TypeSelect
            value={type}
            types={types}
            onChange={(t) => {
              setType(t);
              setServerIssues([]);
            }}
          />
        </Field>

        <Field
          label="Value"
          htmlFor={`${titleId}-value`}
          hint={
            check === null ? null : check.ok ? (
              check.normalized !== value ? (
                <p className="text-muted-foreground text-xs">
                  Stored as <code className="font-mono">{check.normalized}</code>
                </p>
              ) : null
            ) : (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {check.error}
              </p>
            )
          }
        >
          <input
            ref={valueRef}
            id={`${titleId}-value`}
            className={cn(input, 'font-mono', check?.ok === false && 'border-red-500')}
            value={value}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setValue(e.target.value);
              setServerIssues([]);
              setLinkResult(null);
            }}
          />
        </Field>

        {found && (
          <div role="status" className="flex flex-col gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-xs">
            <p>
              Already in the graph as <span className="font-mono">{found.label}</span>. Nothing new will be created.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onSelectExisting(found.id);
                }}
              >
                Select existing node
              </Button>
              {parent && chosenRelation && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={add.isPending}
                  onClick={() => {
                    submit('link');
                  }}
                >
                  Add the parent link
                </Button>
              )}
            </div>
            {linkResult && <p>{linkResult}</p>}
          </div>
        )}

        <Field label="Parent (optional)">
          {parent ? (
            <div className="flex items-center gap-2 text-sm">
              <TypeIcon type={parent.type} />
              <span className="min-w-0 truncate font-mono text-xs">{parent.label}</span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => {
                  setParent(null);
                  setRelation(null);
                }}
              >
                Remove
              </Button>
            </div>
          ) : (
            <ParentPicker
              childType={type}
              onPick={(n) => {
                setParent(n);
                setRelation(null);
              }}
            />
          )}
          {parentProblem && <p className="text-xs text-red-600 dark:text-red-400">{parentProblem}</p>}
        </Field>

        {parent && allowed.length > 0 && (
          <Field label="Relation" htmlFor={`${titleId}-relation`}>
            <select
              id={`${titleId}-relation`}
              className={input}
              value={chosenRelation ?? ''}
              onChange={(e) => {
                setRelation(e.target.value as Relation);
              }}
            >
              {allowed.map((r) => (
                <option key={r} value={r}>
                  {parent.type} {r} {type}
                </option>
              ))}
            </select>
          </Field>
        )}

        {askSeverity && (
          <Field label="Severity" htmlFor={`${titleId}-severity`}>
            <select
              id={`${titleId}-severity`}
              className={input}
              value={severity}
              onChange={(e) => {
                setSeverity(e.target.value as Severity | '');
              }}
            >
              <option value="">none</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Label (optional)" htmlFor={`${titleId}-label`}>
            <input
              id={`${titleId}-label`}
              className={input}
              placeholder={check?.ok ? value : ''}
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
              }}
            />
          </Field>
          <Field label="Tag (optional)" htmlFor={`${titleId}-tag`}>
            <select
              id={`${titleId}-tag`}
              className={input}
              value={tag}
              onChange={(e) => {
                setTag(e.target.value as Tag | '');
              }}
            >
              <option value="">none</option>
              {TAGS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Notes (optional, markdown)" htmlFor={`${titleId}-notes`}>
          <div className="flex gap-1">
            {(['edit', 'preview'] as const).map((t) => (
              <Button
                key={t}
                size="sm"
                variant={notesTab === t ? 'secondary' : 'ghost'}
                aria-pressed={notesTab === t}
                className="capitalize"
                onClick={() => {
                  setNotesTab(t);
                }}
              >
                {t}
              </Button>
            ))}
          </div>
          {notesTab === 'edit' ? (
            <textarea
              id={`${titleId}-notes`}
              className={cn(input, 'h-20 py-1 font-mono text-xs')}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
              }}
            />
          ) : (
            <div className="min-h-20 rounded-md border p-2 text-sm">
              {notes.trim() === '' ? <span className="text-muted-foreground text-xs">Nothing to preview.</span> : <NotesMarkdown>{notes}</NotesMarkdown>}
            </div>
          )}
        </Field>

        {warnings.length > 0 && (
          <ul aria-label="Warnings" className="text-muted-foreground list-disc pl-4 text-xs">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
        {serverIssues.length > 0 && (
          <ul role="alert" className="list-disc pl-4 text-xs text-red-600 dark:text-red-400">
            {serverIssues.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}

        <p className="text-muted-foreground text-xs">
          Added as tool <code className="font-mono">manual</code>: it doesn&apos;t count as a tool finding it (stays
          discovered until a tool reports it too). Out-of-scope values can be added; tools still won&apos;t run on them.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {add.isPending ? 'Adding…' : 'Add node'}
          </Button>
        </div>
      </form>
    </div>
  );
}
