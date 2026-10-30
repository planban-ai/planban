// Deleting an account is by email for 2.0 (owner request, 15 October 2026):
// the profile menu's quiet link opens a dialog whose button writes the email.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { deleteAccountMailto } from "../src/web/hostedScreens";

test("the email goes to hello@planban.ai with the subject and the account's address filled in", () => {
  const link = new URL(deleteAccountMailto("sam+test@example.com"));
  assert.equal(link.protocol, "mailto:");
  assert.equal(link.pathname, "hello@planban.ai");
  assert.equal(link.searchParams.get("subject"), "Delete my Planban account");
  assert.equal(link.searchParams.get("body"), "Please delete my Planban account: sam+test@example.com\n");
  assert.equal(new URL(deleteAccountMailto(null)).searchParams.get("body"), "Please delete my Planban account.\n");
});

test("the profile menu has the quiet link, not the old paragraph, and the dialog says what goes", async () => {
  const source = await readFile(new URL("../src/web/hostedScreens.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /To delete your account, email/);
  // Last, below a divider, after Sign out, in the destructive style.
  assert.match(source, />Sign out<\/button>[\s\S]*web-account-divider[\s\S]*className="web-account-danger".*>Delete account<\/button>\s*<\/div>/);
  assert.match(source, /className="web-danger-primary web-delete-account-email"/);
  assert.match(source, /removes the boards you own, for everyone on them\. Your edits on other people's boards stay, without your name\. Email us and it's done within 30 days\./);
  assert.match(source, />Email hello@planban\.ai</);
  assert.match(source, />Cancel</);
});
