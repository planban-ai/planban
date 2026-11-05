// The Convex deploy regenerates online/service/convex/_generated/api.d.ts.
// When the committed copy is out of date, the deploy rewrites it and the
// release script's clean-checkout check then refuses the Worker deploy
// (5 November 2026). This keeps the committed copy in step with the modules.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "../online/service/convex");

async function modules(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "_generated") found.push(...await modules(path));
    } else if (entry.name.endsWith(".ts")) {
      found.push(relative(root, path).replaceAll("\\", "/").replace(/\.ts$/, ""));
    }
  }
  return found;
}

test("the committed Convex api.d.ts lists every module, in the order Convex writes them", async () => {
  // Convex leaves out the schema and the auth config, and sorts the rest.
  const expected = (await modules(root)).filter((name) => name !== "schema" && name !== "auth.config").sort();
  const generated = await readFile(join(root, "_generated/api.d.ts"), "utf8");
  const imported = [...generated.matchAll(/^import type \* as \w+ from "\.\.\/(.+)\.js";$/gm)].map((match) => match[1]);
  assert.deepEqual(imported, expected, "Regenerate online/service/convex/_generated/api.d.ts (npx convex codegen) and commit it.");
});
