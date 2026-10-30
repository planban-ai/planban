/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as boards from "../boards.js";
import type * as connections from "../connections.js";
import type * as copies from "../copies.js";
import type * as erasure from "../erasure.js";
import type * as crons from "../crons.js";
import type * as historyMaintenance from "../historyMaintenance.js";
import type * as http from "../http.js";
import type * as invites from "../invites.js";
import type * as limits from "../limits.js";
import type * as live from "../live.js";
import type * as maintenance from "../maintenance.js";
import type * as members from "../members.js";
import type * as model_access from "../model/access.js";
import type * as model_auth from "../model/auth.js";
import type * as model_brandAssets from "../model/brandAssets.js";
import type * as model_cardChanges from "../model/cardChanges.js";
import type * as model_clerk from "../model/clerk.js";
import type * as model_codec from "../model/codec.js";
import type * as model_deviceFlow from "../model/deviceFlow.js";
import type * as model_errors from "../model/errors.js";
import type * as model_history from "../model/history.js";
import type * as model_humanSession from "../model/humanSession.js";
import type * as model_indexRules from "../model/indexRules.js";
import type * as model_inviteEmail from "../model/inviteEmail.js";
import type * as model_limits from "../model/limits.js";
import type * as model_liveToken from "../model/liveToken.js";
import type * as model_mcp from "../model/mcp.js";
import type * as model_oauthClient from "../model/oauthClient.js";
import type * as model_oauthConsent from "../model/oauthConsent.js";
import type * as model_oauthConsentPage from "../model/oauthConsentPage.js";
import type * as model_oauthHttp from "../model/oauthHttp.js";
import type * as model_presence from "../model/presence.js";
import type * as model_providerUsage from "../model/providerUsage.js";
import type * as model_retired from "../model/retired.js";
import type * as model_rows from "../model/rows.js";
import type * as model_sha256 from "../model/sha256.js";
import type * as model_signInNote from "../model/signInNote.js";
import type * as model_transfer from "../model/transfer.js";
import type * as model_unresolved from "../model/unresolved.js";
import type * as model_webAuth from "../model/webAuth.js";
import type * as model_webSession from "../model/webSession.js";
import type * as oauth from "../oauth.js";
import type * as people from "../people.js";
import type * as providerUsage from "../providerUsage.js";
import type * as signingKeys from "../signingKeys.js";
import type * as transfers from "../transfers.js";
import type * as webSessions from "../webSessions.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  boards: typeof boards;
  connections: typeof connections;
  copies: typeof copies;
  erasure: typeof erasure;
  crons: typeof crons;
  historyMaintenance: typeof historyMaintenance;
  http: typeof http;
  invites: typeof invites;
  limits: typeof limits;
  live: typeof live;
  maintenance: typeof maintenance;
  members: typeof members;
  "model/access": typeof model_access;
  "model/auth": typeof model_auth;
  "model/brandAssets": typeof model_brandAssets;
  "model/cardChanges": typeof model_cardChanges;
  "model/clerk": typeof model_clerk;
  "model/codec": typeof model_codec;
  "model/deviceFlow": typeof model_deviceFlow;
  "model/errors": typeof model_errors;
  "model/history": typeof model_history;
  "model/humanSession": typeof model_humanSession;
  "model/indexRules": typeof model_indexRules;
  "model/inviteEmail": typeof model_inviteEmail;
  "model/limits": typeof model_limits;
  "model/liveToken": typeof model_liveToken;
  "model/mcp": typeof model_mcp;
  "model/oauthClient": typeof model_oauthClient;
  "model/oauthConsent": typeof model_oauthConsent;
  "model/oauthConsentPage": typeof model_oauthConsentPage;
  "model/oauthHttp": typeof model_oauthHttp;
  "model/presence": typeof model_presence;
  "model/providerUsage": typeof model_providerUsage;
  "model/retired": typeof model_retired;
  "model/rows": typeof model_rows;
  "model/sha256": typeof model_sha256;
  "model/signInNote": typeof model_signInNote;
  "model/transfer": typeof model_transfer;
  "model/unresolved": typeof model_unresolved;
  "model/webAuth": typeof model_webAuth;
  "model/webSession": typeof model_webSession;
  oauth: typeof oauth;
  people: typeof people;
  providerUsage: typeof providerUsage;
  signingKeys: typeof signingKeys;
  transfers: typeof transfers;
  webSessions: typeof webSessions;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
