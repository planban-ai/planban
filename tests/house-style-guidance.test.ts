import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildAgentContext } from "../src/core/protocol";

const repoRoot = process.cwd();

function source(path: string) {
  return readFileSync(join(repoRoot, path), "utf8");
}

test("the bundled Planban house style is the single runtime authoring reference", () => {
  const houseStyle = source("plugins/planban/skills/planban/references/planban-house-style.md");
  const protocol = source("plugins/planban/skills/planban/references/planban-protocol.md");
  const createSkill = source("plugins/planban/skills/planban-create/SKILL.md");

  for (const heading of ["## Information locations and ownership", "### Summary", "### Next action", "### Spec", "### Plan"]) {
    assert.match(houseStyle, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(protocol, /read `planban-house-style\.md` completely/u);
  assert.match(createSkill, /read\s+`\.\.\/planban\/references\/planban-house-style\.md` completely/u);
});

test("the house style keeps volatile facts out of Summary and Next action", () => {
  const houseStyle = source("plugins/planban/skills/planban/references/planban-house-style.md");
  const required = houseStyle.slice(houseStyle.indexOf("## Required rules"), houseStyle.indexOf("## Recommended rules"));

  assert.match(required, /### Volatile facts in Summary and Next action/u);
  assert.match(required, /Do not put volatile facts in the Summary or Next action/u);
  assert.match(required, /PR numbers may appear as references/u);
  assert.match(required, /name the coordinating Item \(`planban:<board>\/<item>`\)/u);
  assert.match(required, /Keep exact IDs, SHAs, releases, and test counts out of the opening of either field/u);
  assert.match(required, /start the Next action with `Owner:`, and use that prefix only then\./u);
  assert.match(required, /### Tags and metadata\r?\n\r?\n- Use metadata for small, stable identifiers\./u);
});

test("the status protocol makes a landing a card event", () => {
  const landing = /landing is a card event: whoever merges a PR, pushes to a release branch or\s+retires a branch updates every In Progress Item that names it, before reporting the\s+landing/iu;
  const context = buildAgentContext({
    planningRoot: "/tmp/planban/repos/example",
    roadmapPath: "/tmp/planban/repos/example/roadmap.json",
    manifestPath: "/tmp/example/.planban/project.json",
    repoId: "example",
  });

  assert.match(context, landing);
  assert.match(source("plugins/planban/skills/planban/references/planban-protocol.md"), landing);
});

test("generated agent context invokes the installed policy without copying it", () => {
  const context = buildAgentContext({
    planningRoot: "/tmp/planban/repos/example",
    roadmapPath: "/tmp/planban/repos/example/roadmap.json",
    manifestPath: "/tmp/example/.planban/project.json",
    repoId: "example",
  });

  assert.match(context, /installed Planban protocol and Planban house style/u);
  assert.match(context, /Lean reads[\s\S]*sempre[\s\S]*lean: true[\s\S]*compact: true/u);
  assert.doesNotMatch(context, /Information locations and ownership/u);
});

test("generated agent context falls back to the planning root name for the Board URL", () => {
  const context = buildAgentContext({
    planningRoot: "/tmp/planban/repos/fallback-board",
    roadmapPath: "/tmp/planban/repos/fallback-board/roadmap.json",
    manifestPath: "/tmp/fallback/.planban/project.json",
  });

  assert.match(context, /http:\/\/127\.0\.0\.1:4317\/boards\/fallback-board/u);
});
