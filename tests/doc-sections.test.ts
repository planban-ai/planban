// Editing a Spec or Plan one section at a time (Spec point 20).
import assert from "node:assert/strict";
import test from "node:test";
import { docSections, editSection, sectionList } from "../src/core/docSections";
import { stripFrontMatter } from "../src/core/frontMatter";

const doc = "# Spec\n\n## Purpose\n\nWhy.\n\n## Current state\n\nNow.\n\n### Detail\n\nMore.\n\n## Agent reference\n\nLinks.\n";

test("sections run to the next heading of the same or a higher level", () => {
  const list = sectionList(doc);
  assert.deepEqual(list.map((section) => [section.heading, section.level]), [["Spec", 1], ["Purpose", 2], ["Current state", 2], ["Detail", 3], ["Agent reference", 2]]);
  const current = docSections(doc).find((section) => section.heading === "Current state")!;
  assert.equal(doc.slice(current.start, current.end), "## Current state\n\nNow.\n\n### Detail\n\nMore.\n\n");
});

test("headings inside code are not sections", () => {
  assert.deepEqual(sectionList("## A\n\n```\n## not a heading\n```\n").map((section) => section.heading), ["A"]);
});

test("different sections never clash; the same section does, with what it is now", () => {
  const purpose = sectionList(doc).find((section) => section.heading === "Purpose")!.version;
  const state = sectionList(doc).find((section) => section.heading === "Current state")!.version;
  const first = editSection(doc, { heading: "Purpose", expectedVersion: purpose, text: "## Purpose\n\nWhy, sharper." });
  assert.ok(first.ok);
  // Another agent, from the same read, edits a different section: no clash.
  const second = editSection(first.markdown, { heading: "Current state", expectedVersion: state, text: "## Current state\n\nNow, updated." });
  assert.ok(second.ok);
  assert.match(second.markdown, /Why, sharper\./);
  assert.match(second.markdown, /Now, updated\./);
  // The same section from the old read: a clash, with the section as it is now.
  const third = editSection(second.markdown, { heading: "Purpose", expectedVersion: purpose, text: "## Purpose\n\nWhy, my way." });
  assert.equal(third.ok, false);
  assert.ok(!third.ok && third.reason === "changed" && third.current.text.includes("Why, sharper."));
});

test("a new section goes after a named one, or at the end; adding one that exists is a clash", () => {
  const added = editSection(doc, { heading: "Risks", expectedVersion: null, text: "## Risks\n\nNone yet.", after: "Purpose" });
  assert.ok(added.ok);
  assert.deepEqual(sectionList(added.markdown).map((section) => section.heading), ["Spec", "Purpose", "Risks", "Current state", "Detail", "Agent reference"]);
  const atEnd = editSection(doc, { heading: "Notes", expectedVersion: null, text: "## Notes\n\nLast." });
  assert.ok(atEnd.ok && atEnd.markdown.endsWith("## Notes\n\nLast.\n"));
  assert.equal(editSection(doc, { heading: "Purpose", expectedVersion: null, text: "## Purpose\n\nAgain." }).ok, false);
});

test("underlined headings are sections too, so replacing one never swallows the next", () => {
  const md = "## A\nold A\n\nB\n---\nold B\n";
  assert.deepEqual(sectionList(md).map((section) => [section.heading, section.level]), [["A", 2], ["B", 2]]);
  const a = sectionList(md)[0]!.version;
  const edited = editSection(md, { heading: "A", expectedVersion: a, text: "## A\nnew A\n" });
  assert.ok(edited.ok && edited.markdown.includes("old B"));
  // A line of dashes after a blank line is a rule, not a heading.
  assert.deepEqual(sectionList("## A\n\n---\n\ntext\n").map((section) => section.heading), ["A"]);
});

test("Windows line endings, longer fences, and a heading that ends in #", () => {
  assert.deepEqual(sectionList("## A\r\nx\r\n## B\r\ny\r\n").map((section) => section.heading), ["A", "B"]);
  assert.deepEqual(sectionList("````\n## not\n```\n## still not\n````\n## Real\n").map((section) => section.heading), ["Real"]);
  assert.deepEqual(sectionList("## C#\n## Closed ##\n").map((section) => section.heading), ["C#", "Closed"]);
});

test("a new section's returned version is the one the next read reports", () => {
  const md = "## A\n\nOne.\n\n## B\n\nTwo.\n";
  const added = editSection(md, { heading: "C", expectedVersion: null, text: "## C\n\nThree.", after: "A" });
  assert.ok(added.ok);
  assert.equal(added.section.version, sectionList(added.markdown).find((section) => section.heading === "C")!.version);
  const replaced = editSection(added.markdown, { heading: "C", expectedVersion: added.section.version, text: "## C\n\nThree, again." });
  assert.ok(replaced.ok);
  assert.equal(replaced.section.version, sectionList(replaced.markdown).find((section) => section.heading === "C")!.version);
});

test("a heading underlined across lines starts at its first line; lists, tables and front matter are never headings", () => {
  const md = "## A\n\nOne.\n\nFirst line\nsecond line\n---\n\nBody.\n";
  const list = sectionList(md);
  assert.deepEqual(list.map((section) => section.heading), ["A", "First line second line"]);
  const edited = editSection(md, { heading: "A", expectedVersion: list[0]!.version, text: "## A\n\nOne, edited.\n" });
  assert.ok(edited.ok && edited.markdown.includes("First line\nsecond line\n---"));
  assert.deepEqual(sectionList("## A\n\n- item\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n---\n").map((section) => section.heading), ["A"]);
  assert.deepEqual(sectionList("---\ntitle: x\nstatus: draft\n---\n\n## Purpose\n\nWhy.\n").map((section) => section.heading), ["Purpose"]);
});

test("a rule before a heading stays a rule, and prose with a | can be a heading", () => {
  assert.deepEqual(sectionList("***\nHeading\n---\n\nBody.\n").map((section) => section.heading), ["Heading"]);
  const md = "## A\n\nOne.\n\nA | B\n---\n\nTwo.\n";
  const list = sectionList(md);
  assert.deepEqual(list.map((section) => section.heading), ["A", "A | B"]);
  const edited = editSection(md, { heading: "A", expectedVersion: list[0]!.version, text: "## A\n\nOne, edited.\n" });
  assert.ok(edited.ok && edited.markdown.includes("A | B\n---\n\nTwo."));
});

test("tables and rules are read exactly as the board shows them", () => {
  // Not a table (one column needs a header with a |): an underlined heading.
  assert.deepEqual(sectionList("Header\n| --- |\n---\n").map((section) => section.heading), []);
  assert.deepEqual(sectionList("Intro\nA | B\n--- | ---\n---\n").map((section) => section.heading), []);
  assert.deepEqual(sectionList("A | B\n| --- |\n---\n").map((section) => section.heading), ["A | B | --- |"]);
  assert.deepEqual(sectionList("Intro\n***\nHeading\n---\n").map((section) => section.heading), ["Heading"]);
});

test("indented headings keep their whole line, and empty front matter never swallows a section", () => {
  const md = "  ## A\nOne.\n  ## B\nTwo.\n";
  const [a, b] = docSections(md);
  assert.equal(md.slice(a!.start, a!.end), "  ## A\nOne.\n");
  assert.equal(md.slice(b!.start, b!.end), "  ## B\nTwo.\n");
  assert.ok(editSection(md, { heading: "A", expectedVersion: a!.version, text: "  ## A\nnew\n" }).ok);
  assert.deepEqual(sectionList("---\n---\n\n## A\n\n---\n\n## B\n").map((section) => section.heading), ["A", "B"]);
  // The page strips the same front matter, with any line endings and either closing.
  assert.equal(stripFrontMatter("---\r\ntitle: x\r\n...\r\n# Doc\r\n"), "# Doc\r\n");
  assert.equal(stripFrontMatter("---\n---\n\n## A\n"), "\n## A\n");
});

test("old Mac line endings split sections too, and no section edit ever changes another section", () => {
  const md = "## A\rOne.\r## B\rTwo.\r";
  const [a, b] = docSections(md);
  assert.deepEqual([a!.start, b!.start], [0, 10]);
  const edited = editSection(md, { heading: "B", expectedVersion: b!.version, text: "## B\rTwo, edited.\r" });
  assert.ok(edited.ok && edited.markdown.startsWith("## A\rOne.\r"));
  // A replacement that would itself break the next section's heading is refused, not written.
  const doc = "## A\n\nOne.\n\n## B\n\nTwo.\n";
  const first = docSections(doc)[0]!;
  assert.throws(() => editSection(doc, { heading: "A", expectedVersion: first.version, text: "## A\n\nOne\n\n```\n" }), /would change other sections too/);
});

test("a section edit can't turn the document's opening into hidden front matter", () => {
  const md = "---\n\nPreamble that must stay visible.\n\n## A\n\nOld.\n\n## B\n\nKeep.\n";
  const a = docSections(md).find((section) => section.heading === "A")!;
  assert.throws(() => editSection(md, { heading: "A", expectedVersion: a.version, text: "## A\n\n---\n\nNew.\n" }), /would change other sections too/);
  // An ordinary rule inside a section is fine when nothing above could become front matter.
  const plain = "# Doc\n\n## A\n\nOld.\n\n## B\n\nKeep.\n";
  const pa = docSections(plain).find((section) => section.heading === "A")!;
  assert.ok(editSection(plain, { heading: "A", expectedVersion: pa.version, text: "## A\n\n---\n\nNew.\n" }).ok);
});
