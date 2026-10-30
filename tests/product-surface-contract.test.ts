import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const webPath = new URL("../src/web/main.tsx", import.meta.url);
const stylesPath = new URL("../src/web/styles.css", import.meta.url);
const demoPath = new URL("../src/core/demo.ts", import.meta.url);

test("the accepted board and detail simplification remains visible in the product contract", async () => {
  const [web, styles] = await Promise.all([
    readFile(webPath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);

  // One-line board header (owner decision, 16 October 2026): the card stack back to all
  // boards, no breadcrumb and no separate row with a house button.
  assert.match(web, /label="Your boards" tooltipPlacement="bottom" className="board-home-mark"[\s\S]*?<CardStackMark \/>/u);
  assert.doesNotMatch(web, /web-crumb|board-home-row|<Home size/u);
  assert.match(web, /!capabilities\.hosted && updateStatus\?\.updateAvailable/u);
  assert.match(web, /"See all Items"/u);
  assert.match(web, /"Return to Main Board"/u);
  assert.match(web, /function BoardMoreMenu/u);
  assert.match(web, />Board history</u);
  assert.match(web, />Feedback \/ Bug</u);
  assert.match(web, /Copy \$\{item\.isGroup \? "Group" : "Item"\} reference/u);
  assert.match(web, /function CopyConfirmationIcon/u);
  assert.match(web, /copy-reference-button \$\{referenceCopied \? "is-copied" : ""\}/u);
  assert.match(styles, /\.copy-reference-button\.is-copied[\s\S]*?var\(--green-500\)/u);
  assert.match(styles, /\.copy-reference-button\.is-copied \.copy-reference-icon-success\s*\{[^}]*opacity:\s*1;/su);
  assert.match(web, /function DetailHistoryMenu/u);
  assert.match(web, /className="detail-history-popover"/u);
  assert.match(styles, /\.detail-header\s*\{[^}]*position:\s*sticky;/su);
  assert.match(styles, /\.detail-history-trigger\s*\{[^}]*opacity:\s*0;/su);
  assert.match(styles, /\.detail-item-actions > button\s*\{/u);
  assert.match(styles, /\.board-screen > \.app-header\s*\{[^}]*padding-left:\s*16px;/su);
  assert.match(styles, /button\.content-edit-action\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;/su);
  assert.doesNotMatch(styles, /button\.content-edit-action:hover\s*\{[^}]*border-color:/su);
  // One Planban dropdown everywhere (Planban 2.0, approved mockup section 11).
  assert.match(web, /function PlanbanSelectMenu[\s\S]*?<Dropdown/u);
  assert.doesNotMatch(web, /<select\b/u);
  assert.match(web, /className="empty-drop hidden-cards-state"/u);
  assert.match(styles, /\.hidden-cards-state > span\s*\{[^}]*border-radius:\s*999px;/su);
  assert.match(styles, /\.update-available-button\s*\{[^}]*border-radius:\s*999px;[^}]*background:\s*var\(--accent\);[^}]*color:\s*#fff;/su);
  assert.doesNotMatch(web, /<span>Update Available<\/span>\s*<Download/u);
  assert.match(styles, /\.feedback-actions \.update-now-action\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*var\(--accent\);[^}]*color:\s*#fff;/su);
  assert.doesNotMatch(web, /<CircleArrowUp/u);
  assert.match(styles, /\.board-list\s*\{[^}]*margin:\s*16px;/su);

  assert.doesNotMatch(web, /label="Refresh board from disk"/u);
  assert.doesNotMatch(web, /label="Show All Work Items"/u);
  assert.doesNotMatch(web, /function TutorialPlanningComposer/u);
  assert.doesNotMatch(web, /historyMode/u);
  assert.doesNotMatch(web, /function VersionChangeMenu/u);
  assert.doesNotMatch(web, /Duplicate \{board\.title\}/u);
});

test("tutorial and demo teach portable agent handoff rather than card-owned thread launching", async () => {
  const [web, demo] = await Promise.all([
    readFile(webPath, "utf8"),
    readFile(demoPath, "utf8"),
  ]);

  assert.match(web, /A project board you and your agents can work from/u);
  assert.match(web, /Planban Feedback<\/b> from <code>\/planban<\/code>/u);
  assert.match(web, /<code>\/Planban Feedback<\/code>/u);
  assert.match(demo, /Copy a reference into agent chat/u);
  assert.doesNotMatch(demo, /demoCodexPrompt/u);
});
