// Front matter: a block between --- lines at the very top of a Spec or Plan
// (closed by --- or ...), which the page doesn't show and sections skip. One
// rule for both, so they never disagree about where the document starts.
const FRONT_MATTER = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)??(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u;

/** Where front matter ends (0 when there is none). */
export function frontMatterEnd(markdown: string) {
  return FRONT_MATTER.exec(markdown)?.[0].length ?? 0;
}

/** The document without its front matter, as the page shows it. */
export function stripFrontMatter(markdown: string) {
  return markdown.slice(frontMatterEnd(markdown));
}
