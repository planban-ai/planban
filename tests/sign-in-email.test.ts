// Planban's own sign-in emails (owner request, 15 October 2026): Clerk's
// email.created webhook, its Svix signature, which emails Planban sends,
// what they say, and the send through Resend.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { clerkWebhookResponse, decideClerkEmail, renderSignInEmail, verifySvix } from "../online/service/convex/model/signInEmail";

const SECRET = `whsec_${Buffer.from("planban-test-signing-key-0123456789").toString("base64")}`;

function signed(body: string, options: { id?: string; at?: number; secret?: string } = {}) {
  const id = options.id ?? "msg_1", timestamp = String(Math.floor((options.at ?? Date.now()) / 1000));
  const key = Buffer.from((options.secret ?? SECRET).slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return new Request("https://service.example/clerk/webhook", { method: "POST", body, headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signature}`, "Content-Type": "application/json" } });
}

const codeEvent = (overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
  type: "email.created", timestamp: Date.now(),
  data: { object: "email", slug: "verification_code", to_email_address: "Sam@Example.com", delivered_by_clerk: false, data: { otp_code: "482913", requested_from: "Chrome, macOS", ...data }, ...overrides },
});

async function withSending<T>(run: (sent: Array<{ headers: Headers; body: any }>) => Promise<T>, env: Record<string, string> = { RESEND_API_KEY: "re_test_key", PLANBAN_INVITE_FROM: "Planban <invites@planban.ai>" }) {
  const sent: Array<{ headers: Headers; body: any }> = [];
  const realFetch = globalThis.fetch;
  const prior = { ...process.env };
  Object.assign(process.env, { CLERK_WEBHOOK_SIGNING_SECRET: SECRET, ...env });
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return Response.json({ id: "email_1" });
  }) as typeof fetch;
  try { return await run(sent); } finally {
    globalThis.fetch = realFetch;
    for (const name of ["CLERK_WEBHOOK_SIGNING_SECRET", "RESEND_API_KEY", "PLANBAN_INVITE_FROM"]) {
      if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name];
    }
  }
}

test("only Clerk's signature, recent and unaltered, is accepted", async () => {
  const body = JSON.stringify(codeEvent());
  const good = signed(body);
  assert.equal(await verifySvix(SECRET, good.headers, body), true);
  assert.equal(await verifySvix(SECRET, good.headers, body.replace("482913", "000000")), false, "an altered body");
  assert.equal(await verifySvix(SECRET, signed(body, { at: Date.now() - 10 * 60 * 1000 }).headers, body), false, "an old one");
  const otherSecret = `whsec_${Buffer.from("someone-else-entirely").toString("base64")}`;
  assert.equal(await verifySvix(SECRET, signed(body, { secret: otherSecret }).headers, body), false, "signed by another key");
});

test("Planban sends the code, new-device, changed-email and locked emails, and leaves the rest to Clerk", () => {
  assert.deepEqual(decideClerkEmail(codeEvent()), { send: { slug: "verification_code", to: "sam@example.com", code: "482913", requestedFrom: "Chrome, macOS" } });
  assert.ok("ignore" in decideClerkEmail(codeEvent({ delivered_by_clerk: true })), "Clerk still delivers it");
  assert.ok("ignore" in decideClerkEmail(codeEvent({ to_email_address: "sam+clerk_test@example.com" })), "test addresses never need mail");
  assert.ok("ignore" in decideClerkEmail({ ...codeEvent(), timestamp: Date.now() - 11 * 60 * 1000 }), "a code too old to use");
  assert.ok("retry" in decideClerkEmail(codeEvent({ slug: "password_changed" })), "a template Planban can't send is never dropped quietly");
  assert.ok("ignore" in decideClerkEmail({ type: "user.created", data: {} }));
  const device = decideClerkEmail(codeEvent({ slug: "new_device_sign_in" }, { browser_name: "Safari", operating_system: "iOS", location: "London, UK" }));
  assert.deepEqual("send" in device && device.send, { slug: "new_device_sign_in", to: "sam@example.com", device: "Safari on iOS", location: "London, UK", method: null, at: null });
});

test("the emails read as Planban's and keep what Clerk sends as plain text", () => {
  const code = renderSignInEmail({ slug: "verification_code", to: "sam@example.com", code: "482913", requestedFrom: "<script>" });
  assert.equal(code.subject, "482913 is your Planban code");
  assert.match(code.html, /cid:planban-wordmark/);
  assert.match(code.html, /482913/);
  assert.doesNotMatch(code.html, /<script>/, "Clerk's text is escaped");
  assert.match(code.text, /continue with your Planban account/);
  const device = renderSignInEmail({ slug: "new_device_sign_in", to: "sam@example.com", device: "Safari on iOS", location: null, method: null, at: null });
  assert.match(device.text, /Cut off everything/);
  assert.doesNotMatch(device.html, /Where:/, "empty details are left out");
});

test("the webhook sends through Resend once per Clerk email, and asks Clerk to retry when it can't", async () => {
  await withSending(async (sent) => {
    const response = await clerkWebhookResponse(signed(JSON.stringify(codeEvent()), { id: "msg_42" }));
    assert.equal(response.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.headers.get("Idempotency-Key"), "planban-clerk-msg_42", "Clerk's retries never send twice");
    assert.equal(sent[0]!.body.from, "Planban <invites@planban.ai>");
    assert.deepEqual(sent[0]!.body.to, ["sam@example.com"]);
    assert.equal((await clerkWebhookResponse(signed(JSON.stringify(codeEvent({ delivered_by_clerk: true }))))).status, 200);
    assert.equal(sent.length, 1, "nothing sent when Clerk delivers it");
    assert.equal((await clerkWebhookResponse(signed(JSON.stringify(codeEvent({ slug: "password_changed" }))))).status, 503);
    const forged = signed(JSON.stringify(codeEvent()));
    forged.headers.set("svix-signature", "v1,AAAA");
    assert.equal((await clerkWebhookResponse(forged)).status, 400);
  });
  await withSending(async (sent) => {
    assert.equal((await clerkWebhookResponse(signed(JSON.stringify(codeEvent())))).status, 503, "no sending key: Clerk retries, nothing is lost silently");
    assert.equal(sent.length, 0);
  }, {});
});

test("the webhook stops reading a body past 64 KB, whatever its declared length, and retries a passing email-service failure", async () => {
  await withSending(async () => {
    const big = new ReadableStream({ start(controller) { for (let i = 0; i < 100; i += 1) controller.enqueue(new Uint8Array(1024)); controller.close(); } });
    const request = new Request("https://service.example/clerk/webhook", { method: "POST", body: big, duplex: "half" } as RequestInit);
    assert.equal((await clerkWebhookResponse(request)).status, 413);
  });
  let calls = 0;
  const realFetch = globalThis.fetch;
  await withSending(async () => {
    globalThis.fetch = (async () => { calls += 1; return calls < 2 ? new Response("busy", { status: 500 }) : Response.json({ id: "email_2" }); }) as typeof fetch;
    try {
      const response = await clerkWebhookResponse(signed(JSON.stringify(codeEvent())));
      assert.equal(response.status, 200);
      assert.equal(calls, 2, "sent on the second try, within the same request");
    } finally { globalThis.fetch = realFetch; }
  });
});
