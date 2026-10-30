// The stateless sign-in start (owner decision, 14 October 2026). Starting a
// sign-in stores nothing: the service hands the browser a short-lived note,
// signed with a key only the service holds, carrying the frozen request. The
// service creates its sign-in record only when a signed-in person approves,
// and counts approvals per person, never against a shared allowance.

export const NOTE_PREFIX = "pbn_";
/** Longest note accepted: the request fields are bounded well below this. */
export const MAX_NOTE_LENGTH = 7000;
const NOTE_SHAPE = /^pbn_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

export interface SignInNote {
  v: 1;
  /**
   * launch: the computer sign-in's link, before any browser; consent: bound to
   * one browser; device: one-tap approval from any signed-in device.
   */
  kind: "launch" | "consent" | "device";
  purpose: "oauth" | "machine";
  clientId: string;
  clientName: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  level: "read" | "plan" | "complete";
  challenge: string;
  state: string;
  /** Milliseconds since the epoch; the note is refused from this moment. */
  expiresAt: number;
  /** consent notes: SHA-256 of the browser cookie the note is tied to. */
  browserHash?: string;
  /** consent notes for the computer sign-in: SHA-256 of the launch note, so one launch is approved once. */
  launchHash?: string;
  /** device notes: SHA-256 of the device code the waiting agent polls with, and the short code it shows. */
  deviceHash?: string;
  userCode?: string;
  /** Random, so two notes for the same request differ. */
  nonce: string;
}

/** The signing key: at least 32 characters, or null when unset (sign-in then reports it isn't configured). */
export function noteKey(): string | null {
  const key = process.env.PLANBAN_SIGNIN_NOTE_KEY ?? "";
  return key.length >= 32 ? key : null;
}

const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));

async function hmacKey(key: string) {
  return crypto.subtle.importKey("raw", encoder.encode(`planban-signin-note:${key}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export function randomNonce(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function sealNote(note: SignInNote, key = noteKey()): Promise<string> {
  if (!key) throw new Error("Sign-in notes are not configured.");
  const payload = base64url(encoder.encode(JSON.stringify(note)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(key), encoder.encode(`${NOTE_PREFIX}${payload}`)));
  return `${NOTE_PREFIX}${payload}.${base64url(signature)}`;
}

/** Whether a string has a note's shape and size, before any cryptography. */
export function looksLikeNote(text: string): boolean {
  return text.length <= MAX_NOTE_LENGTH && NOTE_SHAPE.test(text);
}

/**
 * The note, if it was signed by this service, is of the expected kind and
 * hasn't expired. Anything altered, foreign, expired or malformed is null.
 */
export async function openNote(text: string, kind: SignInNote["kind"], key = noteKey(), now = Date.now()): Promise<SignInNote | null> {
  if (!key || !looksLikeNote(text)) return null;
  const dot = text.lastIndexOf(".");
  try {
    // One spelling only: a base64url text can hide unused bits in its last
    // character, and single use is keyed on the exact note text.
    const signature = fromBase64url(text.slice(dot + 1)), payload = fromBase64url(text.slice(NOTE_PREFIX.length, dot));
    if (base64url(signature) !== text.slice(dot + 1) || base64url(payload) !== text.slice(NOTE_PREFIX.length, dot)) return null;
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(key), signature, encoder.encode(text.slice(0, dot)));
    if (!valid) return null;
    const note = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64url(text.slice(NOTE_PREFIX.length, dot)))) as SignInNote;
    if (note?.v !== 1 || note.kind !== kind || !Number.isSafeInteger(note.expiresAt) || note.expiresAt <= now) return null;
    if (kind === "consent" && !/^[a-f0-9]{64}$/.test(note.browserHash ?? "")) return null;
    if (kind === "device" && (!/^[a-f0-9]{64}$/.test(note.deviceHash ?? "") || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(note.userCode ?? ""))) return null;
    return note;
  } catch { return null; }
}

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** The short code a waiting agent shows, derived from its device code, for the person to compare before allowing. */
export function userCodeFor(deviceHash: string): string {
  let code = "";
  for (let i = 0; i < 8; i++) code += USER_CODE_ALPHABET[parseInt(deviceHash.slice(i * 2, i * 2 + 2), 16) % USER_CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
