// The board's goals on the page (owner decisions, 16 October 2026): a quiet
// line above the columns that opens the Goals page, and the page itself, where
// people add, reword, drag to reorder and retire goals, write the Context,
// restore retired goals, and accept or dismiss an agent's suggestion.
import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, ChevronDown, ChevronRight, ChevronUp, GripVertical, Pencil, Plus } from "lucide-react";
import { boardPath } from "./apiPaths";

export interface PageGoal {
  number: number;
  id: string;
  statement: string;
  notes: string;
}

export interface GoalsPageData {
  goals: PageGoal[];
  context: string;
  retired: Array<{ id: string; statement: string; retiredAt: string }>;
  suggestions: Array<{ id: string; summary: string; reason: string; by: string; createdAt: string }>;
  recentlyDismissed: Array<{ summary: string; dismissedAt: string }>;
  revision: number;
}

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

/** The board's goals, read again whenever the board's revision moves (every goals change is one). */
export function useGoals(boardId: string, revision: number, request: Request) {
  const [goals, setGoals] = useState<GoalsPageData | null>(null);
  useEffect(() => {
    let current = true;
    request<GoalsPageData>(boardPath(boardId, "/goals")).then((page) => { if (current) setGoals(page); }, () => undefined);
    return () => { current = false; };
  }, [boardId, revision, request]);
  return [goals, setGoals] as const;
}

const FOLDED_KEY = "planban.goals.folded";

function readFolded() {
  try {
    return window.localStorage.getItem(FOLDED_KEY) === "1";
  } catch {
    return false;
  }
}

/** One quiet line above the columns, foldable to "Goals (n)" (remembered on this device); on a phone, one row. */
export function GoalsStrip({ goals, phone, onOpen }: { goals: PageGoal[]; phone: boolean; onOpen: () => void }) {
  const [folded, setFolded] = useState(readFolded);
  if (!goals.length) return null;
  const fold = (value: boolean) => {
    setFolded(value);
    try {
      window.localStorage.setItem(FOLDED_KEY, value ? "1" : "0");
    } catch {
      // Not remembered; it still folds now.
    }
  };
  if (phone) {
    return (
      <button className="goals-row" onClick={onOpen} aria-label={`Goals (${goals.length}): open the Goals page`}>
        Goals ({goals.length})<ChevronRight size={15} aria-hidden="true" />
      </button>
    );
  }
  if (folded) {
    return (
      <div className="goals-strip folded">
        <button className="goals-strip-label" onClick={() => fold(false)} aria-expanded="false">
          Goals ({goals.length})<ChevronDown size={13} aria-hidden="true" />
        </button>
      </div>
    );
  }
  return (
    <div className="goals-strip">
      <button className="goals-strip-label" onClick={() => fold(true)} aria-expanded="true" aria-label="Fold the goals line">
        Goals<ChevronUp size={13} aria-hidden="true" />
      </button>
      <button className="goals-strip-list" onClick={onOpen} title="Open the Goals page">
        {goals.map((goal, index) => (
          <React.Fragment key={goal.id}>
            {index ? <span className="sep" aria-hidden="true">·</span> : null}
            <span className="n">{goal.number}.</span>{goal.statement}
          </React.Fragment>
        ))}
      </button>
      <button className="goals-strip-open" onClick={onOpen}>Open</button>
    </div>
  );
}

const formatDate = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
};

/**
 * The Goals page. People change goals here; viewers read them. Every change
 * states the revision it was based on, so a change to the same goal made
 * meanwhile by someone else is refused and shown, never overwritten.
 */
export function GoalsPage({ boardId, boardTitle, viewOnly, phone, request, initial, onBack }: {
  boardId: string;
  boardTitle: string;
  viewOnly: boolean;
  phone: boolean;
  request: Request;
  initial: GoalsPageData | null;
  onBack: () => void;
}) {
  const [page, setPage] = useState<GoalsPageData | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // An open form remembers the revision and wording it opened with: its save is checked
  // against what the person saw, so a live refresh meanwhile can't hide someone else's change.
  const [editing, setEditing] = useState<{ id: string; revision: number; statement: string; notes: string } | null>(null);
  const [contextBase, setContextBase] = useState<{ revision: number; context: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [openNotes, setOpenNotes] = useState<Set<string>>(() => new Set(initial?.goals[0]?.notes && !phone ? [initial.goals[0].id] : []));
  const [retiredOpen, setRetiredOpen] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 3 } }));

  const reload = async () => {
    const fresh = await request<GoalsPageData>(boardPath(boardId, "/goals")).catch(() => null);
    if (fresh) setPage(fresh);
    return fresh;
  };
  useEffect(() => { if (!page) void reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (initial && (!page || initial.revision > page.revision)) setPage(initial); }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Sends one change; true when it was saved. A refusal is shown and the page reads the goals again. */
  /** `form` names the open form this save came from: only that one is rebased if it is refused. */
  const send = async (path: string, body: Record<string, unknown>, baseRevision?: number, form?: "goal" | "context") => {
    if (!page) return false;
    setBusy(true);
    setError(null);
    try {
      setPage(await request<GoalsPageData>(boardPath(boardId, path), { method: "POST", body: JSON.stringify({ ...body, baseRevision: baseRevision ?? page.revision }) }));
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Not saved.");
      // The message says what changed meanwhile; an open form now starts from that, keeping what was typed,
      // so saving again is the person's deliberate choice rather than a repeat refusal.
      const fresh = await reload();
      if (fresh && form === "goal") {
        setEditing((open) => {
          const now = open && fresh.goals.find((goal) => goal.id === open.id);
          return open && now ? { id: open.id, revision: fresh.revision, statement: now.statement, notes: now.notes } : open;
        });
      }
      if (fresh && form === "context") setContextBase((open) => (open ? { revision: fresh.revision, context: fresh.context } : open));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const edit = (change: Record<string, unknown>, baseRevision?: number, form?: "goal" | "context") => send("/goals", { edit: change }, baseRevision, form);

  const onDragEnd = (event: DragEndEvent) => {
    if (!page || !event.over || event.active.id === event.over.id) return;
    const ids = page.goals.map((goal) => goal.id);
    const moved = arrayMove(ids, ids.indexOf(String(event.active.id)), ids.indexOf(String(event.over.id)));
    const at = moved.indexOf(String(event.active.id));
    // Shown in its new place at once; the move goes after its new neighbour, so it never clashes.
    setPage({ ...page, goals: moved.map((id, index) => ({ ...page.goals.find((goal) => goal.id === id)!, number: index + 1 })) });
    void edit({ kind: "move", goalId: event.active.id, afterId: at === 0 ? null : moved[at - 1] });
  };

  const toggleNotes = (id: string) => setOpenNotes((open) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <main className={`goals-screen ${phone ? "phone" : ""}`}>
      <header className="goals-head">
        <button className="icon-button" aria-label="Back to the board" onClick={onBack}><ArrowLeft size={16} /></button>
        <div>
          <p className="goals-eyebrow">{boardTitle}</p>
          <h1>Goals</h1>
        </div>
      </header>
      <div className="goals-body">
        {error ? <p className="goals-error" role="alert">{error}</p> : null}
        <section className="goals-shell" aria-label="Goals">
          {!viewOnly && page?.suggestions.map((suggestion) => (
            <div className="goals-notice" key={suggestion.id}>
              <span><b>{suggestion.by} suggests:</b> {suggestion.summary}. Why: {suggestion.reason}</span>
              <span className="goals-notice-actions">
                <button className="goals-btn sm" disabled={busy} onClick={() => void send(`/goals/suggestions/${encodeURIComponent(suggestion.id)}`, { decision: "dismiss" })}>Dismiss</button>
                <button className="goals-btn sm primary" disabled={busy} onClick={() => void send(`/goals/suggestions/${encodeURIComponent(suggestion.id)}`, { decision: "accept" })}>Accept</button>
              </span>
            </div>
          ))}
          <div className="goals-section-head"><h2>{phone ? "Goals" : "Goals, most important first"}</h2></div>
          {page === null ? <p className="goals-empty">Loading the goals…</p> : null}
          {page && !page.goals.length ? (
            <p className="goals-empty">No goals yet. {viewOnly ? "" : "Add the project's goals, most important first. Agents weigh work against them when suggesting what comes next; they never reorder the board."}</p>
          ) : null}
          {page ? (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={page.goals.map((goal) => goal.id)} strategy={verticalListSortingStrategy}>
                <ol className="goals-list">
                  {page.goals.map((goal) => (
                    <GoalRow
                      key={goal.id}
                      goal={goal}
                      viewOnly={viewOnly}
                      busy={busy}
                      editing={editing?.id === goal.id}
                      base={editing?.id === goal.id ? editing : null}
                      notesOpen={openNotes.has(goal.id)}
                      onToggleNotes={() => toggleNotes(goal.id)}
                      onEdit={() => { setEditing({ id: goal.id, revision: page.revision, statement: goal.statement, notes: goal.notes }); setAdding(false); }}
                      onCancel={() => setEditing(null)}
                      onSave={async (statement, notes) => {
                        const base = editing!;
                        // Only what the person changed from what they opened is sent.
                        if (statement === base.statement && notes === base.notes) { setEditing(null); return; }
                        if (await edit({ kind: "reword", goalId: goal.id, ...(statement !== base.statement ? { statement } : {}), ...(notes !== base.notes ? { notes } : {}) }, base.revision, "goal")) setEditing(null);
                      }}
                      onRetire={async () => { if (await edit({ kind: "retire", goalId: goal.id }, editing!.revision, "goal")) setEditing(null); }}
                    />
                  ))}
                </ol>
              </SortableContext>
            </DndContext>
          ) : null}
          {page && !viewOnly ? (adding ? (
            <GoalForm
              busy={busy}
              initialStatement=""
              initialNotes=""
              submitLabel="Add"
              onCancel={() => setAdding(false)}
              onSave={async (statement, notes) => { if (await edit({ kind: "add", statement, ...(notes ? { notes } : {}) })) setAdding(false); }}
            />
          ) : (
            <button className="goals-add" onClick={() => { setAdding(true); setEditing(null); }}><Plus size={15} aria-hidden="true" />Add a goal</button>
          )) : null}
        </section>

        {page && (page.context || !viewOnly) ? (
          <section className="goals-shell" aria-label="Context">
            <div className="goals-section-head">
              <h2>Context</h2>
              {!viewOnly && !contextBase ? <button className="icon-button" aria-label="Edit the context" onClick={() => setContextBase({ revision: page.revision, context: page.context })}><Pencil size={14} /></button> : null}
            </div>
            {contextBase ? (
              <ContextForm busy={busy} initial={contextBase.context} onCancel={() => setContextBase(null)} onSave={async (context) => {
                if (context.trim() === contextBase.context.trim()) { setContextBase(null); return; }
                if (await edit({ kind: "context", context }, contextBase.revision, "context")) setContextBase(null);
              }} />
            ) : page.context ? (
              <div className="goals-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{page.context}</ReactMarkdown></div>
            ) : (
              <p className="goals-empty">Everything that isn't a goal: the ambition, constraints, and the minimum that must stay healthy.</p>
            )}
          </section>
        ) : null}

        {page?.retired.length ? (
          <section className="goals-shell" aria-label="Retired goals">
            <button className="goals-retired-toggle" aria-expanded={retiredOpen} onClick={() => setRetiredOpen(!retiredOpen)}>
              {retiredOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}Retired ({page.retired.length})
            </button>
            {retiredOpen ? (
              <ul className="goals-retired">
                {page.retired.map((goal) => (
                  <li key={goal.id}>
                    <s>{goal.statement}</s>
                    <span className="when">Retired {formatDate(goal.retiredAt)}</span>
                    {!viewOnly ? <button className="goals-link" disabled={busy} onClick={() => void edit({ kind: "restore", goalId: goal.id })}>Restore</button> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </div>
    </main>
  );
}

function GoalRow({ goal, base, viewOnly, busy, editing, notesOpen, onToggleNotes, onEdit, onCancel, onSave, onRetire }: {
  goal: PageGoal;
  /** What the open form started from (the revision the person read). */
  base: { statement: string; notes: string } | null;
  viewOnly: boolean;
  busy: boolean;
  editing: boolean;
  notesOpen: boolean;
  onToggleNotes: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (statement: string, notes: string) => Promise<void>;
  onRetire: () => Promise<void>;
}) {
  const sortable = useSortable({ id: goal.id, disabled: viewOnly || editing });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  return (
    <li ref={sortable.setNodeRef} style={style} className={`goal-row ${editing ? "editing" : ""} ${sortable.isDragging ? "dragging" : ""}`}>
      {viewOnly ? <span className="goal-grip" aria-hidden="true" /> : (
        <button className="goal-grip" aria-label={`Drag to reorder "${goal.statement}"`} {...sortable.attributes} {...sortable.listeners}>
          <GripVertical size={15} aria-hidden="true" />
        </button>
      )}
      <span className="goal-number">{goal.number}.</span>
      {editing ? (
        <GoalForm busy={busy} initialStatement={base?.statement ?? goal.statement} initialNotes={base?.notes ?? goal.notes} submitLabel="Save" onCancel={onCancel} onSave={onSave} onRetire={onRetire} />
      ) : (
        <>
          {viewOnly ? <span className="goal-statement">{goal.statement}</span> : (
            <button className="goal-statement" onClick={onEdit} title="Reword this goal">{goal.statement}</button>
          )}
          {goal.notes ? (
            <button className="goal-notes-toggle" aria-expanded={notesOpen} onClick={onToggleNotes}>
              {notesOpen ? "Hide notes" : "Notes"}{notesOpen ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
            </button>
          ) : <span />}
          {goal.notes && notesOpen ? <div className="goal-notes">{goal.notes.split("\n").map((line, index) => <p key={index}>{line}</p>)}</div> : null}
        </>
      )}
    </li>
  );
}

function GoalForm({ busy, initialStatement, initialNotes, submitLabel, onCancel, onSave, onRetire }: {
  busy: boolean;
  initialStatement: string;
  initialNotes: string;
  submitLabel: string;
  onCancel: () => void;
  onSave: (statement: string, notes: string) => Promise<void>;
  onRetire?: () => Promise<void>;
}) {
  const [statement, setStatement] = useState(initialStatement);
  const [notes, setNotes] = useState(initialNotes);
  // A field the person hasn't touched follows the version the form is based on, if that moves.
  const touched = useRef({ statement: false, notes: false });
  useEffect(() => { if (!touched.current.statement) setStatement(initialStatement); }, [initialStatement]);
  useEffect(() => { if (!touched.current.notes) setNotes(initialNotes); }, [initialNotes]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const save = () => { if (statement.trim()) void onSave(statement.trim(), notes.trim()); };
  return (
    <form className="goal-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <input
        ref={input}
        className="goal-field statement"
        value={statement}
        maxLength={200}
        placeholder="The goal, in one line"
        aria-label="Goal"
        onChange={(event) => { touched.current.statement = true; setStatement(event.target.value); }}
        onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}
      />
      <label className="goal-field-label">
        Notes
        <textarea className="goal-field notes" value={notes} placeholder="Optional: what it means in practice" onChange={(event) => { touched.current.notes = true; setNotes(event.target.value); }} />
      </label>
      <div className="goal-edit-bar">
        <button type="submit" className="goals-btn sm primary" disabled={busy || !statement.trim()}>{submitLabel}</button>
        <button type="button" className="goals-btn sm" onClick={onCancel}>Cancel</button>
        {onRetire ? <button type="button" className="goal-retire" disabled={busy} onClick={() => void onRetire()}>Retire</button> : null}
      </div>
    </form>
  );
}

function ContextForm({ busy, initial, onCancel, onSave }: { busy: boolean; initial: string; onCancel: () => void; onSave: (context: string) => Promise<void> }) {
  const [context, setContext] = useState(initial);
  const touched = useRef(false);
  useEffect(() => { if (!touched.current) setContext(initial); }, [initial]);
  return (
    <form className="goal-form context" onSubmit={(event) => { event.preventDefault(); void onSave(context); }}>
      <textarea className="goal-field notes context" aria-label="Context" autoFocus value={context} onChange={(event) => { touched.current = true; setContext(event.target.value); }} />
      <div className="goal-edit-bar">
        <button type="submit" className="goals-btn sm primary" disabled={busy}>Save</button>
        <button type="button" className="goals-btn sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
