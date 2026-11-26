import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { makeFunctionReference } from "convex/server";
import { usageEnabled } from "./model/providerUsage";

const crons = cronJobs();
// Registration requires a coordinated deployment; runtime flag is also checked.
if (usageEnabled(process.env)) crons.hourly("Planban included usage warnings", { minuteUTC: 17 }, makeFunctionReference<"action">("providerUsage:poll"), {});
crons.daily("expire idempotency records", { hourUTC: 3, minuteUTC: 0 }, internal.maintenance.expireOperations, {});
crons.daily("cancel abandoned uploads", { hourUTC: 3, minuteUTC: 15 }, internal.maintenance.cancelAbandonedTransfers, {});
crons.daily("forget old daily usage", { hourUTC: 4, minuteUTC: 0 }, internal.maintenance.expireUsage, {});
crons.daily("remove long-expired invitations", { hourUTC: 4, minuteUTC: 15 }, internal.maintenance.expireInvites, {});
crons.daily("forget used sign-in tokens", { hourUTC: 3, minuteUTC: 45 }, internal.maintenance.expireMachineExchanges, {});
crons.daily("forget ended browser sign-ins", { hourUTC: 4, minuteUTC: 30 }, internal.webSessions.pruneBarriers, {});
crons.hourly("forget who was working on cards long ago", { minuteUTC: 41 }, internal.maintenance.expirePresence, {});
crons.daily("finish deletions of boards and accounts", { hourUTC: 5, minuteUTC: 0 }, internal.erasure.sweep, {});
crons.hourly("forget old sign-in approval counts", { minuteUTC: 41 }, internal.oauth.pruneApprovals, {});
crons.daily("forget old GitHub delivery ids", { hourUTC: 5, minuteUTC: 30 }, internal.github.forgetDeliveries, {});
export default crons;
