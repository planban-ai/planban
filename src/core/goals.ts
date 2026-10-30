// A board's goals (owner decisions, 16 October 2026): an ordered list of
// one-line goals with optional notes, one free-text Context section, and the
// goals retired from it. People change goals; agents can only suggest a change,
// which a person accepts or dismisses. Goals are never linked to cards and
// never reorder anything. Shared by boards on a computer and the online
// service, so it uses no Node-only modules.
import { PlanbanConflictError, PlanbanNotFoundError, PlanbanValidationError } from "./boardOperations";
import { checkIndexText } from "./contentRules";

export const MAX_GOALS = 20;
export const MAX_STATEMENT_CHARS = 200;
export const MAX_NOTES_BYTES = 8 * 1024;
export const MAX_CONTEXT_BYTES = 32 * 1024;
export const MAX_OPEN_SUGGESTIONS = 10;
export const MAX_REASON_CHARS = 500;
/** A dismissed suggestion isn't shown again, if identical, for this long. */
export const DISMISSED_FOR_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Goal {
  id: string;
  statement: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface RetiredGoal extends Goal {
  retiredAt: string;
}

/** What an agent may suggest. A person's own edits can also restore, move by neighbour and change the context. */
export type GoalChange =
  | { kind: "add"; statement: string; notes?: string | undefined; position?: number | undefined }
  | { kind: "reword"; goalId: string; statement?: string | undefined; notes?: string | undefined }
  | { kind: "reorder"; goalId: string; position: number }
  | { kind: "retire"; goalId: string };

export type GoalEdit =
  | GoalChange
  | { kind: "move"; goalId: string; afterId: string | null }
  | { kind: "restore"; goalId: string }
  | { kind: "context"; context: string };

export interface GoalSuggestion {
  id: string;
  change: GoalChange;
  reason: string;
  /** Who suggested it, as people read it: "Claude (Sam)". */
  by: string;
  createdAt: string;
  /** In words: 'add "Win back lapsed clubs" as goal 4'. */
  summary: string;
  fingerprint: string;
}

export interface DismissedSuggestion {
  fingerprint: string;
  summary: string;
  reason: string;
  by: string;
  dismissedAt: string;
  dismissedBy: string;
}

/** For each part of the goals, the board revision that last changed it and who did. */
export type GoalFieldChanges = Record<string, { revision: number; by: string; at: string }>;

export interface GoalsFile {
  version: 1;
  goals: Goal[];
  retired: RetiredGoal[];
  context: string;
  suggestions: GoalSuggestion[];
  dismissed: DismissedSuggestion[];
  changed: GoalFieldChanges;
  nextNumber: number;
}

export function emptyGoals(): GoalsFile {
  return { version: 1, goals: [], retired: [], context: "", suggestions: [], dismissed: [], changed: {}, nextNumber: 1 };
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Reads stored goals leniently: anything unrecognised is left out rather than breaking the board. */
export function normalizeGoals(input: unknown): GoalsFile {
  if (!input || typeof input !== "object") return emptyGoals();
  const raw = input as Partial<GoalsFile>;
  const goal = (value: unknown): Goal | null => {
    const entry = value as Partial<Goal> | null;
    if (!entry || typeof entry.id !== "string" || typeof entry.statement !== "string") return null;
    return { id: entry.id, statement: entry.statement, notes: text(entry.notes), createdAt: text(entry.createdAt), updatedAt: text(entry.updatedAt) };
  };
  const goals = (Array.isArray(raw.goals) ? raw.goals : []).map(goal).filter((entry): entry is Goal => !!entry);
  const retired = (Array.isArray(raw.retired) ? raw.retired : [])
    .map((value) => { const entry = goal(value); return entry ? { ...entry, retiredAt: text((value as RetiredGoal).retiredAt) } : null; })
    .filter((entry): entry is RetiredGoal => !!entry);
  const numbers = [...goals, ...retired].map((entry) => Number(/^g(\d+)$/.exec(entry.id)?.[1] ?? 0));
  return {
    version: 1, goals, retired, context: text(raw.context),
    suggestions: (Array.isArray(raw.suggestions) ? raw.suggestions : []).filter((entry) => entry && typeof entry.id === "string" && entry.change),
    dismissed: (Array.isArray(raw.dismissed) ? raw.dismissed : []).filter((entry) => entry && typeof entry.fingerprint === "string"),
    changed: raw.changed && typeof raw.changed === "object" ? raw.changed : {},
    nextNumber: Math.max(typeof raw.nextNumber === "number" ? raw.nextNumber : 1, ...numbers.map((n) => n + 1)),
  };
}

export const hasGoals = (file: GoalsFile) => file.goals.length > 0;

/** All of a board's goals, stored, stay small: text only, like the rest of the board. */
export const MAX_GOALS_BYTES = 256 * 1024;

/** The goals stay within their size limit; a change that would pass it is refused, never trimmed. */
export function assertGoalsSize(file: GoalsFile) {
  if (new TextEncoder().encode(JSON.stringify(file)).length > MAX_GOALS_BYTES) {
    throw new PlanbanValidationError("The board's goals are too large to keep. Shorten some notes or the context, or remove long retired goals' notes.");
  }
}

/** Goals arriving from elsewhere (a board taken online): tidied, and checked as text only and within size. */
export function checkedGoals(input: unknown): GoalsFile {
  const file = normalizeGoals(input);
  for (const goal of [...file.goals, ...file.retired]) {
    checkIndexText(goal.statement, "A goal", MAX_STATEMENT_CHARS * 4);
    checkIndexText(goal.notes, "A goal's notes", MAX_NOTES_BYTES);
  }
  checkIndexText(file.context, "The goals' context", MAX_CONTEXT_BYTES);
  if (new TextEncoder().encode(JSON.stringify(file)).length > MAX_GOALS_BYTES) throw new PlanbanValidationError("The board's goals are too large to keep.");
  return file;
}

/**
 * The short Goals block in board reads for agents: numbered statements only,
 * and only when the board has goals.
 */
export function goalsBlock(file: GoalsFile): string | null {
  if (!hasGoals(file)) return null;
  return [
    "Goals, most important first:",
    ...file.goals.map((goal, index) => `${index + 1}. ${goal.statement}`),
    "Read the Goals page for notes and context (planban_read_goals). Only people change goals.",
  ].join("\n");
}

/** The page as people and agents read it. Dismissed suggestions are the recent ones only. */
export function goalsPage(file: GoalsFile, now = new Date()) {
  const since = now.getTime() - DISMISSED_FOR_DAYS * DAY_MS;
  return {
    goals: file.goals.map((goal, index) => ({ number: index + 1, ...goal })),
    context: file.context,
    retired: file.retired,
    suggestions: file.suggestions.map(({ fingerprint: _f, ...rest }) => rest),
    recentlyDismissed: file.dismissed.filter((entry) => Date.parse(entry.dismissedAt) >= since).map(({ fingerprint: _f, ...rest }) => rest),
  };
}
export type GoalsPage = ReturnType<typeof goalsPage>;

function oneLine(value: unknown, what: string): string {
  const line = text(value).replace(/\s+/g, " ").trim();
  if (!line) throw new PlanbanValidationError(`${what} can't be empty.`);
  if (line.length > MAX_STATEMENT_CHARS) throw new PlanbanValidationError(`${what} is one line of at most ${MAX_STATEMENT_CHARS} characters. Put the rest in its notes.`);
  checkIndexText(line, what, MAX_STATEMENT_CHARS * 4);
  return line;
}

function notesText(value: unknown, what: string): string {
  const notes = text(value).replace(/\r\n?/g, "\n").trim();
  checkIndexText(notes, what, MAX_NOTES_BYTES);
  return notes;
}

/** A goal on the page by its id, or by its number in the list ("2"). */
export function findGoal(file: GoalsFile, ref: unknown): Goal {
  const key = String(ref ?? "").trim();
  const byNumber = /^\d+$/.test(key) ? file.goals[Number(key) - 1] : undefined;
  const found = byNumber ?? file.goals.find((goal) => goal.id === key);
  if (found) return found;
  if (file.retired.some((goal) => goal.id === key)) throw new PlanbanValidationError(`That goal is retired. Restore it first.`);
  throw new PlanbanNotFoundError(`Goal not found: ${key || "(none given)"}. Name a goal by its number on the Goals page or its id.`);
}

const quoted = (statement: string) => `"${statement}"`;

/** Checks and tidies a change; the goal it names becomes its id. */
export function parseGoalChange(file: GoalsFile, input: unknown, forAgent = false): GoalChange {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const kind = raw.kind;
  const position = (value: unknown, max: number) => {
    if (value === undefined || value === null || value === "") return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new PlanbanValidationError("position is a goal number: 1 for the top.");
    return Math.min(n, max);
  };
  // Where an added goal goes is kept as asked and placed when it is applied: suggestions for
  // goals 1 to 4 on an empty board, accepted in order, end up as goals 1 to 4.
  if (kind === "add") {
    const notes = raw.notes === undefined ? undefined : notesText(raw.notes, "The goal's notes");
    return { kind, statement: oneLine(raw.statement, "A goal"), ...(notes ? { notes } : {}), ...(raw.position !== undefined ? { position: position(raw.position, MAX_GOALS) } : {}) };
  }
  if (kind === "reword") {
    const goal = findGoal(file, raw.goalId ?? raw.goal);
    const statement = raw.statement === undefined ? undefined : oneLine(raw.statement, "A goal");
    const notes = raw.notes === undefined || raw.notes === null ? undefined : notesText(raw.notes, "The goal's notes");
    if (statement === undefined && notes === undefined) throw new PlanbanValidationError("Give the goal's new wording, its new notes, or both.");
    return { kind, goalId: goal.id, ...(statement !== undefined ? { statement } : {}), ...(notes !== undefined ? { notes } : {}) };
  }
  if (kind === "reorder") {
    const goal = findGoal(file, raw.goalId ?? raw.goal);
    const to = position(raw.position, file.goals.length);
    if (to === undefined) throw new PlanbanValidationError("Say which position the goal moves to: 1 for the top.");
    return { kind, goalId: goal.id, position: to };
  }
  if (kind === "retire") return { kind, goalId: findGoal(file, raw.goalId ?? raw.goal).id };
  throw new PlanbanValidationError(forAgent
    ? "kind is add, reword, reorder or retire."
    : "kind is add, reword, reorder, move, retire, restore or context.");
}

/** The same suggestion means the same change: same kind, goal, wording and position. */
export function changeFingerprint(change: GoalChange): string {
  const norm = (value: string | undefined) => (value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  switch (change.kind) {
    case "add": return `add|${norm(change.statement)}`;
    case "reword": return `reword|${change.goalId}|${norm(change.statement)}|${norm(change.notes)}`;
    case "reorder": return `reorder|${change.goalId}|${change.position}`;
    case "retire": return `retire|${change.goalId}`;
  }
}

export function describeChange(file: GoalsFile, change: GoalChange): string {
  const goalName = (id: string) => {
    const index = file.goals.findIndex((goal) => goal.id === id);
    return index < 0 ? "a goal" : `goal ${index + 1}, ${quoted(file.goals[index]!.statement)}`;
  };
  switch (change.kind) {
    case "add": return `add ${quoted(change.statement)}${change.position ? ` as goal ${change.position}` : ""}`;
    case "reword": return change.statement ? `reword ${goalName(change.goalId)} to ${quoted(change.statement)}` : `change the notes of ${goalName(change.goalId)}`;
    case "reorder": return `move ${goalName(change.goalId)} to position ${change.position}`;
    case "retire": return `retire ${goalName(change.goalId)}`;
  }
}

interface Stamp {
  /** The board revision this change makes. */
  revision: number;
  /** The revision the change was based on: the one its author read. */
  baseRevision?: number | undefined;
  by: string;
  now: string;
}

/**
 * Like any field: an edit is refused only if a part it changes was changed
 * by someone else since its author read the board, and to something else.
 */
function guard(file: GoalsFile, field: string, mine: unknown, theirs: unknown, stamp: Stamp, what: string) {
  const last = file.changed[field];
  if (stamp.baseRevision === undefined || !last || last.revision <= stamp.baseRevision) return;
  if (JSON.stringify(mine) === JSON.stringify(theirs)) return;
  throw new PlanbanConflictError(`Not saved: ${what} was changed by ${last.by} since you read it${theirs === undefined ? "" : `. It is now: ${typeof theirs === "string" ? quoted(theirs) : JSON.stringify(theirs)}`}. Look at the Goals page again and decide whether your change is still needed.`);
}

function mark(file: GoalsFile, field: string, stamp: Stamp) {
  file.changed[field] = { revision: stamp.revision, by: stamp.by, at: stamp.now };
}

const clone = (file: GoalsFile): GoalsFile => JSON.parse(JSON.stringify(file)) as GoalsFile;

/** Applies a person's edit. Returns the new goals and a one-line history summary. */
export function applyGoalEdit(fileInput: GoalsFile, editInput: unknown, stamp: Stamp): { goals: GoalsFile; summary: string } {
  const file = clone(fileInput);
  const raw = (editInput && typeof editInput === "object" ? editInput : {}) as Record<string, unknown>;
  if (raw.kind === "context") {
    const context = text(raw.context).replace(/\r\n?/g, "\n").trim();
    checkIndexText(context, "The goals' context", MAX_CONTEXT_BYTES);
    guard(file, "context", context, file.context, stamp, "the goals' context");
    file.context = context;
    mark(file, "context", stamp);
    return { goals: file, summary: "Goals: changed the context" };
  }
  if (raw.kind === "restore") {
    const id = String(raw.goalId ?? "");
    const index = file.retired.findIndex((goal) => goal.id === id);
    if (index < 0) {
      if (file.goals.some((goal) => goal.id === id)) return { goals: file, summary: "Goals: already restored" };
      throw new PlanbanNotFoundError(`Retired goal not found: ${id}`);
    }
    if (file.goals.length >= MAX_GOALS) throw new PlanbanValidationError(`A board has at most ${MAX_GOALS} goals. Retire one first.`);
    const [{ retiredAt: _retiredAt, ...goal }] = file.retired.splice(index, 1) as [RetiredGoal];
    file.goals.push({ ...goal, updatedAt: stamp.now });
    mark(file, `goal:${id}:state`, stamp);
    return { goals: file, summary: `Goals: restored ${quoted(goal.statement)}` };
  }
  if (raw.kind === "move") {
    const goal = findGoal(file, raw.goalId);
    // Moves never clash: the goal goes after its new neighbour, or to the top; if that neighbour has gone, to the end.
    const rest = file.goals.filter((entry) => entry.id !== goal.id);
    const afterId = raw.afterId === null || raw.afterId === undefined || raw.afterId === "" ? null : String(raw.afterId);
    const at = afterId === null ? 0 : rest.findIndex((entry) => entry.id === afterId) + 1 || rest.length;
    rest.splice(at, 0, goal);
    file.goals = rest;
    return { goals: file, summary: `Goals: moved ${quoted(goal.statement)} to position ${at + 1}` };
  }
  return applyChange(file, parseGoalChange(file, raw), stamp);
}

function applyChange(file: GoalsFile, change: GoalChange, stamp: Stamp): { goals: GoalsFile; summary: string } {
  switch (change.kind) {
    case "add": {
      if (file.goals.length >= MAX_GOALS) throw new PlanbanValidationError(`A board has at most ${MAX_GOALS} goals. Retire one first.`);
      const goal: Goal = { id: `g${file.nextNumber}`, statement: change.statement, notes: change.notes ?? "", createdAt: stamp.now, updatedAt: stamp.now };
      file.nextNumber += 1;
      const at = change.position ? Math.min(change.position - 1, file.goals.length) : file.goals.length;
      file.goals.splice(at, 0, goal);
      return { goals: file, summary: `Goals: added ${quoted(goal.statement)} as goal ${at + 1}` };
    }
    case "reword": {
      const goal = file.goals.find((entry) => entry.id === change.goalId)!;
      const before = goal.statement;
      if (change.statement !== undefined && change.statement !== goal.statement) {
        guard(file, `goal:${goal.id}:statement`, change.statement, goal.statement, stamp, `goal ${quoted(before)}`);
        goal.statement = change.statement;
        mark(file, `goal:${goal.id}:statement`, stamp);
      }
      if (change.notes !== undefined && change.notes !== goal.notes) {
        guard(file, `goal:${goal.id}:notes`, change.notes, goal.notes, stamp, `the notes of goal ${quoted(before)}`);
        goal.notes = change.notes;
        mark(file, `goal:${goal.id}:notes`, stamp);
      }
      goal.updatedAt = stamp.now;
      return { goals: file, summary: goal.statement === before ? `Goals: changed the notes of ${quoted(before)}` : `Goals: reworded ${quoted(before)} to ${quoted(goal.statement)}` };
    }
    case "reorder": {
      const goal = file.goals.find((entry) => entry.id === change.goalId)!;
      const rest = file.goals.filter((entry) => entry.id !== goal.id);
      rest.splice(Math.min(change.position - 1, rest.length), 0, goal);
      file.goals = rest;
      return { goals: file, summary: `Goals: moved ${quoted(goal.statement)} to position ${change.position}` };
    }
    case "retire": {
      const index = file.goals.findIndex((entry) => entry.id === change.goalId);
      const [goal] = file.goals.splice(index, 1) as [Goal];
      // Every retired goal stays restorable; the goals' overall size limit is what bounds the list.
      file.retired = [{ ...goal, retiredAt: stamp.now }, ...file.retired];
      mark(file, `goal:${goal.id}:state`, stamp);
      return { goals: file, summary: `Goals: retired ${quoted(goal.statement)}` };
    }
  }
}

const dropExpired = (file: GoalsFile, now: string) => {
  const since = Date.parse(now) - DISMISSED_FOR_DAYS * DAY_MS;
  // Kept for their full 30 days; the goals' size limit is what bounds them.
  file.dismissed = file.dismissed.filter((entry) => Date.parse(entry.dismissedAt) >= since);
};

/**
 * An agent suggests one change, with its reason. An identical one already
 * waiting, or dismissed in the last 30 days, isn't added again; the answer says why.
 */
export function addSuggestion(fileInput: GoalsFile, input: { change: unknown; reason: unknown }, stamp: Stamp & { id: string }):
  { goals: GoalsFile; summary: string; suggestion: Omit<GoalSuggestion, "fingerprint"> } | { goals: null; notAdded: string } {
  const file = clone(fileInput);
  dropExpired(file, stamp.now);
  const change = parseGoalChange(file, input.change, true);
  const reason = text(input.reason).replace(/\s+/g, " ").trim();
  if (!reason) throw new PlanbanValidationError("Give the reason for the suggestion: the evidence a person can check, in a sentence or two.");
  if (reason.length > MAX_REASON_CHARS) throw new PlanbanValidationError(`Keep the reason to ${MAX_REASON_CHARS} characters.`);
  checkIndexText(reason, "The suggestion's reason", MAX_REASON_CHARS * 4);
  const fingerprint = changeFingerprint(change);
  const waiting = file.suggestions.find((entry) => entry.fingerprint === fingerprint);
  if (waiting) return { goals: null, notAdded: `The same suggestion is already waiting on the Goals page (from ${waiting.by}). Nothing was added.` };
  const dismissed = file.dismissed.find((entry) => entry.fingerprint === fingerprint);
  if (dismissed) {
    return { goals: null, notAdded: `The same suggestion was dismissed on ${dismissed.dismissedAt.slice(0, 10)} by ${dismissed.dismissedBy}, so it isn't shown again until 30 days after that. Suggest it again only if something new has happened, and say what.` };
  }
  if (file.suggestions.length >= MAX_OPEN_SUGGESTIONS) throw new PlanbanValidationError(`${MAX_OPEN_SUGGESTIONS} suggestions are already waiting for the person. Wait until they have looked at them.`);
  const summary = describeChange(file, change);
  const suggestion: GoalSuggestion = { id: stamp.id, change, reason, by: stamp.by, createdAt: stamp.now, summary, fingerprint };
  file.suggestions.push(suggestion);
  const { fingerprint: _f, ...shown } = suggestion;
  return { goals: file, summary: `Goals: ${stamp.by} suggested to ${summary}`, suggestion: shown };
}

/** A person accepts (the change is made, as theirs) or dismisses (remembered for 30 days) a suggestion. */
export function decideSuggestion(fileInput: GoalsFile, input: { suggestionId: unknown; decision: unknown }, stamp: Stamp): { goals: GoalsFile; summary: string } {
  const file = clone(fileInput);
  dropExpired(file, stamp.now);
  const id = String(input.suggestionId ?? "");
  const index = file.suggestions.findIndex((entry) => entry.id === id);
  if (index < 0) throw new PlanbanNotFoundError("That suggestion is no longer waiting: someone may have decided it already.");
  const [suggestion] = file.suggestions.splice(index, 1) as [GoalSuggestion];
  if (input.decision === "dismiss") {
    file.dismissed.unshift({ fingerprint: suggestion.fingerprint, summary: suggestion.summary, reason: suggestion.reason, by: suggestion.by, dismissedAt: stamp.now, dismissedBy: stamp.by });
    return { goals: file, summary: `Goals: dismissed ${suggestion.by}'s suggestion to ${suggestion.summary}` };
  }
  if (input.decision !== "accept") throw new PlanbanValidationError("decision is accept or dismiss.");
  // Checked against the goals as they are now (the goal it names may have been retired meanwhile),
  // and like any edit against what the person read: a part changed since then is a clash.
  const applied = applyChange(file, parseGoalChange(file, suggestion.change, true), stamp);
  return { goals: applied.goals, summary: `${applied.summary} (${suggestion.by}'s suggestion, accepted)` };
}

/** Only people change goals, by every route; agents suggest. */
export const PEOPLE_ONLY = "Only people change a board's goals. An agent asks the person in chat first, and with their agreement (or in an unattended run, with no person in the conversation) can suggest a change, with a reason, for them to accept or dismiss: planban_suggest_goal_change.";

/**
 * The Planban protocol's Goals section, shortened (owner decisions, 16 October
 * 2026): the remote server's instructions, and the end of the Goals page as
 * agents read it, where they look when weighing goals.
 */
export const GOALS_GUIDANCE = "Goals: a board may have goals, most important first (planban_get_board lists them; planban_read_goals adds notes and context). Treat them as judgement, not rules. When recommending or ranking work, prefer what serves the goals and name the goal in a few words; urgency, blockers, size and what the person asked can outweigh goal order. Work outside the goals is fine: never refuse, delay or argue against it because no goal covers it, and don't tag cards by goal. Do what the person asked. When asked what's next or to review priorities, glance at recent history: if chosen work keeps landing outside the goals, a goal has seen no work for weeks, the person keeps choosing differently from your goal-based suggestions, or a goal looks out of date, say so briefly in chat with that evidence and ask whether the goals still say what they want, offering to suggest a change (ask even if you think the goals are right); leave one (planban_suggest_goal_change) only if they agree, or if no person is in the conversation (an unattended run). Don't repeat a dismissed one unless something new has happened. Only people change goals. No goals: rank as usual without mentioning goals, and don't ask for them unless the person is planning priorities.";

/** The whole Goals page as text, for agents (both MCP servers and the command line). */
export function goalsPageText(page: GoalsPage): string {
  const lines: string[] = [];
  if (!page.goals.length) lines.push("This board has no goals.");
  else {
    lines.push("Goals, most important first:");
    for (const goal of page.goals) {
      lines.push(`${goal.number}. ${goal.statement} (id ${goal.id})`);
      if (goal.notes) lines.push(...goal.notes.split("\n").map((line) => `   ${line}`));
    }
  }
  if (page.context) lines.push("", "Context:", page.context);
  if (page.suggestions.length) {
    lines.push("", "Suggestions waiting for the person:");
    for (const entry of page.suggestions) lines.push(`- ${entry.by}, ${entry.createdAt.slice(0, 10)}: ${entry.summary}. Why: ${entry.reason}`);
  }
  if (page.recentlyDismissed.length) {
    lines.push("", "Dismissed in the last 30 days (don't suggest these again unless something new has happened):");
    for (const entry of page.recentlyDismissed) lines.push(`- ${entry.summary}, dismissed ${entry.dismissedAt.slice(0, 10)}. Its reason was: ${entry.reason}`);
  }
  if (page.retired.length) lines.push("", `Retired: ${page.retired.map((goal) => `${goal.statement} (${goal.retiredAt.slice(0, 10)})`).join("; ")}`);
  if (page.goals.length) lines.push("", GOALS_GUIDANCE);
  return lines.join("\n");
}
