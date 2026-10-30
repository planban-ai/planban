// Planban is an index, not storage (owner decisions 18 and 20). A board holds
// only its own text: cards, Specs, Plans and their history. Files stay where
// they live, and a card refers to them.
//
// The guarantee has three layers (orchestrator ruling, 12 October 2026):
// 1. These rules, on every write path into an Online Board (the hosted API,
//    remote and local MCP, Take Online), and shared with strict Local Mode:
//    a guard against files put in by accident or with everyday tools
//    (data: addresses and pictures, base64 and base64url, hex and xxd dumps,
//    uuencode, base85 and ASCII85, escaped and listed bytes, binary), whole,
//    wrapped or split. No check on text can be complete: a file deliberately
//    disguised as ordinary text can pass, and new encodings are follow-ups,
//    not blockers.
// 2. Size and volume caps, which hold however content is written: 1 MB per
//    Spec or Plan, 128 KB per card, and online, 256 MB of stored text per
//    board including history, and per account per day 5,000 changes, 64 MB of
//    written text and 1 GB taken online (online/service/convex/model/limits.ts).
// 3. Planban never serves what it stores as a file: no raw, download or
//    attachment endpoints, and no content types but its own JSON and the
//    invite page (tests/no-file-serving.test.ts).
import { PlanbanValidationError } from "./boardOperations";

/** Larger than any real Spec or Plan seen so far (the largest is about 0.5 MB). */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;
/** All of one card's own fields together (the largest seen is about 48 KB). */
export const MAX_CARD_BYTES = 128 * 1024;
/** Board details (title, description, columns), a history entry or settings: small text only. */
export const MAX_DETAILS_BYTES = 64 * 1024;

/** How to point at a file instead of embedding it; shown in errors, tool descriptions and the protocol. */
export const HOW_TO_REFER = "Refer to files where they live instead: a GitHub link, any web address, or a local path labelled with its machine, for example \"Mac mini: ~/Projects/northfold/renders/front.png\".";

export const INDEX_NOT_STORAGE = `Planban boards hold text only: cards, Specs, Plans and their history. Planban does not store files. ${HOW_TO_REFER}`;

/** A data: address and its payload. */
const DATA_URI = /data:[^\s,`]{0,100},([^\s)"'`<>\]]*)/gi;
/**
 * All data: payloads in one value together. A short example in prose or code
 * (`data:image/png;base64,AAAA`) is fine; a file needs far more, even split
 * into many short pieces.
 */
const DATA_PAYLOAD_LIMIT = 256;
/** Web addresses are references, whatever their query strings hold (up to 8 KB each). */
const WEB_ADDRESS = /\bhttps?:\/\/[^\s<>()"'`]{1,8192}/gi;
/**
 * Runs that could be base64, counted across the whole value when they look
 * encoded, unlike slugs, ids, hashes and words. Wrapped, split into short
 * pieces or interleaved with prose, a file still adds up.
 */
const ENCODED_TOKEN = /[A-Za-z0-9+/=_-]{24,}/g;
const ENCODED_LIMIT = 2048;
/**
 * Base64 of a real file mixes upper case, lower case and digits throughout
 * (about 40%, 40% and 15%); paths, ids, UUIDs, hashes and CamelCase names are
 * mostly one case or have no digits. Base64 of plain, repetitive bytes
 * repeats a short pattern instead ("BQUFBQUF…").
 */
function looksEncoded(token: string) {
  const upper = token.replace(/[^A-Z]/g, "").length / token.length;
  const lower = token.replace(/[^a-z]/g, "").length / token.length;
  const digits = token.replace(/[^0-9]/g, "").length / token.length;
  if (upper >= 0.12 && lower >= 0.12 && digits >= 0.04) return true;
  return /^(.{1,8}?)\1{5,}/.test(token) && /[A-Z]/.test(token) && !/^[a-z-]+$/.test(token);
}
/** Any payload, however plain, as one unbroken run of base64 or base64url. */
const ENCODED_RUN = /[A-Za-z0-9+/]{2048,}={0,2}|[A-Za-z0-9_-]{2048,}/;
/** A hex dump; lists of hashes are fine. */
const HEX_RUN = /[0-9a-fA-F]{4096,}/;
/**
 * What encoders write: blocks of lines that are almost nothing but payload
 * (base64 or base64url, hex, xxd dumps, byte lists in any syntax, wrapped at
 * any width, blank lines between or not). Real planning text mixes such
 * tokens with words; on the owner's real boards the largest block is under
 * 2,000 characters, while a 3 KB file makes over 4,000 in every encoding.
 */
const TOKEN_SEPARATORS = /[\s,;:\[\]{}()"'`<>|]+/;
/** A lowercase run that repeats a short pattern ("qqqqqqqq…", base64 of repetitive bytes) is not a word. */
const repetitive = (token: string) => /^(.{1,4})\1{5,}/.test(token);
const isPayloadToken = (token: string) => /^(?:0x)?[0-9a-fA-F]+$/.test(token)
  || (/^[A-Za-z0-9+/=_-]{8,}$/.test(token)
    && (repetitive(token)
      // Not words, Names, or slugs and ids such as "improve-audit-2026-07-25-f60dc6e6".
      || (!/^[a-z-]+$/.test(token) && !/^[A-Z][a-z]+$/.test(token) && !/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(token))));
/** Escaped bytes, as printed by Python, JSON, C and od: \x89, \u0000, \377, \n. */
const ESCAPE = /\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[0-7]{1,3}|[abfnrtv'"\\])/g;
/** Compact Markdown rows of ordinary words are prose; pipes are cell separators. */
const isWordTableRow = (line: string) => /^\|.*\|$/.test(line)
  && line.slice(1, -1).split("|").every((cell) => {
    const words = cell.trim();
    return /^(?:[a-z]+|[A-Z][a-z]+)(?:[ -](?:[a-z]+|[A-Z][a-z]+))*$/.test(words)
      && !isPayloadToken(words);
  });
/**
 * A dense line: no spaces to speak of, 12 or more characters, and full of
 * punctuation, as uuencode, base85 and ASCII85 write. Not a web address and
 * not a Markdown rule or table border.
 */
const isDenseLine = (line: string) => line.length >= 12
  && (line.match(/\s/g)?.length ?? 0) <= line.length * 0.05
  && !line.includes("://") && !/^[\s|:=*#~_-]+$/.test(line) && !isWordTableRow(line)
  && ((line.match(/[^A-Za-z0-9/._~-]/g)?.length ?? 0) >= line.length * 0.1 || looksEncoded(line.replace(/[^A-Za-z0-9]/g, "")));
/** Encoder rows sometimes have too little punctuation to start a block.
 * They can continue one, without treating ordinary words or references as payload. */
const isCompactPayloadLine = (line: string) => line.length >= 12
  && !/\s|:\/\//.test(line) && !/^[|:=*#~_-]+$/.test(line) && !isWordTableRow(line)
  // Relative and absolute paths are references, even when a run of encoded
  // lines happens to precede them. Base85's alphabet does not contain '/'.
  && !/^(?:[A-Za-z0-9._~-]*\/){2,}[A-Za-z0-9._~-]*$/.test(line)
  && !/^[a-z-]+$|^[A-Z][a-z]+$|^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(line);
const PAYLOAD_BLOCK_LIMIT = 3072;
/** Across a structured value's fields, only fields with at least this much payload count towards the limit. */
const FIELD_BLOCK_MIN = 64;
const HASH_FIELDS_LIMIT = 100;

/**
 * A uuencoded line: its first character gives the byte count, and the rest is
 * exactly that many bytes in uuencode's alphabet (which includes the space).
 */
function isUuencodeLine(line: string) {
  const count = line.charCodeAt(0) - 32;
  if (count < 1 || count > 63) return false;
  const body = line.slice(1);
  return body.length >= 4 && Math.abs(body.length - Math.ceil(count / 3) * 4) <= 1 && /^[ -`]+$/.test(body);
}

/**
 * A line that is a single hash-length hex token (a commit or checksum):
 * planning text lists these (one real Revival card lists 91), so a block
 * counts them only past HASH_LINES_ALLOWED, about 3 KB of hex at that width.
 */
const HASH_LINE = /^(?:[\w .:#/@-]{0,40}[\s:=])?([0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[0-9a-fA-F]{32}|[0-9a-fA-F]{128})[\s,.;)]*$/;
const HASH_LINES_ALLOWED = 100;

/** Explicit Adobe frames have their own alphabet, including incidental URL
 * punctuation. Validate groups before treating a span as encoded content. */
function ascii85Frames(text: string) {
  const frames: Array<{ start: number; end: number; payload: number }> = [];
  for (const match of text.matchAll(/<~([^~]*)~>/g)) {
    let group = 0, value = 0, payload = 0, valid = true;
    for (const character of match[1]!) {
      if (/[ \t\r\n\f]/.test(character)) continue;
      if (character === "z" && group === 0) { payload += 5; continue; }
      const digit = character.charCodeAt(0) - 33;
      if (digit < 0 || digit > 84) { valid = false; break; }
      value = value * 85 + digit; group++; payload++;
      if (group === 5) {
        if (value > 0xffffffff) { valid = false; break; }
        group = 0; value = 0;
      }
    }
    // A final partial group contains two through four characters, never one.
    if (group > 1) {
      for (let padded = group; padded < 5; padded++) value = value * 85 + 84;
      if (value > 0xffffffff) valid = false;
    }
    if (valid && group !== 1) frames.push({ start: match.index!, end: match.index! + match[0].length, payload });
  }
  return frames;
}

function replaceAscii85(text: string, replacement: string) {
  let out = "", end = 0;
  for (const frame of ascii85Frames(text)) {
    out += text.slice(end, frame.start) + replacement;
    end = frame.end;
  }
  return out + text.slice(end);
}

const ascii85Payload = (text: string) => ascii85Frames(text).reduce((sum, frame) => sum + frame.payload, 0);

/** Each line's payload characters (0 for a line of prose), for lines that are not blank. */
function payloadLines(text: string) {
  const lines: Array<{ index: number; payload: number; weak: number; hash?: number }> = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    // The encodings guarded against (base64, base85, hex, uuencode) are ASCII. Text in
    // other scripts, many written without spaces (Chinese, Japanese, Thai), stands in
    // for a space, so prose leaves little behind and an ASCII payload, padded or not,
    // is judged on what remains.
    const line = raw.replace(/[^\x00-\x7F]+/g, " ").replace(/^[\s>*+-]*(?:\d+[.)]\s+)?/, "");
    if (!line.trim()) return;
    if (isUuencodeLine(raw)) {
      lines.push({ index, payload: raw.length, weak: 0 });
      return;
    }
    if (isDenseLine(line.trim())) {
      lines.push({ index, payload: line.trim().length, weak: 0 });
      return;
    }
    const hash = HASH_LINE.exec(line.trim());
    if (hash) {
      lines.push({ index, payload: 0, weak: 0, hash: hash[1]!.length });
      return;
    }
    const escapes = (line.match(ESCAPE) ?? []).join("").length;
    const plain = line.replace(ESCAPE, " ");
    const tokens = plain.split(TOKEN_SEPARATORS).filter(Boolean);
    const total = tokens.reduce((sum, token) => sum + token.length, 0) + escapes;
    const payload = tokens.filter(isPayloadToken).reduce((sum, token) => sum + token.length, 0) + escapes;
    // A line that is only a number or a byte ("42,", "0x2a") counts however short: one byte per line still adds up.
    const lone = tokens.length === 1 && /^(?:0x[0-9a-fA-F]{1,2}|\d{1,3}|[0-9a-fA-F]{2})$/.test(tokens[0]!);
    const share = total > 0 ? payload / total : 0;
    // Mostly payload: starts or continues a block. Partly payload (a dump line
    // with some printable bytes shown as letters): continues one, never starts one.
    const strong = (payload >= 8 || lone || escapes >= 4) && share >= 0.6;
    const compact = isCompactPayloadLine(line.trim());
    const weak = !strong && payload >= 4 && share >= 0.3;
    lines.push({ index, payload: strong ? payload : 0, weak: compact ? line.trim().length : weak ? payload : 0 });
  });
  return lines;
}

/** The largest block of payload lines (blank lines continue a block; any other line ends it). */
export function largestPayloadBlock(text: string) {
  let block = 0;
  let largest = 0;
  let hashLines = 0;
  let hashChars = 0;
  for (const line of payloadLines(text)) {
    if (line.hash) {
      // Hash lists continue a block; past the allowance they count as payload.
      hashLines += 1;
      hashChars += line.hash;
      if (hashLines === HASH_LINES_ALLOWED + 1) block += hashChars;
      else if (hashLines > HASH_LINES_ALLOWED) block += line.hash;
    } else if (line.payload) block += line.payload;
    else if (line.weak && block > 0) block += line.weak;
    else {
      block = 0;
      hashLines = 0;
      hashChars = 0;
    }
    largest = Math.max(largest, block);
  }
  return largest;
}

/** Control characters other than tab, newline and carriage return mean binary content. */
const BINARY = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** A picture whose destination is the file itself, however small. */
const DATA_IMAGE = /!\[[^\]\n]*\]\(\s*<?data:|<(?:img|source)\b[^>]*\b(?:src|srcset)\s*=\s*["']?\s*data:|^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?data:/im;
/**
 * Markdown with its code taken out: fenced blocks (``` or ~~~, any length)
 * and inline code spans (any number of backticks). Code shows examples; a
 * picture or address in code is not one.
 */
export function withoutCode(markdown: string): string {
  return markdown
    .replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm, " ")
    .replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, " ");
}

interface Payload {
  binary: boolean;
  /** A picture stored in the text. */
  image: boolean;
  data: number;
  encoded: number;
  /** One unbroken run of base64 or hex. */
  run: boolean;
  /** Payload lines: within one text its largest block; across a value's fields, the total of the substantial ones. */
  block: number;
}

const nothing = (): Payload => ({ binary: false, image: false, data: 0, encoded: 0, run: false, block: 0 });

/** Adds the file-like content in one piece of text to `into`. */
function measure(text: string, into: Payload, minBlock = 0) {
  if (BINARY.test(text)) into.binary = true;
  const framed = ascii85Payload(text);
  if (framed >= minBlock) into.block += framed;
  // Measure frames before reference removal and do not count their bytes twice.
  text = replaceAscii85(text, " ");
  if (/data:/i.test(text) && DATA_IMAGE.test(withoutCode(text))) into.image = true;
  for (const match of text.matchAll(DATA_URI)) into.data += match[1]!.length;
  const rest = text.replace(DATA_URI, " ").replace(WEB_ADDRESS, " ");
  for (const match of rest.matchAll(ENCODED_TOKEN)) if (looksEncoded(match[0])) into.encoded += match[0].length;
  if (HEX_RUN.test(rest) || ENCODED_RUN.test(rest)) into.run = true;
  const block = largestPayloadBlock(rest);
  if (block >= minBlock) into.block += block;
  return into;
}

function verdict(payload: Payload): string | null {
  if (payload.binary) return "binary content";
  if (payload.image) return "a picture stored in the text (a data: address)";
  if (payload.data > DATA_PAYLOAD_LIMIT) return "an embedded file (data: addresses)";
  if (payload.run || payload.block > PAYLOAD_BLOCK_LIMIT || payload.encoded > ENCODED_LIMIT) return "an encoded file (base64, hex or a list of bytes)";
  return null;
}

/** What kind of embedded file a piece of text contains, if any. */
export function embeddedFileIn(text: string): string | null {
  return verdict(measure(text, nothing()));
}

/** Text with embedded files replaced by `placeholder` (for history, which cannot be edited). */
export function withoutEmbeddedFiles(text: string, placeholder: string): string {
  if (!embeddedFileIn(text)) return text;
  const cleaned = replaceAscii85(text, placeholder)
    .replace(new RegExp(BINARY.source, "g"), "")
    // History only: every data: address goes, however short.
    .replace(DATA_URI, () => placeholder)
    .replace(new RegExp(HEX_RUN.source, "g"), placeholder)
    .replace(new RegExp(ENCODED_RUN.source, "g"), placeholder)
    .replace(ENCODED_TOKEN, (token) => looksEncoded(token) ? placeholder : token);
  // Every payload line becomes the placeholder, one per block.
  const lines = cleaned.split(/\r?\n/);
  const payload = new Set(payloadLines(cleaned).filter((line) => line.payload).map((line) => line.index));
  const out: string[] = [];
  lines.forEach((line, index) => {
    if (!payload.has(index)) out.push(line);
    else if (out.at(-1) !== placeholder) out.push(placeholder);
  });
  // Pieces already replaced line by line leave a column of placeholders: keep one.
  return out.filter((line, index) => !(line.trim() === placeholder && out[index - 1]?.trim() === placeholder)).join("\n");
}

/**
 * A structured value (an old card, a history entry) with embedded files taken
 * out: strings cleaned, offending keys renamed, long number lists dropped.
 * For history, which cannot be edited.
 */
export function withoutEmbeddedValue<T>(value: T, placeholder: string): T {
  // Substantial framed pieces can add up across history fields even when no
  // individual field reaches the limit. Preserve short standalone examples.
  const framedIn = (entry: unknown): number => {
    if (typeof entry === "string") { const count = ascii85Payload(entry); return count >= FIELD_BLOCK_MIN ? count : 0; }
    if (Array.isArray(entry)) return entry.reduce<number>((sum, item) => sum + framedIn(item), 0);
    if (entry && typeof entry === "object") return Object.entries(entry).reduce((sum, [key, item]) => sum + framedIn(key) + framedIn(item), 0);
    return 0;
  };
  const splitFrames = framedIn(value) > PAYLOAD_BLOCK_LIMIT;
  const substantialFrames = (text: string) => splitFrames && ascii85Payload(text) >= FIELD_BLOCK_MIN;
  const clean = (entry: unknown): unknown => {
    if (typeof entry === "string") return withoutEmbeddedFiles(substantialFrames(entry) ? replaceAscii85(entry, placeholder) : entry, placeholder);
    if (Array.isArray(entry)) {
      return entry.length > 16 && entry.every((item) => typeof item === "number") ? [] : entry.map(clean);
    }
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry).map(([key, item], index) => [embeddedFileIn(key) || substantialFrames(key) ? `${placeholder} ${index}` : key, clean(item)]));
    }
    return entry;
  };
  return clean(value) as T;
}

/** Numbers standing in for bytes: a long array of small whole numbers. */
const BYTES_ARRAY_LIMIT = 1024;

function refuse(where: string, found: string): never {
  throw new PlanbanValidationError(`Not saved: ${where} contains ${found}. ${INDEX_NOT_STORAGE}`);
}

function checkSize(bytes: number, where: string, maxBytes: number) {
  if (bytes > maxBytes) {
    throw new PlanbanValidationError(`Not saved: ${where} is ${Math.ceil(bytes / 1024)} KB; the limit is ${Math.floor(maxBytes / 1024)} KB. Keep long material where it lives and link to it. ${HOW_TO_REFER}`);
  }
}

/**
 * Checks any structured value bound for a board (card fields, metadata,
 * board details, history entries): every key and string for embedded files,
 * added up across the whole value; long number arrays for bytes; and the
 * whole for size.
 */
export function checkIndexValue(value: unknown, where: string, maxBytes: number) {
  const payload = nothing();
  let numbersInLists = 0;
  // Fields that are exactly one hash (asset checksums, commits) are normal in
  // card metadata; only very many of them together look like a split file.
  let hashFields = 0;
  let hashChars = 0;
  const visit = (entry: unknown) => {
    if (typeof entry === "string") {
      if (/^[0-9a-fA-F]{32}$|^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$|^[0-9a-fA-F]{128}$/.test(entry)) {
        hashFields += 1;
        hashChars += entry.length;
        return;
      }
      // Short fields (dates, ids, tags) never add up to a file; pieces of one do.
      measure(entry, payload, FIELD_BLOCK_MIN);
    } else if (Array.isArray(entry)) {
      // Numbers in lists add up across the whole value, however they are nested.
      numbersInLists += entry.filter((item) => typeof item === "number").length;
      if (numbersInLists > BYTES_ARRAY_LIMIT) refuse(where, "long lists of numbers, which is how files are smuggled in");
      for (const item of entry) visit(item);
    } else if (entry && typeof entry === "object") {
      for (const [key, item] of Object.entries(entry)) {
        measure(key, payload, FIELD_BLOCK_MIN);
        visit(item);
      }
    }
  };
  visit(value);
  if (hashFields > HASH_FIELDS_LIMIT) payload.block += hashChars;
  const found = verdict(payload);
  if (found) refuse(where, found);
  checkSize(new TextEncoder().encode(JSON.stringify(value) ?? "").length, where, maxBytes);
}

/** Refuses text that embeds a file or is too large for an index. `where` names it for the person, e.g. "the Spec of card x". */
export function checkIndexText(text: string, where: string, maxBytes: number) {
  const found = embeddedFileIn(text);
  if (found) refuse(where, found);
  checkSize(new TextEncoder().encode(text).length, where, maxBytes);
}

export function checkIndexDocument(markdown: string, cardId: string, kind: string) {
  checkIndexText(markdown, `the ${kind === "plan" ? "Plan" : "Spec"} of card ${cardId}`, MAX_DOCUMENT_BYTES);
}

/** Checks one card's own fields (title, summary, notes, metadata and the rest). */
export function checkIndexCard(card: { id: string }) {
  checkIndexValue(card, `card ${card.id}`, MAX_CARD_BYTES);
}
