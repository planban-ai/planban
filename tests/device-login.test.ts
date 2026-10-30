// The command line's sign-in by approval link (Planban 2.0, Spec point 16):
// it opens the link in this computer's browser unless printing only, prints
// the link and code, waits while the person decides, and saves only a valid
// machine sign-in.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { onlineLogin } from "../src/core/online/login";
import { readCredentials } from "../src/core/online/credentials";

const DEVICE_CODE = "pbv_" + "d".repeat(43), ACCESS = "pbm_" + "m".repeat(43);

async function service(answers: Array<Record<string, unknown>>, deviceReply?: (url: string) => Record<string, unknown>) {
  let url = "";
  const polls: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    const path = new URL(req.url!, url).pathname;
    if (path === "/.well-known/planban.json") return json(200, { signIn: { issuer: url, cliClientId: "planban-cli", redirectPorts: [53682], scope: "planban:machine" } });
    if (path === "/.well-known/oauth-authorization-server") return json(200, {
      issuer: url, token_endpoint: `${url}/oauth/token`, authorization_endpoint: `${url}/oauth/authorize`, revocation_endpoint: `${url}/oauth/revoke`,
      device_authorization_endpoint: `${url}/oauth/device`, code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true,
      planban_machine_start_endpoint: `${url}/oauth/machine/start`, planban_machine_cancel_endpoint: `${url}/oauth/machine/cancel`,
    });
    if (path === "/oauth/device") {
      assert.deepEqual(body, { client_id: "planban-cli", scope: "planban:machine", resource: url });
      return json(200, deviceReply?.(url) ?? { device_code: DEVICE_CODE, user_code: "WDJB-MJHT", verification_uri: `${url}/approve`, verification_uri_complete: `${url}/approve#request=pbn_note`, expires_in: 600, interval: 5 });
    }
    if (path === "/oauth/token") {
      polls.push(body);
      const answer = answers.shift() ?? { error: "authorization_pending" };
      return json(answer.access_token ? 200 : 400, answer);
    }
    if (path === "/api/v1/me") return json(200, { userId: "user_alice" });
    return json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
  return { url: () => url, polls, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

async function withHome(run: () => Promise<void>) {
  const prior = process.env.PLANBAN_HOME;
  const root = await mkdtemp(join(tmpdir(), "planban-device-"));
  process.env.PLANBAN_HOME = root;
  const write = process.stderr.write.bind(process.stderr);
  const printed: string[] = [];
  (process.stderr as any).write = (chunk: any) => { printed.push(String(chunk)); return true; };
  try { await run.call({ printed }); return printed; }
  finally { (process.stderr as any).write = write; process.env.PLANBAN_HOME = prior; await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test("on this computer: opens the approval link in the browser, prints it with the code, waits, and saves the sign-in", async () => {
  const fake = await service([{ error: "authorization_pending" }, { access_token: ACCESS, token_type: "Bearer", scope: "planban:machine", user_id: "user_alice", expires_in: 1 }]);
  const opened: string[] = [];
  const printed = await withHome(async () => {
    const result = await onlineLogin(fake.url(), { device: true, openBrowser: async (link) => { opened.push(link); }, pollIntervalMs: 10 });
    assert.equal(result.signedIn, true);
    assert.equal((await readCredentials()).services[fake.url()]!.accessToken, ACCESS);
  });
  assert.deepEqual(opened, [`${fake.url()}/approve#request=pbn_note`]);
  assert.match(printed.join(""), /check the code is WDJB-MJHT/);
  assert.match(printed.join(""), new RegExp(`${fake.url()}/approve#request=pbn_note`.replace(/[.?]/g, "\\$&")));
  assert.equal(fake.polls.length, 2);
  assert.equal(fake.polls[0].grant_type, "urn:ietf:params:oauth:grant-type:device_code");
  await fake.close();
});

test("printing only: never opens a browser", async () => {
  const fake = await service([{ access_token: ACCESS, token_type: "Bearer", scope: "planban:machine" }]);
  await withHome(async () => {
    await onlineLogin(fake.url(), { printOnly: true, openBrowser: async () => assert.fail("opened a browser"), pollIntervalMs: 10 });
  });
  await fake.close();
});

test("a denial, a malformed reply or a non-machine token saves nothing", async () => {
  for (const [answers, message] of [
    [[{ error: "access_denied" }], /denied/],
    [[{ access_token: "pba_" + "x".repeat(43), token_type: "Bearer", scope: "planban:read" }], /expired or failed/],
    [[{ error: "expired_token" }], /expired or failed/],
  ] as const) {
    const fake = await service([...answers] as any);
    await withHome(async () => {
      await assert.rejects(onlineLogin(fake.url(), { printOnly: true, pollIntervalMs: 10 }), message as RegExp);
      assert.equal((await readCredentials()).services[fake.url()], undefined);
    });
    await fake.close();
  }
  const forged = await service([], (url) => ({ device_code: DEVICE_CODE, user_code: "WDJB-MJHT", verification_uri_complete: "https://evil.example/approve#request=x", expires_in: 600, interval: 5 }));
  await withHome(async () => { await assert.rejects(onlineLogin(forged.url(), { printOnly: true, pollIntervalMs: 10 }), /valid sign-in link/); });
  await forged.close();
});

test("the command line's --no-browser prints the link and code, never opens a browser, and finishes signing in", { skip: process.platform === "win32" ? "uses a POSIX stand-in for the browser opener" : false }, async () => {
  const { spawn } = await import("node:child_process");
  const { chmod, mkdir, readFile, writeFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const fake = await service([{ access_token: ACCESS, token_type: "Bearer", scope: "planban:machine", user_id: "user_alice", expires_in: 1 }]);
  const home = await mkdtemp(join(tmpdir(), "planban-device-cli-"));
  try {
    // Stand-ins for the system's browser openers, which record any attempt instead of opening anything.
    const bin = join(home, "bin");
    await mkdir(bin);
    for (const name of ["open", "xdg-open"]) {
      await writeFile(join(bin, name), `#!/bin/sh\necho "$@" >> "${join(home, "opened.txt")}"\n`);
      await chmod(join(bin, name), 0o755);
    }
    const repo = fileURLToPath(new URL("..", import.meta.url));
    const run = spawn(process.execPath, ["--import", "tsx/esm", "src/cli.ts", "online", "login", fake.url(), "--no-browser"], {
      cwd: repo, env: { ...process.env, PLANBAN_HOME: home, PATH: `${bin}:${process.env.PATH}` },
    });
    let stdout = "", stderr = "";
    run.stdout.on("data", (chunk) => { stdout += chunk; });
    run.stderr.on("data", (chunk) => { stderr += chunk; });
    // "close" follows the end of both output streams; a stuck sign-in is stopped after 30 seconds.
    const timer = setTimeout(() => run.kill("SIGKILL"), 30_000);
    const code = await new Promise<number | null>((resolve, reject) => {
      run.on("error", reject);
      run.on("close", resolve);
    }).finally(() => clearTimeout(timer));
    assert.equal(code, 0, stderr);
    assert.match(stderr, /check the code is WDJB-MJHT/);
    assert.ok(stderr.includes(`${fake.url()}/approve#request=pbn_note`), "the approval link is printed");
    assert.equal(await readFile(join(home, "opened.txt"), "utf8").catch(() => ""), "", "no browser was opened");
    assert.equal(fake.polls.length, 1);
    assert.match(stdout, /signedIn|true/);
  } finally {
    await fake.close();
    await rm(home, { recursive: true, force: true });
  }
});
