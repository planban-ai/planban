// Planban's own sign-in emails (owner request, 15 October 2026). Clerk is set
// not to deliver these templates itself ("delivered by Clerk" off); it sends
// an email.created webhook instead, signed through Svix, and the service
// renders the email in Planban's style (the invitation email's) and sends it
// through Resend from the invitations address.
import { WORDMARK_EMAIL_PNG_BASE64 } from "./brandAssets";

/** The Clerk templates Planban sends itself. Turn off "delivered by Clerk" for exactly these. */
export const PLANBAN_SENT_TEMPLATES = ["verification_code", "new_device_sign_in", "primary_email_address_changed", "account_locked"] as const;
export type PlanbanSentTemplate = typeof PLANBAN_SENT_TEMPLATES[number];

const MAX_BODY_BYTES = 64 * 1024;
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
/** A code older than this is not worth sending: Clerk's codes last 10 minutes. */
const CODE_MAX_AGE_MS = 10 * 60 * 1000;
const NOTICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const font = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Arial,sans-serif";

function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: ArrayBuffer) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/**
 * Checks a Svix-signed webhook (Clerk's): the signature is HMAC-SHA256 of
 * "id.timestamp.body" under the endpoint's secret, and the timestamp is recent.
 */
export async function verifySvix(secret: string, headers: Headers, body: string, now = Date.now()): Promise<boolean> {
  const id = headers.get("svix-id") ?? "", timestamp = headers.get("svix-timestamp") ?? "", signatures = headers.get("svix-signature") ?? "";
  if (!/^[A-Za-z0-9_-]{4,200}$/.test(id) || !/^\d{1,12}$/.test(timestamp) || !signatures || signatures.length > 2000) return false;
  if (Math.abs(now - Number(timestamp) * 1000) > SIGNATURE_TOLERANCE_MS) return false;
  if (!secret.startsWith("whsec_")) return false;
  let keyBytes: Uint8Array<ArrayBuffer>;
  try { keyBytes = base64ToBytes(secret.slice("whsec_".length)); } catch { return false; }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = bytesToBase64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return signatures.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    return version === "v1" && !!value && sameText(value, expected);
  });
}

export type SignInEmail =
  | { slug: "verification_code"; to: string; code: string; requestedFrom: string | null }
  | { slug: "new_device_sign_in"; to: string; device: string | null; location: string | null; method: string | null; at: string | null }
  | { slug: "primary_email_address_changed"; to: string; newAddress: string }
  | { slug: "account_locked"; to: string; until: string | null };

export type Decision = { send: SignInEmail } | { ignore: string } | { retry: string };

const text = (value: unknown, max = 200) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const address = (value: unknown) => {
  const email = text(value, 320)?.toLowerCase() ?? null;
  return email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
};

/** What to do with one Clerk webhook event. */
export function decideClerkEmail(event: unknown, now = Date.now()): Decision {
  const envelope = event as { type?: unknown; timestamp?: unknown; data?: Record<string, unknown> };
  if (envelope?.type !== "email.created") return { ignore: "not an email" };
  const email = envelope.data ?? {};
  if (email.delivered_by_clerk !== false) return { ignore: "Clerk delivers this one" };
  const slug = text(email.slug, 80);
  if (!slug || !(PLANBAN_SENT_TEMPLATES as readonly string[]).includes(slug)) {
    // Clerk was told not to deliver a template Planban can't send: the person gets nothing, so say so loudly.
    return { retry: `no Planban template for ${slug ?? "an unnamed email"}` };
  }
  const to = address(email.to_email_address);
  if (!to) return { ignore: "no recipient" };
  // Clerk's test addresses never need a real email (their code is fixed).
  if (to.includes("+clerk_test@")) return { ignore: "test address" };
  const at = typeof envelope.timestamp === "number" ? envelope.timestamp : null;
  if (!at || now - at > (slug === "verification_code" ? CODE_MAX_AGE_MS : NOTICE_MAX_AGE_MS)) return { ignore: "too old to send" };
  const data = (email.data && typeof email.data === "object" ? email.data : {}) as Record<string, unknown>;
  switch (slug as PlanbanSentTemplate) {
    case "verification_code": {
      const code = text(data.otp_code, 12);
      if (!code || !/^\d{6}$/.test(code)) return { ignore: "no code" };
      return { send: { slug: "verification_code", to, code, requestedFrom: text(data.requested_from) } };
    }
    case "new_device_sign_in": {
      const device = [text(data.browser_name), text(data.operating_system)].filter(Boolean).join(" on ") || text(data.device_type);
      return { send: { slug: "new_device_sign_in", to, device, location: text(data.location), method: text(data.sign_in_method), at: text(data.session_created_at) } };
    }
    case "primary_email_address_changed": {
      const newAddress = address(data.new_email_address);
      if (!newAddress) return { ignore: "no new address" };
      return { send: { slug: "primary_email_address_changed", to, newAddress } };
    }
    case "account_locked":
      return { send: { slug: "account_locked", to, until: text(data.unlock_time) } };
  }
}

function frame(input: { title: string; eyebrow: string; heading: string; intro: string; middle?: string; after?: string; footer: string }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${escape(input.title)}</title></head><body style="margin:0;padding:0;background:#f9f9f9;color:#0d0d0d;font-family:${font}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9"><tr><td align="center" style="padding:24px 16px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #e9e9e9;border-radius:10px"><tr><td style="padding:21px 23px 17px;border-bottom:1px solid #e9e9e9"><img src="cid:planban-wordmark" width="132" height="32" alt="Planban" style="display:block;border:0;width:132px;height:32px;border-radius:5px"></td></tr><tr><td style="padding:28px;font-family:${font}"><p style="font-size:12px;color:#5d5d5d;margin:0 0 12px">${escape(input.eyebrow)}</p><h1 style="font-size:27px;line-height:1.2;letter-spacing:-.6px;font-weight:650;margin:0 0 16px">${escape(input.heading)}</h1><p style="font-size:15px;line-height:1.65;color:#414141;margin:0 0 22px">${escape(input.intro)}</p>${input.middle ?? ""}${input.after ? `<p style="font-size:13px;line-height:1.65;color:#414141;margin:0">${input.after}</p>` : ""}</td></tr><tr><td style="padding:18px 28px;border-top:1px solid #e9e9e9;color:#5d5d5d;font-family:${font};font-size:11px;line-height:1.6">${input.footer}</td></tr></table></td></tr></table></body></html>`;
}

function details(rows: Array<[string, string | null]>) {
  const shown = rows.filter((row): row is [string, string] => !!row[1]);
  if (!shown.length) return "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;border:1px solid #e9e9e9;border-radius:6px;margin-bottom:24px"><tr><td style="padding:14px 16px;font-size:13px;line-height:1.7;font-family:${font}">${shown.map(([label, value]) => `<strong style="font-weight:600">${escape(label)}:</strong> <span style="color:#5d5d5d">${escape(value)}</span>`).join("<br>")}</td></tr></table>`;
}

const IGNORE = "If this wasn't you, you can ignore this email.";
const NOT_YOU = "If this wasn't you, sign in at app.planban.ai, open your account menu, choose Connections and then Cut off everything, and email hello@planban.ai.";

/** The email for one decision: subject, HTML, plain text and the wordmark image. */
export function renderSignInEmail(email: SignInEmail) {
  let subject: string, html: string, plain: string;
  switch (email.slug) {
    case "verification_code": {
      subject = `${email.code} is your Planban code`;
      const code = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px"><tr><td style="background:#f5f5f5;border:1px solid #e9e9e9;border-radius:8px;padding:14px 22px;font:600 30px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:8px;color:#0d0d0d">${escape(email.code)}</td></tr></table>`;
      html = frame({ title: subject, eyebrow: "YOUR CODE", heading: "Your Planban code", intro: "Use this code to continue with your Planban account. It works for 10 minutes.", middle: code,
        after: escape(email.requestedFrom ? `Requested from ${email.requestedFrom}.` : ""), footer: `Sent by Planban<br>${escape(IGNORE)} Planban never asks for this code by phone or chat.` });
      plain = `Your Planban code\n\n${email.code}\n\nUse this code to continue with your Planban account. It works for 10 minutes.${email.requestedFrom ? `\nRequested from ${email.requestedFrom}.` : ""}\n\n${IGNORE} Planban never asks for this code by phone or chat.`;
      break;
    }
    case "new_device_sign_in": {
      subject = "New sign-in to your Planban account";
      const rows: Array<[string, string | null]> = [["Device", email.device], ["Where", email.location], ["How", email.method], ["When", email.at]];
      html = frame({ title: subject, eyebrow: "ACCOUNT SECURITY", heading: "A new sign-in", intro: "Your Planban account was just signed in to from a device it hasn't seen before.", middle: details(rows),
        after: escape(NOT_YOU), footer: "Sent by Planban<br>We send this when your account is used on a new device." });
      plain = `A new sign-in\n\nYour Planban account was just signed in to from a device it hasn't seen before.\n${rows.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join("\n")}\n\n${NOT_YOU}`;
      break;
    }
    case "primary_email_address_changed": {
      subject = "Your Planban sign-in email changed";
      html = frame({ title: subject, eyebrow: "ACCOUNT SECURITY", heading: "Your sign-in email changed", intro: "Your Planban account now signs in with a different email address.", middle: details([["New address", email.newAddress]]),
        after: escape(`If you didn't change it, email hello@planban.ai straight away.`), footer: "Sent by Planban<br>We send this to your previous address." });
      plain = `Your sign-in email changed\n\nYour Planban account now signs in with ${email.newAddress}.\n\nIf you didn't change it, email hello@planban.ai straight away.`;
      break;
    }
    case "account_locked": {
      subject = "Your Planban account is locked for now";
      html = frame({ title: subject, eyebrow: "ACCOUNT SECURITY", heading: "Too many sign-in attempts", intro: "After several wrong codes in a row, your Planban account is locked for a while to keep it safe.", middle: details([["Unlocks", email.until]]),
        after: escape("You can sign in again once it unlocks. If these attempts weren't you, email hello@planban.ai."), footer: "Sent by Planban<br>We send this when sign-in is paused for your safety." });
      plain = `Too many sign-in attempts\n\nAfter several wrong codes in a row, your Planban account is locked for a while to keep it safe.${email.until ? `\nUnlocks: ${email.until}` : ""}\n\nYou can sign in again once it unlocks. If these attempts weren't you, email hello@planban.ai.`;
      break;
    }
  }
  return { subject, html, text: plain,
    attachments: [{ filename: "planban-wordmark.png", content: WORDMARK_EMAIL_PNG_BASE64, content_type: "image/png", content_id: "planban-wordmark" }] };
}

/** The request body, or null as soon as it passes `limit` bytes (nothing more is read). */
async function boundedText(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/**
 * Clerk's webhook. Answers 2xx once the email is sent or rightly not sent,
 * and 503 when Clerk should try again (Svix retries for days), including
 * when sending isn't set up, so a missing key is never silent.
 */
export async function clerkWebhookResponse(request: Request): Promise<Response> {
  const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (!secret) return new Response("Webhook not set up.", { status: 503 });
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) return new Response("Too large.", { status: 413 });
  const body = await boundedText(request, MAX_BODY_BYTES);
  if (body === null) return new Response("Too large.", { status: 413 });
  if (!await verifySvix(secret, request.headers, body)) return new Response("Invalid signature.", { status: 400 });
  let event: unknown;
  try { event = JSON.parse(body); } catch { return new Response("Invalid body.", { status: 400 }); }
  const decision = decideClerkEmail(event);
  if ("ignore" in decision) return Response.json({ ok: true, ignored: decision.ignore });
  if ("retry" in decision) return Response.json({ ok: false, reason: decision.retry }, { status: 503 });
  const key = process.env.RESEND_API_KEY, from = process.env.PLANBAN_INVITE_FROM;
  if (!key || !from) return Response.json({ ok: false, reason: "sending isn't set up" }, { status: 503 });
  const message = renderSignInEmail(decision.send);
  // A code only lasts 10 minutes, and Svix's own retries soon space out past that,
  // so a passing hiccup is retried here first. The same key makes any repeat harmless.
  let status: number | null = null;
  // Three tries in under 13 seconds, inside Svix's 15-second wait for an answer.
  for (const wait of [0, 700, 1_500]) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      // Svix retries carry the same id, so one Clerk email is sent at most once.
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `planban-clerk-${request.headers.get("svix-id")}` },
      body: JSON.stringify({ from, to: [decision.send.to], ...message }),
      signal: AbortSignal.timeout(3_500),
    }).catch(() => null);
    if (response?.ok) return Response.json({ ok: true, sent: decision.send.slug });
    status = response?.status ?? null;
    // A refusal that won't change on retry (a bad address, a bad key) isn't retried here.
    if (status !== null && status >= 400 && status < 500 && status !== 429) break;
  }
  return Response.json({ ok: false, reason: `the email service answered ${status ?? "nothing"}` }, { status: 503 });
}
