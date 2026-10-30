import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { checkIndexCard, checkIndexDocument, embeddedFileIn, MAX_DOCUMENT_BYTES } from "../src/core/contentRules";

const pngBase64 = Buffer.alloc(3000, 7).toString("base64");

test("Online Boards refuse embedded files in any form, and say how to refer to them instead", () => {
  assert.match(embeddedFileIn(`![shot](data:image/png;base64,${pngBase64.slice(0, 400)})`)!, /data: address/);
  assert.match(embeddedFileIn(`<img src="data:image/jpeg;base64,${pngBase64.slice(0, 400)}">`)!, /data: address/);
  // Forms that slip past a simple pattern: no type, not base64, or base64 wrapped over lines.
  assert.match(embeddedFileIn(`data:;base64,${pngBase64.slice(0, 400)}`)!, /data: address/);
  assert.match(embeddedFileIn(`data:text/plain,${"hello%20file%0A".repeat(40)}`)!, /data: address/);
  assert.match(embeddedFileIn(pngBase64.match(/.{1,76}/g)!.join("\n"))!, /base64/);
  assert.match(embeddedFileIn(`> ${pngBase64.match(/.{1,64}/g)!.join("\n> ")}`)!, /base64/);
  assert.match(embeddedFileIn(pngBase64)!, /base64/);
  assert.match(embeddedFileIn("PK\u0003\u0004 zipped")!, /binary/);
  assert.throws(() => checkIndexDocument(`Renders:\n\n![front](data:image/png;base64,${pngBase64})`, "alpha", "spec"),
    /Not saved: the Spec of card alpha contains (an embedded file|a picture stored in the text).*GitHub link.*local path labelled with its machine/s);
  assert.throws(() => checkIndexCard({ id: "alpha", summary: `See ${pngBase64}` }), /card alpha contains an encoded file/);
});

test("ordinary planning text is never mistaken for a file", () => {
  const prose = [
    "# Plan\n\nSee https://github.com/pjk-hq/northfold/blob/main/renders/front.png and Mac mini: ~/Projects/northfold/renders/front.png.",
    "| a | b |\n|---|---|\n| 1 | 2 |\n\tindented code\r\n",
    `Commit ${"a3f9".repeat(10)}; hash sha256-${"Zm9v".repeat(40)}`,
    "```ts\nconst x = `data:${type};base64,` + body; // code that mentions data URIs is fine\n```",
    "Reject input such as `data:image/png;base64,AAAA` in the upload validator.",
    "Short examples like data:text/plain,hello%20file are prose, not files.",
  ].join("\n\n");
  assert.equal(embeddedFileIn(prose), null);
  checkIndexDocument(prose, "alpha", "plan");
  checkIndexCard({ id: "alpha", title: "Choose the supplier", summary: prose.slice(0, 500) });
});

test("documents and cards have size limits above any real board's", () => {
  checkIndexDocument("word ".repeat(120 * 1024), "alpha", "plan");
  assert.throws(() => checkIndexDocument("word ".repeat(MAX_DOCUMENT_BYTES / 4), "alpha", "plan"), /limit is 1024 KB.*link to it/s);
  checkIndexCard({ id: "alpha", summary: "y ".repeat(30 * 1024) });
  assert.throws(() => checkIndexCard({ id: "alpha", summary: "y ".repeat(70 * 1024) }), /card alpha is .* KB; the limit is 128 KB/);
});

test("numbers standing in for bytes, and oversized details, are refused wherever they hide", async () => {
  const { checkIndexValue } = await import("../src/core/contentRules");
  assert.throws(() => checkIndexCard({ id: "alpha", metadata: { logo: Array.from({ length: 4000 }, (_, i) => i % 256) } }), /long lists? of numbers/);
  checkIndexCard({ id: "alpha", metadata: { scores: [1, 2, 3] } });
  assert.throws(() => checkIndexValue({ summary: `data:image/png;base64,${pngBase64}` }, "a history entry", 64 * 1024), /a history entry contains an embedded file/);
});

test("history keeps its text when the files embedded in it are taken out", async () => {
  const { withoutEmbeddedFiles } = await import("../src/core/contentRules");
  const wrapped = pngBase64.match(/.{1,76}/g)!.join("\n");
  const cleaned = withoutEmbeddedFiles(`Before\n![x](data:image/png;base64,${pngBase64})\n${wrapped}\nAfter, see \`data:image/png;base64,AAAA\``, "[kept on the Mac]");
  assert.equal(embeddedFileIn(cleaned), null);
  assert.match(cleaned, /^Before\n!\[x\]\(\[kept on the Mac\]\)\n\[kept on the Mac\]\nAfter, see `\[kept on the Mac\]`$/);
});

import { randomBytes } from "node:crypto";

test("compact Markdown word tables remain prose while encoded table cells are refused", () => {
  const table = ["|North|South|East|West|", "|---|---|---|---|", ...Array(160).fill("|north|south|east|west|")].join("\n");
  assert.equal(embeddedFileIn(table), null);
  checkIndexDocument(table, "alpha", "plan");
  // A prose row must also break a preceding encoded block's continuation.
  assert.equal(embeddedFileIn(`A1+b2/C3=d4_E5-f6\n${table}`), null);
  const payload = randomBytes(4000).toString("base64").match(/.{1,40}/g)!;
  assert.ok(embeddedFileIn(["|Payload|", "|---|", ...payload.map((row) => `|${row}|`)].join("\n")));
});

test("a file split into short pieces, interleaved with prose or hidden in keys still adds up", async () => {
  const { checkIndexValue } = await import("../src/core/contentRules");
  const file = randomBytes(1825).toString("base64");
  const pieces = file.match(/.{1,200}/g)!;
  assert.match(embeddedFileIn(pieces.map((piece) => `data:text/plain;base64,${piece}`).join("\n"))!, /data: addresses/);
  assert.match(embeddedFileIn(file.match(/.{1,50}/g)!.map((piece, index) => `Step ${index}: ${piece} done.`).join("\n"))!, /base64/);
  assert.throws(() => checkIndexValue({ [`data:text/plain;base64,${file.slice(0, 439)}`]: "x" }, "card alpha", 128 * 1024), /card alpha contains an embedded file/);
  assert.throws(() => checkIndexCard({ id: "alpha", metadata: Object.fromEntries(pieces.map((piece, index) => [`k${index}`, `data:,${piece}`])) }), /embedded file/);
});

test("real planning text with addresses, hashes, ids and paths is not mistaken for a file", () => {
  const hashes = Array.from({ length: 40 }, () => randomBytes(32).toString("hex")).join("\n");
  const uuids = Array.from({ length: 60 }, () => `PROD-${crypto.randomUUID()}`).join(", ");
  const paths = Array.from({ length: 30 }, (_, index) => `codex/visualizations/2026/09/30/${crypto.randomUUID()}/revival-audit/source/${index}.md`).join("\n");
  const longUrl = `https://example.com/report?state=${randomBytes(1600).toString("base64url")}`;
  const text = ["```", hashes, "```", uuids, paths, `See ${longUrl}`, "SHA256115dbd3f4be227900acefefa17e9b98687cfd2fb6416d6db8ed604b8f7e007b4 and MA05ownerUsage/absentRetry/phone/provider"].join("\n\n");
  assert.equal(embeddedFileIn(text), null);
});

test("short pieces, plain repetitive payloads, nested byte lists and tiny pictures are all refused; examples in code are not", async () => {
  const { checkIndexValue } = await import("../src/core/contentRules");
  const random = randomBytes(3000).toString("base64");
  assert.match(embeddedFileIn(random.match(/.{1,32}/g)!.join(" and "))!, /base64/);
  const plain = Buffer.alloc(24 * 1024, 5).toString("base64");
  assert.match(embeddedFileIn(plain.match(/.{1,48}/g)!.join("\n\n"))!, /base64/);
  assert.throws(() => checkIndexCard({ id: "alpha", metadata: { a: Array(512).fill(7), b: { c: Array(512).fill(9) }, d: [Array(100).fill(1)] } }), /long lists of numbers/);
  const gif = "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
  assert.match(embeddedFileIn(`![pixel](data:image/gif;base64,${gif})`)!, /picture stored in the text/);
  assert.match(embeddedFileIn(`<img alt="x" src="data:image/gif;base64,${gif}">`)!, /picture stored in the text/);
  assert.equal(embeddedFileIn(`Use \`![pixel](data:image/gif;base64,${gif})\` as the test image.`), null);
  assert.equal(embeddedFileIn(`\`\`\`md\n![pixel](data:image/gif;base64,${gif})\n\`\`\``), null);
  checkIndexValue({ scores: [1, 2, 3], weights: [[0.5, 0.25]] }, "card alpha", 128 * 1024);
});

test("standard encoders are refused: wrapped hex, base64url, numbers in text, and pictures in any case", () => {
  const bytes = randomBytes(4096);
  assert.match(embeddedFileIn(bytes.toString("hex").match(/.{1,60}/g)!.join("\n"))!, /encoded file/);
  assert.match(embeddedFileIn(Buffer.alloc(4096, 255).toString("base64url"))!, /base64/);
  assert.match(embeddedFileIn(`const logo = [${[...bytes].join(", ")}];`)!, /encoded file/);
  assert.match(embeddedFileIn(`unsigned char logo[] = { ${[...bytes].map((b) => `0x${b.toString(16)}`).join(", ")} };`)!, /encoded file/);
  const gif = "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
  assert.match(embeddedFileIn(`![pixel](DATA:image/gif;base64,${gif})`)!, /picture stored/);
  assert.match(embeddedFileIn(`[pixel]: Data:image/gif;base64,${gif}`)!, /picture stored/);
});

test("hash lists, code examples and ordinary numbers stay fine", () => {
  const gif = "R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
  const text = [
    Array.from({ length: 40 }, () => randomBytes(32).toString("hex")).join("\n"),
    "These are the release checksums; the commits follow.",
    "Commits: " + Array.from({ length: 60 }, () => randomBytes(20).toString("hex")).join(" and "),
    `~~~md\n![pixel](data:image/gif;base64,${gif})\n~~~`,
    "````\n```\n![pixel](data:image/gif;base64," + gif + ")\n```\n````",
    "Use ``![pixel](data:image/gif;base64," + gif + ")`` in the test.",
    "Sizes: 1, 2, 3, 5, 8, 13, 21, 34 and 55.",
  ].join("\n\n");
  assert.equal(embeddedFileIn(text), null);
});

test("a card may hold many single-hash fields, but not a file split into them", async () => {
  const { checkIndexValue } = await import("../src/core/contentRules");
  checkIndexValue({ id: "alpha", metadata: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`asset${i}Sha256`, randomBytes(32).toString("hex")])) }, "card alpha", 128 * 1024);
  const file = randomBytes(4096).toString("hex").match(/.{64}/g)!;
  assert.throws(() => checkIndexValue({ id: "alpha", metadata: Object.fromEntries(file.map((piece, i) => [`p${i}`, piece])) }, "card alpha", 128 * 1024), /encoded file/);
});

test("every common way an encoder writes a file is refused, at any wrapping", () => {
  const f = randomBytes(4096);
  const ff = Buffer.alloc(4096, 255);
  const variants: Record<string, string> = {
    "base64 at 48": f.toString("base64").match(/.{1,48}/g)!.join("\n"),
    "repetitive base64 with blank lines": ff.toString("base64").match(/.{1,48}/g)!.join("\n\n"),
    "repetitive base64url at 32": ff.toString("base64url").match(/.{1,32}/g)!.join("\n"),
    "hex at 16": f.toString("hex").match(/.{1,16}/g)!.join("\n"),
    "hex at 32": f.toString("hex").match(/.{1,32}/g)!.join("\n"),
    "hex at 64": f.toString("hex").match(/.{1,64}/g)!.join("\n"),
    "xxd's default dump": f.toString("hex").match(/.{1,32}/g)!.map((line, i) => `${(i * 16).toString(16).padStart(8, "0")}: ${line.match(/.{1,4}/g)!.join(" ")}  ................`).join("\n"),
    "byte rows of 16": "[\n" + [...f].map(String).join(",").match(/(?:\d+,?){1,16}/g)!.join("\n") + "\n]",
    "quoted hex bytes": JSON.stringify([...f].map((b) => `0x${b.toString(16)}`)),
    "a C array": [...f].map((b) => `0x${b.toString(16).padStart(2, "0")}`).join(", ").match(/(?:0x..,? ?){1,12}/g)!.join("\n"),
    "base64 between words": f.toString("base64").match(/.{1,50}/g)!.map((piece, i) => `Step ${i}: ${piece} done.`).join("\n"),
  };
  for (const [name, text] of Object.entries(variants)) assert.match(embeddedFileIn(text) ?? "missed", /encoded file/, name);
});

// Small stand-ins for common encoders, so the tests need no outside tools.
const B85 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
const A85 = Array.from({ length: 85 }, (_, index) => String.fromCharCode(33 + index)).join("");
function base85(bytes: Buffer, alphabet = B85) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j += 1) n = n * 256 + (bytes[i + j] ?? 0);
    let chunk = "";
    for (let j = 0; j < 5; j += 1) { chunk = alphabet[n % 85] + chunk; n = Math.floor(n / 85); }
    out += chunk;
  }
  return out;
}
function uuencode(bytes: Buffer) {
  const lines = ["begin 644 x.bin"];
  for (let i = 0; i < bytes.length; i += 45) {
    const part = bytes.subarray(i, i + 45);
    let line = String.fromCharCode(32 + part.length);
    for (let j = 0; j < part.length; j += 3) {
      const [a = 0, b = 0, c = 0] = part.subarray(j, j + 3);
      for (const v of [a >> 2, ((a & 3) << 4) | (b >> 4), ((b & 15) << 2) | (c >> 6), c & 63]) line += String.fromCharCode(v === 0 ? 96 : 32 + v);
    }
    lines.push(line);
  }
  return [...lines, "`", "end"].join("\n");
}
const pythonRepr = (bytes: Buffer) => "b'" + [...bytes].map((b) => b >= 32 && b < 127 && b !== 39 && b !== 92 ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`).join("") + "'";
const odChars = (bytes: Buffer) => (bytes.toString("hex").match(/.{1,32}/g) ?? []).map((row) => "    " + (row.match(/../g) ?? []).map((h) => {
  const b = parseInt(h, 16);
  return (b >= 33 && b < 127 ? String.fromCharCode(b) : b.toString(8).padStart(3, "0")).padStart(4);
}).join("")).join("\n");

test("explicit ASCII85 frames refuse incidental URL punctuation and redact the whole file", async () => {
  const { withoutEmbeddedFiles, checkIndexValue } = await import("../src/core/contentRules");
  const { checkDocuments, checkImportedExtras } = await import("../online/service/convex/model/indexRules");
  const bytes = Buffer.concat(Array.from({ length: 96 }, (_, index) => createHash("sha256").update(`126:${index}`).digest()));
  const encoded = base85(bytes, A85);
  assert.ok(encoded.includes("://"), "the fixed trigger must retain the reference-like row");
  for (const width of [1, 32, 75, encoded.length]) {
    const frame = "<~" + encoded.match(new RegExp(`.{1,${width}}`, "g"))!.join("\n") + "~>";
    const text = `Before\n${frame}\nAfter`;
    assert.match(embeddedFileIn(text)!, /encoded file/);
    assert.throws(() => checkIndexDocument(text, "alpha", "spec"), /encoded file/);
    assert.throws(() => checkIndexValue({ summary: text }, "card alpha", 128 * 1024), /encoded file/);
    assert.throws(() => checkDocuments([{ cardId: "alpha", kind: "spec", markdown: text }]), /encoded file/);
    assert.throws(() => checkImportedExtras({ history: [{ entry: { summary: text } }] }), /encoded file/);
    assert.equal(withoutEmbeddedFiles(text, "[external file]"), "Before\n[external file]\nAfter");
    assert.match(embeddedFileIn("```\n" + frame + "\n```")!, /encoded file/);
  }
});

test("ASCII85 whitespace, zero shorthand, partial groups and exact payload budgets are consistent", async () => {
  const { withoutEmbeddedFiles } = await import("../src/core/contentRules");
  const atLimit = "<~" + "z".repeat(614) + "!!~>";
  assert.equal(embeddedFileIn(atLimit), null, "3072 equivalent payload characters are within the budget");
  assert.equal(withoutEmbeddedFiles(atLimit, "removed"), atLimit);
  assert.match(embeddedFileIn("<~" + "z".repeat(614) + "!!!~>")!, /encoded file/);
  const compressed = "<~\n" + "z \t\r\n".repeat(768) + "~>";
  assert.match(embeddedFileIn(compressed)!, /encoded file/);
  assert.equal(withoutEmbeddedFiles(`Before ${compressed} after`, "removed"), "Before removed after");
  for (const count of [1, 2, 3]) {
    const final = base85(Buffer.alloc(count, 42), A85).slice(0, count + 1);
    const frame = "<~" + "z".repeat(768) + final + "~>";
    assert.equal(withoutEmbeddedFiles(`Before ${frame} after`, "removed"), "Before removed after");
  }
  const examples = "Short <~87cURD]j7BEbo80~> example, <~z~>, <~!~>, <~uu~>, <~uuuuu~>, <~!z!!!!~> and <~not closed.";
  assert.equal(embeddedFileIn(examples), null);
  assert.equal(withoutEmbeddedFiles(examples, "removed"), examples);
  const malformed = "Before <~" + "z".repeat(768) + "v~> after";
  assert.equal(withoutEmbeddedFiles(malformed, "removed"), malformed, "malformed frames are not swallowed as valid spans");
});

test("ASCII85 framed pieces aggregate across fields and history cleanup preserves ordinary examples", async () => {
  const { checkIndexValue, withoutEmbeddedValue } = await import("../src/core/contentRules");
  const piece = "<~" + "z".repeat(200) + "~>";
  const value = { title: "Ordinary", a: piece, nested: [piece, { [piece]: piece }], example: "A short <~z~> example" };
  assert.throws(() => checkIndexValue(value, "history", 64 * 1024), /encoded file/);
  const clean = withoutEmbeddedValue(value, "[external file]");
  assert.deepEqual(clean, { title: "Ordinary", a: "[external file]", nested: ["[external file]", { "[external file] 0": "[external file]" }], example: value.example });
  checkIndexValue(clean, "history", 64 * 1024);
  assert.match(embeddedFileIn(Array(4).fill(piece).join(" prose "))!, /encoded file/);
  assert.equal(embeddedFileIn(Array(100).fill("<~z~>").join("\n")), null, "short independent examples do not count as dense lines twice");
});

test("today's encoders are refused too: uuencode, base85, ASCII85, Python bytes, od, one byte per line, repetitive lowercase", () => {
  const f = randomBytes(3072);
  const variants: Record<string, string> = {
    uuencode: uuencode(f),
    base85: base85(f),
    "ASCII85 (Adobe)": "<~" + (base85(f, "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstu").match(/.{1,75}/g) ?? []).join("\n") + "~>",
    "Python bytes": pythonRepr(f),
    "od -c": odChars(f),
    "one byte per line": JSON.stringify([...Buffer.alloc(8192, 42)], null, 2),
    "repetitive lowercase base64": (Buffer.alloc(8192, 0xaa).toString("base64").match(/.{1,64}/g) ?? []).join("\n"),
    "base64 at 16": (f.toString("base64").match(/.{1,16}/g) ?? []).join("\n"),
    "zero bytes in a JSON string": JSON.stringify(Buffer.alloc(4096).toString("latin1")),
  };
  for (const [name, text] of Object.entries(variants)) assert.match(embeddedFileIn(text) ?? "missed", /encoded file|binary/, name);
});

test("round 10's shapes are refused, and a real card's long hash list is not", async () => {
  const { checkIndexValue } = await import("../src/core/contentRules");
  const zeros = Buffer.alloc(4500);
  const uuSpaces = ["begin 644 z.bin", ...Array.from({ length: Math.ceil(zeros.length / 45) }, (_, i) => "M" + " ".repeat(60)), " ", "end"].join("\n");
  const f = randomBytes(8192);
  const b85w32 = (base85(f).match(/.{1,32}/g) ?? []).join("\n");
  const variants: Record<string, string> = {
    "uuencode of zero bytes, with spaces": uuSpaces,
    "base85 at 32": b85w32,
    "one hex byte per line": [...f.subarray(0, 4096)].map((b) => b.toString(16).padStart(2, "0")).join("\n"),
  };
  for (const [name, text] of Object.entries(variants)) assert.match(embeddedFileIn(text) ?? "missed", /encoded file/, name);
  // A real Revival card (an old version) listed 91 commit hashes in its metadata.
  checkIndexValue({ id: "revival-target-state-architecture", metadata: Object.fromEntries(Array.from({ length: 91 }, (_, i) => [`commit${i}`, randomBytes(20).toString("hex")])) }, "card", 128 * 1024);
  checkIndexValue({ id: "x", summary: Array.from({ length: 91 }, (_, i) => `- release ${i}: ${randomBytes(20).toString("hex")}`).join("\n") }, "card", 128 * 1024);
});

test("base85 and ASCII85 keep accumulating across ordinary narrow and wide wraps", () => {
  const ascii85Alphabet = "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstu";
  // Fixed seeds cover rows with little punctuation and keep failures reproducible.
  for (const seed of [...Array.from({ length: 20 }, (_, i) => i), 30]) {
    const f = Buffer.concat(Array.from({ length: 141 }, (_, i) => createHash("sha256").update(`${seed}:${i}`).digest())).subarray(0, 4500);
    for (const width of [16, 32, 40, 64, 75, 80]) {
      const wrap = (text: string) => text.match(new RegExp(`.{1,${width}}`, "g"))!.join("\n");
      assert.match(embeddedFileIn(wrap(base85(f))) ?? "missed", /encoded file/, `base85 at ${width}, seed ${seed}`);
      assert.match(embeddedFileIn("<~" + wrap(base85(f, ascii85Alphabet)) + "~>") ?? "missed", /encoded file/, `ASCII85 at ${width}, seed ${seed}`);
    }
  }
});

test("prose in scripts without spaces between words is text, not an encoded file", () => {
  const chinese = Array.from({ length: 300 }, (_, i) => `第${i}行：俱乐部的球衣设计需要更多颜色，我们下周再讨论第${i % 7}个方案。`).join("\n");
  const japanese = Array.from({ length: 300 }, (_, i) => `${i}行目：クラブのユニフォームのデザインには、もっと色が必要です。`).join("\n");
  const thai = Array.from({ length: 300 }, (_, i) => `บรรทัดที่${i}ชุดของสโมสรต้องการสีเพิ่มเติมเราจะคุยกันสัปดาห์หน้า`).join("\n");
  for (const text of [chinese, japanese, thai]) assert.equal(embeddedFileIn(text), null);
  // ASCII encodings are still caught, also beside such prose.
  const base64 = Array.from({ length: 80 }, () => "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk=").join("\n");
  assert.ok(embeddedFileIn(`${chinese.slice(0, 200)}\n\n${base64}`));
});

test("an ASCII encoding padded with text in another script is still an encoded file", () => {
  const bytes = randomBytes(4096);
  const pad = (lines: string[], with_: string) => lines.map((line) => line + with_).join("\n");
  const hex = pad(bytes.toString("hex").match(/.{1,32}/g)!, "中".repeat(14));
  const base64 = pad(bytes.toString("base64").match(/.{1,16}/g)!, "中文汉字".repeat(2));
  // Lines of base85's alphabet (no spaces), as an encoder wraps them.
  const alphabet = "!\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstu";
  const base85 = pad(Array.from({ length: 200 }, () => Array.from(randomBytes(32), (byte) => alphabet[byte % 85]).join("")), "汉字".repeat(10));
  for (const text of [hex, base64, base85]) assert.ok(embeddedFileIn(text), "padded payload must be refused");
  // Technical Chinese with identifiers between the characters is prose.
  assert.equal(embeddedFileIn(Array.from({ length: 300 }, (_, i) => `使用planban_get_board和planban_read_goals读取第${i}个看板的目标`).join("\n")), null);
});
