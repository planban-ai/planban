// One Convex deployment holds every Online Board. Each board change is one
// mutation, so the revision check, the roadmap, its documents and its history
// version commit together or not at all.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const authorityState = v.union(
  v.literal("importing"),
  v.literal("online"),
  v.literal("returned-local"),
);
export const docKind = v.union(v.literal("spec"), v.literal("plan"));
export const memberRole = v.union(v.literal("owner"), v.literal("editor"), v.literal("viewer"));
export const agentLevel = v.union(v.literal("read"), v.literal("plan"), v.literal("complete"));

export default defineSchema({
  // Internal provider monitoring, separate from per-person board write usage.
  providerUsageMonitors: defineTable({ policy: v.string(), state: v.any() }).index("by_policy", ["policy"]),
  boards: defineTable({
    boardId: v.string(),
    title: v.string(),
    ownerId: v.string(),
    authority: authorityState,
    revision: v.number(),
    /**
     * Which copy of the board's rows is live. Take Online uploads into the next
     * generation, invisible until its commit flips this pointer, so a failed
     * or abandoned upload never changes the live board.
     */
    generation: v.number(),
    /** Latest history version number; versions keep their numbers across transfers. */
    historyVersion: v.number(),
    /**
     * A Take Local in progress: the board is frozen for this transfer, and
     * its downloads read exactly this generation. Cleared when it finishes.
     */
    localTransfer: v.optional(v.object({ transferId: v.string(), generation: v.number(), userId: v.string(), at: v.string() })),
    /** The board's durable identity, carried by every local copy of it. */
    uid: v.optional(v.string()),
    /** When the board last became editable online (Take Online commit). */
    onlineSince: v.optional(v.string()),
    /** Local history retention settings carried through Take Online so Take Local restores them. */
    retention: v.optional(v.any()),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("by_boardId", ["boardId"]).index("by_uid", ["uid"]).index("by_owner", ["ownerId"]),

  /**
   * Fingerprints ("version|createdAt|operation") of every history entry a
   * board arrived with, kept even after that history is trimmed, so an old
   * local copy can still be recognised.
   */
  boardFingerprints: defineTable({
    boardId: v.string(),
    generation: v.number(),
    key: v.string(),
  }).index("by_key", ["key"]).index("by_board_generation", ["boardId", "generation"]),

  /** The whole roadmap, deflate-compressed: the shared planning rules need all of it. */
  boardState: defineTable({
    boardId: v.string(),
    generation: v.number(),
    roadmap: v.bytes(),
    /** The board's goals (src/core/goals.ts), when it has any. */
    goals: v.optional(v.bytes()),
  }).index("by_board_generation", ["boardId", "generation"]),

  /**
   * Agents' edits that were refused because something they touched changed
   * since they read it (Spec point 20). Each stays until an agent saves a
   * reconsidered version or drops it with a reason. Shown to agents only.
   */
  /**
   * Who is working on a card (Spec point 20): a heads-up, not a lock. An
   * agent's reads and edits of a card mark it, until 15 minutes after its
   * last activity.
   */
  presence: defineTable({
    boardId: v.string(),
    generation: v.number(),
    cardId: v.string(),
    connectionId: v.id("connections"),
    userId: v.string(),
    /** The app, as people know it: "Claude", "Codex", "ChatGPT". */
    app: v.string(),
    startedAt: v.number(),
    lastActiveAt: v.number(),
  }).index("by_board_card", ["boardId", "generation", "cardId"]).index("by_agent", ["boardId", "generation", "cardId", "connectionId", "app"])
    .index("by_board_active", ["boardId", "generation", "lastActiveAt"]).index("by_card_active", ["boardId", "generation", "cardId", "lastActiveAt"]).index("by_connection_active", ["connectionId", "lastActiveAt"]).index("by_active", ["lastActiveAt"]).index("by_user", ["userId"]),

  unresolvedChanges: defineTable({
    boardId: v.string(),
    generation: v.number(),
    cardId: v.string(),
    changeId: v.string(),
    userId: v.string(),
    clientName: v.string(),
    createdAt: v.string(),
    op: v.string(),
    /** What the refused edit asked for (its input, without bookkeeping). */
    /** Older rows; new ones keep the proposal packed (proposedPacked). */
    proposed: v.optional(v.any()),
    proposedPacked: v.optional(v.bytes()),
    /** The fields it touched that had changed ("spec"/"plan" for a document; "*" for the whole card). */
    fields: v.array(v.string()),
    /** The board revision when it was refused. */
    refusedAtRevision: v.number(),
    /** Plain words for the clash, as the refusal said it. */
    message: v.string(),
    /** Its stored size, counted toward the board's limit while it waits. */
    bytes: v.optional(v.number()),
  }).index("by_board_card", ["boardId", "generation", "cardId"]).index("by_changeId", ["changeId"]).index("by_user", ["userId"]),

  docs: defineTable({
    boardId: v.string(),
    generation: v.number(),
    cardId: v.string(),
    kind: docKind,
    markdown: v.bytes(),
    /** Increases on every write; the local side's document conflict check uses it as mtimeMs. */
    stamp: v.number(),
    updatedAt: v.string(),
    updatedBy: v.string(),
    /** The last write, for a conflict answer: by an agent, which app, and what it did. */
    updatedByAgent: v.optional(v.boolean()),
    updatedByClient: v.optional(v.string()),
    updateSummary: v.optional(v.string()),
  }).index("by_board_card_kind", ["boardId", "generation", "cardId", "kind"]).index("by_updatedBy", ["updatedBy"]),

  /**
   * One small row per history version: what happened, who and when. Its
   * roadmap lives in historyPayloads, so listing history stays cheap.
   */
  history: defineTable({
    boardId: v.string(),
    generation: v.number(),
    version: v.number(),
    entry: v.any(),
    /** True when the payload is a full roadmap rather than the changes since the previous version. */
    snapshot: v.boolean(),
  }).index("by_board_version", ["boardId", "generation", "version"]),

  historyPayloads: defineTable({
    boardId: v.string(),
    generation: v.number(),
    version: v.number(),
    snapshot: v.optional(v.bytes()),
    delta: v.optional(v.bytes()),
  }).index("by_board_version", ["boardId", "generation", "version"]),

  historyDocs: defineTable({
    boardId: v.string(),
    generation: v.number(),
    version: v.number(),
    cardId: v.string(),
    kind: docKind,
    markdown: v.bytes(),
  }).index("by_board_version", ["boardId", "generation", "version"])
    .index("by_board_doc_version", ["boardId", "generation", "cardId", "kind", "version"]),

  /** Ids of deleted cards, never reused, so history keeps one meaning per id. */
  retiredIds: defineTable({
    boardId: v.string(),
    generation: v.number(),
    cardId: v.string(),
  }).index("by_board_card", ["boardId", "generation", "cardId"]),

  members: defineTable({
    boardId: v.string(),
    userId: v.string(),
    role: memberRole,
    /** What this person lets their agents do on this board; see memberAgentLevel for the default. Everyone on the board can see it. */
    agentLevel: v.optional(agentLevel),
  }).index("by_board_user", ["boardId", "userId"]).index("by_user", ["userId"]).index("by_board", ["boardId"]),

  /** Invites to a board: a link anyone may use for 7 days, or an email invite for one person. Only the hash of the link's secret is kept. */
  invites: defineTable({
    boardId: v.string(),
    tokenHash: v.string(),
    role: v.union(v.literal("editor"), v.literal("viewer")),
    email: v.optional(v.string()),
    createdBy: v.string(),
    createdAt: v.string(),
    expiresAt: v.string(),
    joinedBy: v.array(v.string()),
    revokedAt: v.optional(v.string()),
  }).index("by_tokenHash", ["tokenHash"]).index("by_board", ["boardId"]).index("by_email", ["email"]).index("by_expiry", ["expiresAt"]),

  /** Who last changed each card, for faces on shared boards; survives history trimming. */
  cardChanges: defineTable({
    boardId: v.string(),
    generation: v.number(),
    cardId: v.string(),
    userId: v.string(),
    agent: v.boolean(),
    clientName: v.union(v.string(), v.null()),
    at: v.string(),
    summary: v.string(),
  }).index("by_board_generation_card", ["boardId", "generation", "cardId"]).index("by_user", ["userId"]),

  /** Stored text per board generation, history included, in bytes as stored (see model/limits.ts). */
  boardSizes: defineTable({
    boardId: v.string(),
    generation: v.number(),
    bytes: v.number(),
    /** Increases with every change to the total, so a measurement taken across several steps can tell it was overtaken. */
    epoch: v.optional(v.number()),
  }).index("by_board_generation", ["boardId", "generation"]),

  /** What each account wrote on a day (UTC), for the daily limits in model/limits.ts. */
  usage: defineTable({
    userId: v.string(),
    day: v.string(),
    writes: v.number(),
    bytes: v.number(),
    importBytes: v.number(),
    /** Invitations created, invitation emails sent and personal keys created today. */
    invites: v.optional(v.number()),
    inviteEmails: v.optional(v.number()),
    keys: v.optional(v.number()),
    /** Boards that came online today: new on the web, or taken online from a computer. */
    boards: v.optional(v.number()),
  }).index("by_user_day", ["userId", "day"]).index("by_day", ["day"]),

  /** How a person appears to others on shared boards (name and picture from the sign-in account). */
  people: defineTable({
    userId: v.string(),
    name: v.string(),
    imageUrl: v.optional(v.string()),
    email: v.optional(v.string()),
    updatedAt: v.string(),
  }).index("by_userId", ["userId"]).index("by_email", ["email"]),

  /**
   * Every credential (a machine sign-in, a remote agent's OAuth grant, a
   * personal access key, a development token) resolves to one row, checked on
   * every request, so revoking it takes effect immediately.
   */
  connections: defineTable({
    userId: v.string(),
    kind: v.union(v.literal("dev"), v.literal("machine"), v.literal("oauth"), v.literal("key"), v.literal("web")),
    name: v.string(),
    clientName: v.string(),
    /** SHA-256 of the bearer secret, for kinds Planban issues itself. */
    tokenHash: v.optional(v.string()),
    boards: v.union(v.literal("all"), v.array(v.string())),
    level: agentLevel,
    /** The person's own connection: may complete, delete, move authority and invite. */
    canAdminister: v.boolean(),
    createdAt: v.string(),
    lastUsedAt: v.string(),
    expiresAt: v.optional(v.string()),
    revokedAt: v.optional(v.string()),
    /** For an AI app's connection: the OAuth client it was authorised for. */
    oauthClientId: v.optional(v.string()),
    /** Service-owned enrollment. Legacy Clerk grants have no version. */
    authorizationVersion: v.optional(v.number()),
    oauthPending: v.optional(v.boolean()),
    oauthResource: v.optional(v.string()),
    /** The service address a dev sign-in or personal key works through; absent on older ones (see legacyOrigin). */
    serviceOrigin: v.optional(v.string()),
    /** Access credentials are aliases of an independently revocable grant. */
    oauthConnectionId: v.optional(v.id("connections")),
    /** A browser session (kind web): the Clerk session it was enrolled from, and when Clerk last confirmed it. */
    clerkSessionId: v.optional(v.string()),
    clerkCheckedAt: v.optional(v.string()),
    /** When Clerk will end that session (milliseconds), so its barrier can outlast it. */
    clerkExpiresAt: v.optional(v.number()),
  }).index("by_tokenHash", ["tokenHash"]).index("by_clerkSession", ["clerkSessionId"]).index("by_user", ["userId"]).index("by_user_client", ["userId", "oauthClientId"])
    // Every credential a person hasn't revoked, however much revoked history they have.
    .index("by_user_revoked", ["userId", "revokedAt"]),

  /**
   * Clerk sessions whose browser session was signed out or revoked. Enrolling
   * from one again is refused, so getting back in needs a fresh sign-in.
   */
  webSessionBarriers: defineTable({
    clerkSessionId: v.string(),
    createdAt: v.number(),
    /** Removed after this moment (milliseconds), once the Clerk session can no longer be live. */
    until: v.number(),
  }).index("by_clerkSession", ["clerkSessionId"]).index("by_until", ["until"]),

  /** Explicit consent, frozen client/redirect/resource/PKCE and one-use code. */
  oauthRequests: defineTable({
    requestHash: v.string(), browserHash: v.optional(v.string()), csrfHash: v.optional(v.string()), launchHash: v.optional(v.string()),
    clientId: v.string(), clientName: v.string(), redirectUri: v.string(), resource: v.string(),
    scopes: v.array(v.string()), level: agentLevel, challenge: v.string(), state: v.string(),
    purpose: v.union(v.literal("oauth"), v.literal("machine")),
    status: v.union(v.literal("awaiting_browser"), v.literal("pending"), v.literal("approved"), v.literal("denied"), v.literal("consumed")),
    expiresAt: v.number(), userId: v.optional(v.string()), sessionId: v.optional(v.string()),
    approverConnectionId: v.optional(v.id("connections")),
    connectionId: v.optional(v.id("connections")), codeHash: v.optional(v.string()), codeExpiresAt: v.optional(v.number()),
    /** One-tap approval: SHA-256 of the device code the waiting agent polls with. */
    deviceHash: v.optional(v.string()),
  }).index("by_requestHash", ["requestHash"]).index("by_deviceHash", ["deviceHash"]).index("by_launchHash", ["launchHash"]).index("by_codeHash", ["codeHash"]).index("by_expiry", ["expiresAt"]).index("by_user", ["userId"]),

  /** Rotating refresh family, including spent hashes for replay detection. */
  oauthRefresh: defineTable({
    tokenHash: v.string(), connectionId: v.id("connections"), clientId: v.string(), resource: v.string(),
    scopes: v.array(v.string()), expiresAt: v.number(), usedAt: v.optional(v.number()),
  }).index("by_tokenHash", ["tokenHash"]).index("by_connection", ["connectionId"]),

  /**
   * A reviewed client's metadata document, already validated, kept for an
   * hour so sign-in starts don't each fetch it. One row per allowed client.
   */
  oauthClientCache: defineTable({
    clientId: v.string(), name: v.string(), redirectUris: v.array(v.string()), native: v.boolean(), fetchedAt: v.number(),
  }).index("by_clientId", ["clientId"]),

  /** Bounded authorization request creation per client and time bucket. */
  /**
   * Sign-in approvals per person per hour (the stateless sign-in start): a
   * person's own limit, which no one else can use up.
   */
  signInApprovals: defineTable({ userId: v.string(), hour: v.number(), count: v.number() })
    .index("by_user_hour", ["userId", "hour"]).index("by_hour", ["hour"]),

  oauthUsage: defineTable({ clientId: v.string(), bucket: v.number(), requests: v.number(), fetches: v.optional(v.number()) })
    .index("by_client_bucket", ["clientId", "bucket"]).index("by_bucket", ["bucket"]),

  /** One transaction-owned cleanup driver; old job tickets cannot restart it. */
  /**
   * claude.ai's self-registrations (owner decision 22): only Claude's own
   * callback addresses, public clients. Unused ones expire; the first person
   * to approve one owns it, and removing it (or its connection) deletes it.
   */
  oauthRegistrations: defineTable({
    clientId: v.string(), redirectUris: v.array(v.string()), createdAt: v.number(),
    expiresAt: v.optional(v.number()), userId: v.optional(v.string()),
  }).index("by_clientId", ["clientId"]).index("by_expiry", ["expiresAt"]).index("by_user", ["userId"]),

  oauthCleanup: defineTable({ name: v.string(), ticket: v.number(), dueAt: v.optional(v.number()) })
    .index("by_name", ["name"]),

  /** Clerk's signing key set (JSON), and when it was last fetched and last attempted. */
  signingKeys: defineTable({
    name: v.string(),
    keys: v.string(),
    fetchedAt: v.number(),
    attemptedAt: v.number(),
  }).index("by_name", ["name"]),

  /**
   * Sign-in tokens the command line has already exchanged for a machine
   * sign-in. Each one works once, so a copied token cannot make another
   * sign-in, even after this one is signed out. Kept until it would be too
   * old to exchange anyway.
   */
  machineExchanges: defineTable({
    tokenHash: v.string(),
    expiresAt: v.string(),
  }).index("by_tokenHash", ["tokenHash"]).index("by_expiresAt", ["expiresAt"]),

  /** Take Online uploads, sent in parts under one transfer id. */
  transfers: defineTable({
    transferId: v.string(),
    userId: v.string(),
    boardId: v.string(),
    generation: v.number(),
    state: v.union(v.literal("open"), v.literal("committed"), v.literal("aborted")),
    /** Board revision before the upload, for boards taken online again. */
    previousRevision: v.number(),
    /** Highest history version uploaded so far. */
    maxVersion: v.number(),
    retention: v.optional(v.any()),
    uid: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("by_transferId", ["transferId"]).index("by_board_state", ["boardId", "state"]).index("by_state_updated", ["state", "updatedAt"]).index("by_user", ["userId"]),

  transferParts: defineTable({
    transferId: v.string(),
    seq: v.number(),
  }).index("by_transfer_seq", ["transferId", "seq"]),

  /**
   * Idempotency records: a retried edit with the same key returns the
   * original result instead of applying twice. Kept for seven days.
   */
  operations: defineTable({
    userId: v.string(),
    key: v.string(),
    requestHash: v.string(),
    boardId: v.string(),
    /** The operation's result and the history version it created. */
    outcome: v.bytes(),
    createdAt: v.string(),
  }).index("by_user_key", ["userId", "key"]).index("by_createdAt", ["createdAt"]),

  /**
   * Deletions still being carried out (owner decisions, 15 October 2026): a
   * board's online copy, or a whole account. Removed once nothing is left;
   * a daily sweep finishes any that stalled. See erasure.ts.
   */
  erasures: defineTable({
    kind: v.union(v.literal("board"), v.literal("account")),
    /** A board: its id, reserved until every row under it is gone. */
    boardId: v.optional(v.string()),
    /** An account: whose, the boards they owned, and whether their sign-in account (Clerk) is deleted. */
    userId: v.optional(v.string()),
    ownedBoards: v.optional(v.array(v.string())),
    clerkDeleted: v.optional(v.boolean()),
    /** Where the removal has got to, and a page cursor within that step. */
    stage: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    requestedAt: v.string(),
    doneAt: v.optional(v.string()),
  }).index("by_kind", ["kind"]).index("by_user", ["userId"]).index("by_board", ["boardId"]),

  /**
   * A GitHub repository linked to an Online Board: GitHub sends its pull
   * request merges to /api/v1/github/hooks/<linkId>, signed with this link's
   * own secret. The secret never leaves the service after the owner's
   * computer hands it to GitHub once, and is gone when the link is removed.
   */
  githubLinks: defineTable({
    linkId: v.string(),
    boardId: v.string(),
    /** "owner/name" as the owner typed it; repoKey is it lower-cased. */
    repo: v.string(),
    repoKey: v.string(),
    /** Absent once unlinking began: no delivery is accepted after that. */
    secret: v.optional(v.string()),
    /** The repository webhook's id on GitHub, so unlinking can remove it. */
    hookId: v.optional(v.number()),
    /**
     * Unlinking began but GitHub hasn't yet confirmed the webhook is gone. The
     * row keeps the webhook id until it is, so unlinking can be retried.
     */
    removing: v.optional(v.boolean()),
    /**
     * When a correctly signed ping from GitHub named this link's repository and
     * webhook id. Until then the link is unconfirmed: its merges are credited to
     * the person who set it up, and hosted surfaces don't count it as checked.
     */
    confirmedAt: v.optional(v.string()),
    /** The webhook id GitHub's ping named, kept until the linking computer records its own. */
    pingHookId: v.optional(v.number()),
    createdBy: v.string(),
    createdAt: v.string(),
    lastDelivery: v.optional(v.object({ at: v.string(), event: v.string(), outcome: v.string() })),
    /** Deliveries that wrote anything in the current hour, for the per-link limit. */
    hour: v.optional(v.number()),
    hourCount: v.optional(v.number()),
    /** The hour the limit was last reached and said so, so the refusal is noted once an hour. */
    limitedHour: v.optional(v.number()),
  }).index("by_linkId", ["linkId"]).index("by_board", ["boardId"]),

  /** GitHub delivery ids already handled, so a replayed or redelivered request does nothing. Kept for a week. */
  githubDeliveries: defineTable({
    deliveryId: v.string(),
    linkId: v.string(),
    at: v.string(),
  }).index("by_delivery", ["deliveryId"]).index("by_at", ["at"]),

  /** Pull requests a board has recorded, one row per repository and number, so each is recorded once. */
  githubMerges: defineTable({
    boardId: v.string(),
    key: v.string(),
    at: v.string(),
  }).index("by_board_key", ["boardId", "key"]),

  /** Counters shared across boards. Generations are numbered globally so rows of a deleted and re-created board never collide. */
  counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),

});
