// The online service's real handlers in memory, reached the way the web page
// reaches them: through the public address with the browser's session cookie,
// the page's own header, same-origin fetch metadata and the edge's proof.
// Rows live in a small in-memory database that orders index reads by the
// schema's index fields, as Convex does. Not a test file itself.
import { createHash } from "node:crypto";
import { getFunctionName } from "convex/server";
import schema from "../online/service/convex/schema";
import { apiResponse } from "../online/service/convex/http";
import { EDGE_PROOF_HEADER } from "../online/service/convex/model/auth";
import { webCookieName } from "../online/service/convex/model/webSession";
import * as boards from "../online/service/convex/boards";
import * as connections from "../online/service/convex/connections";
import * as copies from "../online/service/convex/copies";
import * as erasure from "../online/service/convex/erasure";
import * as invites from "../online/service/convex/invites";
import * as live from "../online/service/convex/live";
import * as members from "../online/service/convex/members";
import * as oauth from "../online/service/convex/oauth";
import * as people from "../online/service/convex/people";
import * as transfers from "../online/service/convex/transfers";
import * as webSessions from "../online/service/convex/webSessions";
import { createHostedAdapter, type ServiceSend } from "../src/web/hostedAdapter";

export const PUBLIC = "https://app.planban.example";
export const NATIVE = "https://native-315.convex.example";
const PROOF = "synthetic-edge-proof-only";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export async function withServiceEnv<T>(run: () => Promise<T>): Promise<T> {
  const values: Record<string, string> = { PLANBAN_PUBLIC_URL: PUBLIC, CONVEX_SITE_URL: NATIVE, PLANBAN_EDGE_PROOF_SHA256: digest(PROOF) };
  const prior = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const indexFields = new Map<string, string[]>();
for (const [table, definition] of Object.entries((schema as any).tables as Record<string, any>)) {
  for (const index of definition.indexes ?? []) indexFields.set(`${table}.${index.indexDescriptor}`, index.fields);
}

function compare(a: unknown, b: unknown) {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return (a as any) < (b as any) ? -1 : 1;
}

/** Convex's limits on values passed to and returned from functions (https://docs.convex.dev/production/state/limits). */
export function checkConvexValue(value: unknown, where: string, depth = 0) {
  if (depth > 64) throw new Error(`${where}: Convex values nest at most 64 levels`);
  if (Array.isArray(value)) {
    if (value.length > 8192) throw new Error(`${where}: Convex arrays hold at most 8192 items`);
    for (const item of value) checkConvexValue(item, where, depth + 1);
  } else if (value && typeof value === "object" && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) {
    const keys = Object.keys(value);
    if (keys.length > 1024) throw new Error(`${where}: Object has too many fields (${keys.length} > maximum number 1024)`);
    for (const key of keys) checkConvexValue((value as Record<string, unknown>)[key], where, depth + 1);
  }
}

export function memoryService() {
  /** Paginated queries run by the function being called (Convex allows one). */
  let paginations = 0;
  const rows: any[] = [];
  const jobs: Array<{ name: string; args: unknown }> = [];
  let sequence = 0;
  const db: any = {
    get: async (id: string) => rows.find((row) => row._id === id) ?? null,
    insert: async (table: string, value: any) => {
      // Stored documents follow Convex's value rules too.
      checkConvexValue(value, `${table} document`);
      const id = `${table}-${++sequence}`;
      rows.push({ ...value, _id: id, _table: table, _creationTime: sequence });
      return id;
    },
    patch: async (id: string, patch: any) => {
      const row = rows.find((entry) => entry._id === id);
      checkConvexValue(patch, `${row?._table ?? "row"} patch`);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete row[key];
        else row[key] = value;
      }
    },
    replace: async (id: string, value: any) => {
      const row = rows.find((entry) => entry._id === id);
      checkConvexValue(value, `${row?._table ?? "row"} document`);
      for (const key of Object.keys(row)) if (!key.startsWith("_")) delete row[key];
      Object.assign(row, value);
    },
    delete: async (id: string) => {
      rows.splice(rows.findIndex((row) => row._id === id), 1);
    },
    normalizeId: (table: string, id: string) => (rows.some((row) => row._id === id && row._table === table) ? id : null),
    query: (table: string) => {
      let match = (row: any) => row._table === table;
      let fields: string[] = [];
      let descending = false;
      const ordered = () => {
        const found = rows.filter(match).sort((a, b) => {
          for (const field of fields) {
            const order = compare(a[field], b[field]);
            if (order) return order;
          }
          return a._creationTime - b._creationTime;
        });
        return descending ? found.reverse() : found;
      };
      const query: any = {
        withIndex: (name: string, range?: (q: any) => any) => {
          fields = indexFields.get(`${table}.${name}`) ?? [];
          if (!indexFields.has(`${table}.${name}`)) throw new Error(`No index ${name} on ${table}`);
          const q: any = {};
          const add = (test: (a: any, b: any) => boolean) => (field: string, value: any) => {
            const prior = match;
            match = (row) => prior(row) && test(row[field], value);
            return q;
          };
          q.eq = add((a, b) => a === b);
          q.lt = add((a, b) => a !== undefined && a < b);
          q.lte = add((a, b) => a !== undefined && a <= b);
          q.gt = add((a, b) => a !== undefined && a > b);
          q.gte = add((a, b) => a !== undefined && a >= b);
          range?.(q);
          return query;
        },
        order: (direction: string) => {
          descending = direction === "desc";
          return query;
        },
        unique: async () => {
          const found = rows.filter(match);
          if (found.length > 1) throw new Error(`unique() found ${found.length} ${table} rows`);
          return found[0] ?? null;
        },
        first: async () => ordered()[0] ?? null,
        collect: async () => ordered(),
        take: async (count: number) => ordered().slice(0, count),
        paginate: async ({ numItems, cursor, maximumBytesRead }: { numItems: number; cursor: string | null; maximumBytesRead?: number }) => {
          // As Convex: a function may run only one paginated query.
          paginations += 1;
          if (paginations > 1) throw new Error("This query or mutation function ran multiple paginated queries. Convex only supports a single paginated query in each function.");
          const all = ordered();
          const start = cursor ? Number(cursor) : 0;
          let end = Math.min(start + numItems, all.length);
          // Like Convex, a page also ends once it has read maximumBytesRead (always at least one row).
          if (maximumBytesRead !== undefined) {
            let read = 0;
            for (let index = start; index < end; index += 1) {
              read += JSON.stringify(all[index], (_key, value) => (value instanceof ArrayBuffer ? "x".repeat(value.byteLength) : value)).length;
              if (read > maximumBytesRead && index > start) { end = index; break; }
            }
          }
          return { page: all.slice(start, end), isDone: end >= all.length, continueCursor: String(end) };
        },
        async *[Symbol.asyncIterator]() {
          for (const row of ordered()) yield row;
        },
      };
      return query;
    },
  };
  const scheduler = { runAfter: async (_delay: number, ref: any, args: any) => { jobs.push({ name: getFunctionName(ref), args }); } };
  const ctx: any = { db, scheduler };
  const modules: Record<string, Record<string, any>> = { boards, connections, copies, erasure, invites, live, members, oauth, people, transfers, webSessions };
  const byName = new Map<string, any>();
  for (const [module, exports] of Object.entries(modules)) {
    for (const [name, fn] of Object.entries(exports)) if (fn && (typeof fn === "object" || typeof fn === "function") && "_handler" in fn) byName.set(`${module}:${name}`, fn);
  }
  const call = async (ref: any, args: any) => {
    const fn = byName.get(getFunctionName(ref));
    if (!fn) throw new Error(`No handler for ${getFunctionName(ref)}`);
    // As Convex does: arguments and results must be valid Convex values, so a board
    // shaped beyond its limits fails here, in tests, rather than on a deployment.
    checkConvexValue(args, `${getFunctionName(ref)} arguments`);
    const outer = paginations;
    paginations = 0;
    const result = await fn._handler(ctx, args).finally(() => { paginations = outer; });
    checkConvexValue(result, `${getFunctionName(ref)} result`);
    return result;
  };
  const actionCtx: any = {
    runQuery: call,
    runMutation: call,
    runAction: async (ref: any, args: any) => { jobs.push({ name: getFunctionName(ref), args }); },
    scheduler,
  };

  /** A person signed in on the web: their browser session cookie and web connection. */
  async function signIn(userId: string, name = userId) {
    const token = `pbw_${createHash("sha256").update(`${userId}-${sequence}`).digest("base64url").slice(0, 43)}`;
    const { connectionId } = await webSessions.enroll._handler(ctx, { userId, clerkSessionId: `sess_${userId}_${sequence}`, tokenHash: digest(token) } as any);
    if (!rows.some((row) => row._table === "people" && row.userId === userId)) await db.insert("people", { userId, name, updatedAt: new Date().toISOString() });
    return { token, connectionId: connectionId as string, userId };
  }

  /** What the browser and the edge add to each request the page makes. */
  function browserSend(token: string, log?: Array<{ path: string; method: string; headers: Record<string, string>; body?: string }>): ServiceSend {
    return async (path, init) => {
      log?.push({ path, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
      const headers = new Headers(init.headers);
      headers.set("Cookie", `${webCookieName(PUBLIC)}=${token}`);
      headers.set(EDGE_PROOF_HEADER, PROOF);
      if (init.method !== "GET") {
        headers.set("Origin", PUBLIC);
        headers.set("Sec-Fetch-Site", "same-origin");
      }
      return apiResponse(actionCtx, new Request(`${NATIVE}${path}`, { method: init.method, headers, ...(init.body === undefined ? {} : { body: init.body }) }));
    };
  }

  function adapterFor(token: string, options: { log?: Parameters<typeof browserSend>[1]; send?: ServiceSend } = {}) {
    return createHostedAdapter({ origin: PUBLIC, send: options.send ?? browserSend(token, options.log), retryDelayMs: 0 });
  }

  /** The live:revision query as Convex runs it for a subscriber signed in as this connection. */
  async function liveRevision(connectionId: string, boardId: string) {
    return live.revision._handler({ db, auth: { getUserIdentity: async () => ({ subject: connectionId }) } } as any, { boardId } as any);
  }

  /** Runs scheduled work, and what it schedules in turn, until none is left (or a job isn't one of the modules above). */
  async function runJobs(limit = 1000) {
    for (let ran = 0; jobs.length && ran < limit; ran += 1) {
      const job = jobs.shift()!;
      const fn = byName.get(job.name);
      if (!fn) continue;
      // Each scheduled job is its own function call.
      paginations = 0;
      await fn._handler(fn.isAction ? actionCtx : ctx, job.args);
    }
  }

  return { rows, jobs, ctx, actionCtx, signIn, browserSend, adapterFor, liveRevision, runJobs, call };
}
