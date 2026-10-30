// Domain failures cross from mutations to HTTP actions as ConvexError data,
// which Convex preserves, and the mutation's writes are rolled back.
import { ConvexError, type Value } from "convex/values";
import { PlanbanConflictError, PlanbanNotFoundError, PlanbanValidationError } from "../../../../src/core/boardOperations";

export type ErrorCode = "conflict" | "validation" | "not_found" | "forbidden" | "unauthorized" | "rate_limited";
export type ServiceErrorData = {
  code: ErrorCode;
  message: string;
  currentRevision?: number;
  /** Invitations: why one can't be used, so the web page can show the matching screen. */
  reason?: "wrong_email" | "expired" | "cancelled" | "unavailable";
  /** Invitations sent to another address: that address, masked ("s•••@example.com"). */
  sentTo?: string;
  /** A refused edit: what changed since it was based, by whom, and the current card or document. */
  conflict?: Value;
};

export function fail(code: ErrorCode, message: string, extra: Partial<ServiceErrorData> = {}): never {
  throw new ConvexError<ServiceErrorData>({ code, message, ...extra });
}

/** Turns the shared planners' error classes into service errors. */
export function asServiceError(error: unknown, currentRevision?: number): ConvexError<ServiceErrorData> {
  if (error instanceof ConvexError) return error as ConvexError<ServiceErrorData>;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PlanbanConflictError) {
    return new ConvexError<ServiceErrorData>({ code: "conflict", message, ...(currentRevision === undefined ? {} : { currentRevision }) });
  }
  if (error instanceof PlanbanNotFoundError) return new ConvexError<ServiceErrorData>({ code: "not_found", message });
  if (error instanceof PlanbanValidationError) return new ConvexError<ServiceErrorData>({ code: "validation", message });
  // Some older planner checks throw plain errors; they are still input problems.
  if (/not found/i.test(message)) return new ConvexError<ServiceErrorData>({ code: "not_found", message });
  return new ConvexError<ServiceErrorData>({ code: "validation", message });
}
