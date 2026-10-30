// Compact storage for roadmaps and documents. The Revival roadmap is 948 KB
// as JSON, close to Convex's 1 MB document limit; compressed it is ~240 KB.
import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function packText(text: string): ArrayBuffer {
  return toBuffer(deflateSync(strToU8(text), { level: 6 }));
}

export function unpackText(bytes: ArrayBuffer): string {
  return strFromU8(inflateSync(new Uint8Array(bytes)));
}

export function packJson(value: unknown): ArrayBuffer {
  return packText(JSON.stringify(value));
}

export function unpackJson<T>(bytes: ArrayBuffer): T {
  return JSON.parse(unpackText(bytes)) as T;
}

/**
 * Board content crossing a Convex function boundary travels packed: Convex
 * values allow at most 1,024 fields per object (and limited nesting), and a
 * board's cards and history can be shaped in ways that exceed it (one of
 * Revival's cards once had 1,051 metadata fields). Planban's own limits are
 * what bound boards, not Convex's value rules.
 */
export function packed(value: unknown): { packed: ArrayBuffer } {
  return { packed: packJson(value) };
}

/** The value inside packed(…); anything else is returned unchanged. */
export function unpacked<T>(value: unknown): T {
  const box = value as { packed?: unknown } | null;
  return box && typeof box === "object" && box.packed instanceof ArrayBuffer ? unpackJson<T>(box.packed) : value as T;
}
