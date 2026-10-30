/**
 * The Clerk browser bundles every Planban sign-in page loads, pinned: the
 * service's consent page and the web page's sign-in use the same ones.
 */
export const CLERK_JS_VERSION = "6.39.0";
export const CLERK_UI_VERSION = "1.40.0";

export function clerkScriptUrls(frontendApi: string) {
  return {
    ui: `${frontendApi}/npm/@clerk/ui@${CLERK_UI_VERSION}/dist/ui.browser.js`,
    js: `${frontendApi}/npm/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`,
  };
}
