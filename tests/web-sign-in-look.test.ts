// How the web page's sign-in looks (approved mockup section 5), set through
// Clerk's appearance and localization options.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CLERK_APPEARANCE, CLERK_LOCALIZATION } from "../src/web/clerkLook";

test("Clerk's step titles stay visible, so the code step says where the code went", () => {
  const elements = CLERK_APPEARANCE.elements as Record<string, Record<string, unknown>>;
  assert.notEqual(elements.header?.display, "none");
  assert.notEqual(elements.headerTitle?.display, "none");
  assert.equal(CLERK_LOCALIZATION.signIn.start.titleCombined, "Log in or sign up");
  assert.equal(CLERK_LOCALIZATION.signIn.emailCode.title, "Check your email");
  assert.equal(CLERK_LOCALIZATION.signUp.emailCode.title, "Check your email");
});

test("Clerk's controls are styled through its appearance options, strongly enough to replace its own borders", () => {
  const elements = CLERK_APPEARANCE.elements as Record<string, Record<string, Record<string, unknown>>>;
  for (const name of ["socialButtonsBlockButton", "formFieldInput", "formButtonPrimary", "otpCodeFieldInput"]) {
    assert.ok(elements[name]?.["&&"], `${name} uses the doubled class`);
  }
  assert.equal(elements.otpCodeFieldInput!["&&"]!.width, "44px");
});
