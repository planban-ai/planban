// Planban 2.0 phase 3, checked in the page source: one Planban dropdown
// everywhere, phones without dragging, and viewers without edit controls.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path: string) => readFile(new URL(`../src/web/${path}`, import.meta.url), "utf8");

test("the page uses the one Planban dropdown, never the browser's own, except as the phone's picker", async () => {
  for (const file of ["main.tsx", "onlineBoard.tsx"]) assert.doesNotMatch(await read(file), /<select\b/u, file);
  const dropdown = await read("Dropdown.tsx");
  assert.match(dropdown, /\(pointer: coarse\)/u, "touch screens get the phone's picker");
  assert.match(dropdown, /role="listbox"/u);
  assert.match(dropdown, /aria-activedescendant/u);
  assert.match(dropdown, /aria-selected=\{option\.value === value\}/u);
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Enter"]) assert.match(dropdown, new RegExp(`"${key}"`, "u"), key);
  assert.match(dropdown, /event\.key === "Tab"\) \{\s*setOpen\(false\);\s*triggerRef\.current\?\.focus\(\);/u, "Tab carries on from the dropdown's button");
  assert.match(dropdown, /if \(open && place\) document\.getElementById\(`\$\{id\}-option-\$\{active\}`\)\?\.scrollIntoView\(\{ block: "nearest" \}\)/u, "the active choice stays in view, from the first opening");
  assert.match(dropdown, /listRef\.current\?\.contains\(event\.target as Node\)\) return;/u, "scrolling the menu doesn't close it");
  const styles = await read("styles.css");
  assert.match(styles, /\.pb-dropdown-trigger\s*\{[^}]*gap:\s*6px;/su, "the arrow sits 6 px after the text");
  assert.match(styles, /\.pb-dropdown-trigger\s*\{[^}]*min-height:\s*30px;/su, "as tall as the buttons beside it");
});

test("phones scroll one list, move cards without dragging, and keep Save above the keyboard", async () => {
  const web = await read("main.tsx");
  // One stable argument: a changing argument count leaves React holding the old sensors.
  assert.match(web, /useSensors\(phone \|\| viewOnly \? undefined : pointerSensor\)/u);
  assert.doesNotMatch(web, /useSensors\(\.\.\./u);
  assert.match(web, /function PhoneStatusTabs/u);
  assert.match(web, /useKeyboardInset\(\)/u);
  const styles = await read("styles.css");
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*\.editor-actions\s*\{[^}]*bottom:\s*var\(--keyboard-inset, 0px\)/su);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*\.modal-backdrop > \[role="dialog"\]\s*\{[^}]*height:\s*100%/su, "dialogs are full-height sheets");
});

test("a conflicting save keeps the person's text, and a viewer gets no edit controls", async () => {
  const web = await read("main.tsx");
  const save = web.slice(web.indexOf("async function saveDoc()"), web.indexOf("return (", web.indexOf("async function saveDoc()")));
  assert.match(save, /status === 409/u);
  assert.doesNotMatch(save, /setDraft\(payload\.markdown\);\s*\}\s*finally/u, "a failed save never replaces the draft");
  assert.match(web, /changed this \$\{docKindLabel\(activeTab\)\} while you were editing\./u);
  // Their version is shown beside yours at once, with a simple choice: keep theirs, edit, or use mine (Spec point 20).
  assert.match(web, /setConflict\(\{ theirs, who: await latestDocAuthor\(\), showing: true, seen: true, choosing: true \}\)/u);
  assert.match(web, />Keep theirs</u);
  assert.match(web, /\n\s+Use mine\r?\n/u);
  assert.match(web, /choosing: false \}\)\}>Edit</u);
  // Viewers get no order controls in a Group either.
  assert.match(web, /readOnly=\{viewOnly\}/u);
  assert.match(web, /const viewOnly = state\.hosted\?\.role === "viewer";/u);
  assert.match(web, /readOnly=\{isPreviewing \|\| viewOnly\}/u);
});

test("the page's stylesheet opens and closes every block, so no later rule is silently lost", async () => {
  const styles = (await read("styles.css")).replace(/\/\*[\s\S]*?\*\//gu, "").replace(/"(?:[^"\\]|\\.)*"/gu, "\"\"");
  let depth = 0;
  for (const char of styles) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    assert.ok(depth >= 0, "a block closes before it opens");
  }
  assert.equal(depth, 0, "every block is closed");
});

test("touch screens always show the edit buttons, and a document that won't load says so with Try again", async () => {
  const styles = await read("styles.css");
  assert.match(styles, /@media \(hover: none\), \(pointer: coarse\) \{\s*button\.content-edit-action \{\s*opacity: 1;\s*pointer-events: auto;/su, "as specific as the rule that hides them");
  const web = await read("main.tsx");
  assert.match(web, /Couldn't load this \{docKindLabel\(activeTab\)\.toLowerCase\(\)\}/u);
  assert.match(web, /onClick=\{\(\) => void loadDoc\(activeTab\)\.catch\(\(\) => undefined\)\}>Try again/u);
});

test("a document's answer only lands if it is the newest request for the document on screen", async () => {
  const { latestRequestGate } = await import("../src/web/latestRequest");
  let onScreen = "A";
  const gate = latestRequestGate<"spec" | "plan">();
  // Sol's sequence: open A, switch to B, back to A; that load fails, Try again succeeds, then the first A request answers late.
  const firstA = gate.begin("spec", "A", () => onScreen);
  onScreen = "B";
  const forB = gate.begin("spec", "B", () => onScreen);
  assert.equal(firstA(), false, "A's answer can't land on B");
  onScreen = "A";
  const secondA = gate.begin("spec", "A", () => onScreen);
  const retryA = gate.begin("spec", "A", () => onScreen);
  assert.equal(secondA(), false, "the failed load is superseded by Try again");
  assert.equal(retryA(), true, "Try again's answer lands");
  assert.equal(firstA(), false, "the first, late answer for A never overwrites it");
  assert.equal(forB(), false);
  // Kinds are independent: a Plan request doesn't supersede the Spec's.
  const plan = gate.begin("plan", "A", () => onScreen);
  assert.equal(plan(), true);
  assert.equal(retryA(), true);
  const web = await read("main.tsx");
  const load = web.slice(web.indexOf("const loadDoc = useCallback("), web.indexOf("[boardId, item.id, previewVersion, docRequests],"));
  assert.match(load, /docRequests\.begin\(kind,/u);
  assert.match(load, /if \(current\(\)\) setDocsByKind/u);
  assert.match(load, /if \(current\(\)\) setDocErrors/u);
  assert.doesNotMatch(web, /void loadDoc\(kind\)\.then\(/u, "nothing updates documents outside the gate");
});

test("on a phone the board header's menus open above the sticky column chips", async () => {
  const styles = await read("styles.css");
  const header = /\.board-screen > \.app-header \{ position: relative; z-index: (\d+);/u.exec(styles);
  const chips = /\.phone-status-tabs \{ position: sticky; top: 0; z-index: (\d+);/u.exec(styles);
  assert.ok(header && chips, "both rules exist");
  assert.ok(Number(header![1]) > Number(chips![1]));
});
