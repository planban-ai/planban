// Editing a Spec or Plan one section at a time (Spec point 20): a section is
// a heading and everything under it, up to the next heading of the same or a
// higher level. Each section has its own version (a hash of its text), so two
// agents editing different sections never clash; whole-document saves keep
// their own check. Pure functions, shared by the service and local boards.
import type { Heading } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";
import { gfm } from "micromark-extension-gfm";
import { PlanbanValidationError } from "./boardOperations";
import { frontMatterEnd } from "./frontMatter";

export interface DocSection {
  /** The heading's text, without the #s. */
  heading: string;
  level: number;
  /** Which section with this heading (0 for the first), when headings repeat. */
  occurrence: number;
  /** A short hash of the section's text, heading line included. */
  version: string;
  start: number;
  end: number;
}

/** A 64-bit hash of the text, as 16 hex digits (plain JavaScript: it also runs in the service). */
export function sectionVersion(text: string) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/**
 * The sections of a document, in order, read by the same Markdown parser
 * (with GitHub tables and the like) that shows the document on the board:
 * each top-level heading, up to the next one of the same or a higher level.
 */
export function docSections(markdown: string): DocSection[] {
  const offset = frontMatterEnd(markdown);
  const tree = fromMarkdown(markdown.slice(offset), { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const headings = tree.children
    .filter((node): node is Heading => node.type === "heading" && typeof node.position?.start.offset === "number")
    // A section starts at the beginning of its heading's line, indentation included.
    .map((node) => ({ start: lineStart(markdown, offset + node.position!.start.offset!), level: node.depth, heading: toString(node).replace(/\s+/gu, " ").trim() }));
  const seen = new Map<string, number>();
  return headings.map((entry, index) => {
    const next = headings.slice(index + 1).find((other) => other.level <= entry.level);
    const end = next ? next.start : markdown.length;
    const occurrence = seen.get(entry.heading) ?? 0;
    seen.set(entry.heading, occurrence + 1);
    return { heading: entry.heading, level: entry.level, occurrence, version: sectionVersion(markdown.slice(entry.start, end)), start: entry.start, end };
  });
}

/** Public view: what read_doc returns. */
export function sectionList(markdown: string) {
  return docSections(markdown).map(({ heading, level, occurrence, version }) => ({ heading, level, ...(occurrence ? { occurrence } : {}), version }));
}

export type SectionEdit =
  | { ok: true; markdown: string; section: { heading: string; version: string } }
  | { ok: false; reason: "changed" | "missing" | "exists"; current: { heading: string; version: string | null; text: string } };

/**
 * Replaces one section (expectedVersion from read_doc), or with
 * expectedVersion null inserts a new one after `after` (a heading) or at the
 * end. The new text starts with its own heading line. Refuses, with the
 * section as it is now, if it changed since it was read.
 */
export function editSection(markdown: string, input: { heading: string; occurrence?: number; expectedVersion: string | null; text: string; after?: string | null }): SectionEdit {
  const text = input.text.endsWith("\n") ? input.text : `${input.text}\n`;
  const opening = docSections(text)[0];
  if (!opening || opening.start !== 0) throw new PlanbanValidationError("A section starts with its heading line, such as \"## Current state\".");
  const sections = docSections(markdown);
  const matching = sections.filter((section) => section.heading === input.heading);
  const target = matching[input.occurrence ?? 0];
  if (input.expectedVersion === null) {
    if (target) return { ok: false, reason: "exists", current: { heading: target.heading, version: target.version, text: markdown.slice(target.start, target.end) } };
    const anchor = input.after ? sections.find((section) => section.heading === input.after) : undefined;
    if (input.after && !anchor) throw new PlanbanValidationError(`No section called "${input.after}" to insert after.`);
    const at = anchor ? anchor.end : markdown.length;
    const before = markdown.slice(0, at);
    const after = markdown.slice(at);
    // A blank line before the new section, and after it when something follows.
    const separator = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const body = after && !text.endsWith("\n\n") ? `${text}\n` : text;
    const joined = `${before}${separator}${body}${after}`;
    const at2 = before.length + separator.length;
    assertOthersUnchanged(markdown, [at, at], joined, [at2, at2 + body.length], opening.heading);
    return { ok: true, markdown: joined, section: sectionAt(joined, at2, input.heading) };
  }
  if (!target) return { ok: false, reason: "missing", current: { heading: input.heading, version: null, text: "" } };
  if (matching.length > 1 && input.occurrence === undefined) {
    throw new PlanbanValidationError(`There are ${matching.length} sections called "${input.heading}". Say which with occurrence (0 for the first).`);
  }
  const current = markdown.slice(target.start, target.end);
  if (target.version !== input.expectedVersion) return { ok: false, reason: "changed", current: { heading: target.heading, version: target.version, text: current } };
  // Keep the blank line that separated it from the next section.
  const trailing = /\n\s*$/u.exec(current)?.[0] ?? "";
  const replacement = trailing.length > 1 && !text.endsWith("\n\n") ? `${text}\n` : text;
  const result = `${markdown.slice(0, target.start)}${replacement}${markdown.slice(target.end)}`;
  assertOthersUnchanged(markdown, [target.start, target.end], result, [target.start, target.start + replacement.length], opening.heading);
  return { ok: true, markdown: result, section: sectionAt(result, target.start, input.heading) };
}

/** The section that starts at `start` in a document, as the next read will report it. */
function sectionAt(markdown: string, start: number, heading: string) {
  const found = docSections(markdown).find((section) => section.start === start) ?? docSections(markdown).find((section) => section.heading === heading);
  return { heading: found?.heading ?? heading, version: found?.version ?? sectionVersion("") };
}

/** The start of the line holding `at`; a line ends at \n, \r\n or a lone \r. */
function lineStart(markdown: string, at: number) {
  return Math.max(markdown.lastIndexOf("\n", at - 1), markdown.lastIndexOf("\r", at - 1)) + 1;
}

/**
 * Each heading's own text (up to the next heading of any level), for the
 * headings outside [start, end), in order. Own text, so a parent that gains
 * a new subsection doesn't count as changed; trailing blank lines don't count.
 */
function outside(markdown: string, start: number, end: number) {
  const sections = docSections(markdown);
  return sections.filter((section) => section.start < start || section.start >= end).map((section) => {
    const next = sections.find((other) => other.start > section.start);
    return `${section.heading}\u0000${markdown.slice(section.start, next ? next.start : markdown.length).replace(/\s+$/u, "")}`;
  });
}

/**
 * The guard behind every section edit: all other sections are exactly as they
 * were. If they aren't (a document the reader can't split cleanly), nothing
 * is written and the whole-document write is the way.
 */
function assertOthersUnchanged(before: string, beforeRange: [number, number], after: string, afterRange: [number, number], heading: string) {
  const was = outside(before, ...beforeRange);
  const is = outside(after, ...afterRange);
  // The opening (front matter and anything before the first heading) is as it was, and still opening.
  const opening = (markdown: string) => `${frontMatterEnd(markdown)}\u0000${markdown.slice(0, docSections(markdown)[0]?.start ?? markdown.length)}`;
  const openingKept = opening(before) === opening(after) || (docSections(before).length === 0 && after.startsWith(before.replace(/\s+$/u, "")) && frontMatterEnd(after) === frontMatterEnd(before));
  // And the edited or added section is still there, where it was written.
  const edited = docSections(after).some((section) => section.start === afterRange[0] && section.heading === heading);
  if (!openingKept || !edited || was.length !== is.length || was.some((entry, index) => entry !== is[index])) {
    throw new PlanbanValidationError("This edit would change other sections too, so it wasn't made. Write the whole document instead (planban_write_doc).");
  }
}
