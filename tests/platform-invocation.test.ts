import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { platformInvocation, stopInvocation } from "../scripts/platform-invocation.mjs";

test("runs npm-installed Windows command shims through cmd.exe", () => {
  assert.deepEqual(
    platformInvocation("codex", ["plugin", "marketplace", "upgrade", "planban"], {
      platform: "win32",
      comspec: "C:\\Windows\\System32\\cmd.exe",
    }),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "codex", "plugin", "marketplace", "upgrade", "planban"],
    },
  );
  assert.deepEqual(
    platformInvocation("npm.cmd", ["install"], { platform: "win32", comspec: "cmd.exe" }),
    { command: "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd", "install"] },
  );
});

test("does not route native Windows or non-Windows commands through a shell", () => {
  assert.deepEqual(
    platformInvocation("git", ["rev-parse", "HEAD"], { platform: "win32", comspec: "cmd.exe" }),
    { command: "git", args: ["rev-parse", "HEAD"] },
  );
  assert.deepEqual(
    platformInvocation("codex", ["--version"], { platform: "linux" }),
    { command: "codex", args: ["--version"] },
  );
});

test("the installed-runtime verifier uses the shared Windows shim boundary", async () => {
  const source = await readFile(new URL("../scripts/verify-local-install.mjs", import.meta.url), "utf8");
  assert.match(source, /platformInvocation\("codex", \["plugin", "list"\]\)/u);
  assert.doesNotMatch(source, /execFileAsync\("codex"/u);
});

test("stopping a command on Windows stops its whole process tree, not only cmd.exe", () => {
  const started: Array<{ command: string; args: string[] }> = [];
  let killed = false;
  const child = { pid: 4242, kill: () => { killed = true; return true; } };
  stopInvocation(child, { platform: "win32", spawn: (command, args) => { started.push({ command, args }); return { once: () => undefined }; } });
  assert.deepEqual(started, [{ command: "taskkill", args: ["/pid", "4242", "/T", "/F"] }]);
  assert.equal(killed, false);
});

test("stopping a command elsewhere signals it directly", () => {
  const signals: Array<string | undefined> = [];
  stopInvocation({ pid: 4242, kill: (signal) => { signals.push(signal); return true; } }, { platform: "linux", spawn: () => { throw new Error("no taskkill here"); } });
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("update steps that time out stop their whole command", async () => {
  for (const path of ["src/core/updateRunner.ts", "scripts/update-marketplace-runtime.mjs"]) {
    const source = await readFile(path, "utf8");
    assert.match(source, /stopInvocation\(child\)/, path);
    assert.doesNotMatch(source, /child\.kill\("SIGTERM"\);\s*rejectRun/, path);
  }
});

