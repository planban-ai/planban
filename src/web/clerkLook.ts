// How Clerk's sign-in looks and reads on the web page (approved mockup
// section 5). Everything goes through Clerk's own appearance and
// localization options: its step titles sit above a white panel holding the
// form, and its controls take the page's sizes, borders and colours. Colours
// are the page's CSS variables, so dark mode follows the rest of the page.

// Clerk draws borders with its own box-shadows at the same specificity as
// these styles, so the controls' styles use "&&" (the element's class twice).
const strong = (style: Record<string, unknown>) => ({ "&&": style });

const field = {
  height: "38px",
  border: "1px solid var(--border-strong)",
  borderRadius: "8px",
  boxShadow: "none",
  background: "var(--surface)",
  color: "var(--text)",
};
const focus = { borderColor: "var(--accent)", boxShadow: "0 0 0 3px color-mix(in oklab, var(--accent) 18%, transparent)" };

export const CLERK_APPEARANCE = {
  layout: { socialButtonsPlacement: "top", logoPlacement: "none" },
  variables: { fontFamily: "var(--font-sans)", fontSize: "14px", borderRadius: "8px" },
  elements: {
    rootBox: { width: "100%" },
    cardBox: { width: "100%", maxWidth: "none", border: "0", borderRadius: "0", boxShadow: "none", background: "transparent", overflow: "visible" },
    card: { minWidth: 0, gap: "16px", border: "0", borderRadius: "0", boxShadow: "none", background: "transparent", padding: "0" },
    // "& > *": the header's inner column, so a long address can't widen it past the page.
    header: { minWidth: 0, alignItems: "flex-start", gap: "4px", textAlign: "left", "& > *": { minWidth: 0, maxWidth: "100%" } },
    headerTitle: { color: "var(--text)", fontSize: "20px", fontWeight: 650, lineHeight: 1.3, letterSpacing: "-.3px" },
    headerSubtitle: { color: "var(--text-muted)", fontSize: "13px", lineHeight: 1.5 },
    main: { gap: "14px", border: "1px solid var(--border)", borderRadius: "12px", background: "var(--surface)", padding: "20px" },
    socialButtonsBlockButton: strong({ ...field, fontWeight: 500, "&:hover": { background: "var(--surface-subtle)" } }),
    socialButtonsBlockButtonText: { fontSize: "14px", fontWeight: 500, color: "var(--text)" },
    dividerRow: { margin: "0" },
    dividerLine: { background: "var(--border)" },
    dividerText: { color: "var(--text-muted)", fontSize: "12px" },
    form: { gap: "14px" },
    formFieldLabel: { color: "var(--text)", fontSize: "13px", fontWeight: 500 },
    formFieldInput: strong({ ...field, padding: "0 10px", fontSize: "14px", "&:focus": focus }),
    formButtonPrimary: strong({
      height: "38px", border: "0", borderRadius: "8px", boxShadow: "none", background: "var(--text)", color: "var(--bg)",
      fontSize: "14px", fontWeight: 600, textTransform: "none",
      "&:hover, &:focus": { background: "color-mix(in oklab, var(--text) 85%, var(--bg))", boxShadow: "none" },
      "&::after": { display: "none" },
    }),
    buttonArrowIcon: { display: "none" },
    otpCodeFieldInputs: { gap: "8px", justifyContent: "center" },
    otpCodeFieldInput: strong({ ...field, width: "44px", height: "48px", maxWidth: "none", fontSize: "20px", fontWeight: 600, "&:focus": focus, "&.cl-error": { borderColor: "var(--red-500)" } }),
    otpCodeFieldErrorText: { justifyContent: "center", marginTop: "8px" },
    formResendCodeLink: { color: "var(--accent)", fontWeight: 600 },
    // A long address shortens with an ellipsis; its pencil stays in view.
    identityPreview: strong({ maxWidth: "100%", minWidth: 0, border: "1px solid var(--border)", borderRadius: "8px", boxShadow: "none", background: "var(--surface)", padding: "6px 10px" }),
    identityPreviewText: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: "13px" },
    identityPreviewEditButton: { color: "var(--accent)" },
    formFieldErrorText: { fontSize: "12.5px" },
    alertText: { fontSize: "13px" },
    footer: { display: "none" },
  },
} as const;

/** Clerk's step titles in the page's words. */
export const CLERK_LOCALIZATION = {
  formFieldInputPlaceholder__emailAddress: "you@example.com",
  signIn: {
    // The combined sign-in-or-up start uses the "Combined" titles.
    start: {
      title: "Log in or sign up", subtitle: "Free. Your boards stay private until you share them.",
      titleCombined: "Log in or sign up", subtitleCombined: "Free. Your boards stay private until you share them.",
    },
    emailCode: { title: "Check your email", subtitle: "Enter the 6-digit code we sent to" },
  },
  signUp: {
    start: { title: "Create your account", subtitle: "Free. Your boards stay private until you share them." },
    emailCode: { title: "Check your email", subtitle: "Enter the 6-digit code we sent to" },
  },
} as const;
