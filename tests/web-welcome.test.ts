// Where a new account starts (owner decision, 15 October 2026): use what the
// service already knows, and ask only when nothing is known.
import assert from "node:assert/strict";
import { test } from "node:test";
import { welcomeStart, type WelcomeSignals } from "../src/web/hostedScreens";

const nothing: WelcomeSignals = { invites: 0, computer: null, ownsBoards: false, appConnected: false };

test("nothing known: the three-way question", () => {
  assert.equal(welcomeStart(nothing), "question");
});

test("ChatGPT or Claude signed in, and nothing else: still the question, in its connected wording", () => {
  assert.equal(welcomeStart({ ...nothing, appConnected: true }), "question");
});

test("signed up from the app (a computer signed in, or a board taken online): straight to bringing boards online", () => {
  assert.equal(welcomeStart({ ...nothing, computer: { name: "Sam's MacBook Pro", lastUsedAt: new Date().toISOString() } }), "computer");
  assert.equal(welcomeStart({ ...nothing, ownsBoards: true }), "computer");
  assert.equal(welcomeStart({ ...nothing, ownsBoards: true, appConnected: true }), "computer");
});

test("invitations waiting for their address come first, whatever else is known", () => {
  assert.equal(welcomeStart({ ...nothing, invites: 1 }), "invited");
  assert.equal(welcomeStart({ invites: 2, computer: { name: "Mac", lastUsedAt: "" }, ownsBoards: true, appConnected: true }), "invited");
});
