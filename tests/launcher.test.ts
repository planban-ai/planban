import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  openPlanbanBoardInCodexBrowser,
  openUrlInCodexBrowser,
  verifiedWebSurface,
} from "../plugins/planban/scripts/codex-fast-open-planban.mjs";
import { launchLogPath } from "../plugins/planban/scripts/launch-planban.mjs";

async function runtimeFixture(root: string) {
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "src/core"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "planban" }));
  await writeFile(join(root, "src/cli.ts"), "");
  await writeFile(join(root, "src/core/storage.ts"), "");
}

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function verifiedLaunch(url = "http://localhost:4317/boards/alpha") {
  return {
    launch: {
      ok: true,
      status: "ready",
      urlVerified: true,
      durationMs: 2,
    },
    url,
  };
}

function workingBrowser() {
  let currentUrl = "about:blank";
  let newTabCalls = 0;
  const browser = {
    capabilities: { get: async () => null },
    tabs: {
      new: async () => {
        newTabCalls += 1;
        return {
          goto: async (url: string) => { currentUrl = url; },
          playwright: { waitForLoadState: async () => undefined },
          title: async () => "Planban",
          url: async () => currentUrl,
        };
      },
      selected: async () => null,
    },
  };
  return { browser, newTabCalls: () => newTabCalls };
}

test("keeps successful URL resolution authoritative when the browser is unavailable", async () => {
  const result = await openPlanbanBoardInCodexBrowser({
    resolveBoard: async () => verifiedLaunch(),
    browserAvailable: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.serviceReady, true);
  assert.equal(result.urlVerified, true);
  assert.equal(result.url, "http://localhost:4317/boards/alpha");
  assert.equal(result.browserOpened, false);
  assert.equal(result.presentation.status, "unavailable");
  assert.equal(result.diagnostics[0]?.boundary, "browser-presentation");
});

test("returns the verified URL when Browser runtime setup fails", async () => {
  const result = await openUrlInCodexBrowser({
    url: "http://localhost:4317/boards/alpha",
    setupBrowserRuntime: async () => { throw new Error("runtime setup failed"); },
  });

  assert.equal(result.ok, true);
  assert.equal(result.url, "http://localhost:4317/boards/alpha");
  assert.equal(result.browserOpened, false);
  assert.equal(result.presentation.status, "unavailable");
  assert.equal(result.presentation.stage, "setup");
  assert.match(result.diagnostics[0]?.message ?? "", /runtime setup failed/u);
});

test("returns the verified URL when tab navigation fails", async () => {
  const browser = {
    capabilities: { get: async () => null },
    tabs: {
      new: async () => ({ goto: async () => { throw new Error("navigation failed"); } }),
      selected: async () => null,
    },
  };
  const result = await openUrlInCodexBrowser({ url: "http://localhost:4317/boards/alpha", browser });

  assert.equal(result.ok, true);
  assert.equal(result.url, "http://localhost:4317/boards/alpha");
  assert.equal(result.browserOpened, false);
  assert.equal(result.presentation.status, "failed");
  assert.equal(result.presentation.stage, "navigation");
  assert.match(result.diagnostics[0]?.message ?? "", /navigation failed/u);
});

test("automatically opens a verified URL when the browser capability is available", async () => {
  const available = workingBrowser();
  let setupCalls = 0;
  const result = await openUrlInCodexBrowser({
    url: "http://localhost:4317/boards/alpha",
    setupBrowserRuntime: async () => {
      setupCalls += 1;
      return {
        browsers: {
          get: async (selector: string) => {
            assert.equal(selector, "iab");
            return available.browser;
          },
        },
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.browserOpened, true);
  assert.equal(result.finalUrl, "http://localhost:4317/boards/alpha");
  assert.equal(result.presentation.status, "opened");
  assert.equal(result.diagnostics.length, 0);
  assert.equal(setupCalls, 1);
  assert.equal(available.newTabCalls(), 1);
});

test("rejects a board URL whose shell and fallback route load but board state is unverified", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/boards/legacy-board") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<div id="root"></div>');
      return;
    }
    if (request.url === "/api/boards/legacy-board/health") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<div id="root"></div>');
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.equal(typeof address, "object");

  try {
    assert.equal(await verifiedWebSurface(`http://127.0.0.1:${address.port}/boards/legacy-board`), false);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
});

test("resolves the default cold-launch log path without PLANBAN_HOME", () => {
  const previousPlanbanHome = process.env.PLANBAN_HOME;
  const previousLogFile = process.env.PLANBAN_LAUNCH_LOG_FILE;
  try {
    delete process.env.PLANBAN_HOME;
    delete process.env.PLANBAN_LAUNCH_LOG_FILE;
    assert.equal(launchLogPath(4317), join(homedir(), ".planban", "logs", "launch-4317.log"));
  } finally {
    if (previousPlanbanHome === undefined) delete process.env.PLANBAN_HOME;
    else process.env.PLANBAN_HOME = previousPlanbanHome;
    if (previousLogFile === undefined) delete process.env.PLANBAN_LAUNCH_LOG_FILE;
    else process.env.PLANBAN_LAUNCH_LOG_FILE = previousLogFile;
  }
});

test("resolves an installed-cache runtime from adjacent MCP metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-installed-cache-"));
  const cacheRoot = join(root, "codex-home", "plugins", "cache", "planban", "planban", "1.0.0");
  const scriptsRoot = join(cacheRoot, "scripts");
  const runtimeRoot = join(root, "installed-runtime");
  const previousRepoRoot = process.env.PLANBAN_REPO_ROOT;
  const previousCodexHome = process.env.CODEX_HOME;

  try {
    await runtimeFixture(runtimeRoot);
    await mkdir(scriptsRoot, { recursive: true });
    await writeFile(join(runtimeRoot, "bin", "planban.mjs"), "#!/usr/bin/env node\n", "utf8");
    await writeFile(join(cacheRoot, ".mcp.json"), JSON.stringify({
      mcpServers: {
        planban: {
          cwd: runtimeRoot,
          command: "node",
          args: ["--import", "tsx/esm", "./plugins/planban/mcp/server.mjs"],
          env: { PLANBAN_REPO_ROOT: runtimeRoot },
        },
      },
    }), "utf8");
    await cp(join(repoRoot, "plugins/planban/scripts"), scriptsRoot, { recursive: true });

    delete process.env.PLANBAN_REPO_ROOT;
    process.env.CODEX_HOME = join(root, "codex-home");
    const cacheBust = `?test=${Date.now()}`;
    const fastOpen = await import(`${pathToFileURL(join(scriptsRoot, "codex-fast-open-planban.mjs")).href}${cacheBust}`);
    const launcher = await import(`${pathToFileURL(join(scriptsRoot, "launch-planban.mjs")).href}${cacheBust}`);

    assert.equal(fastOpen.resolveRuntimeRoot(), runtimeRoot);
    assert.equal(launcher.resolveRuntimeRoot(), runtimeRoot);
  } finally {
    if (previousRepoRoot === undefined) delete process.env.PLANBAN_REPO_ROOT;
    else process.env.PLANBAN_REPO_ROOT = previousRepoRoot;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("falls back to the standard Codex marketplace runtime when cache MCP metadata is unresolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-marketplace-fallback-"));
  const codexHome = join(root, "codex-home");
  const cacheRoot = join(codexHome, "plugins", "cache", "planban", "planban", "1.0.0");
  const scriptsRoot = join(cacheRoot, "scripts");
  const marketplaceRoot = join(codexHome, ".tmp", "marketplaces", "planban");
  const previousRepoRoot = process.env.PLANBAN_REPO_ROOT;
  const previousCodexHome = process.env.CODEX_HOME;

  try {
    await runtimeFixture(marketplaceRoot);
    await mkdir(scriptsRoot, { recursive: true });
    await writeFile(join(marketplaceRoot, "bin", "planban.mjs"), "#!/usr/bin/env node\n", "utf8");
    await writeFile(join(cacheRoot, ".mcp.json"), JSON.stringify({
      mcpServers: {
        planban: {
          cwd: "__PLANBAN_REPO_ROOT__",
          env: { PLANBAN_REPO_ROOT: "__PLANBAN_REPO_ROOT__" },
        },
      },
    }), "utf8");
    await cp(join(repoRoot, "plugins/planban/scripts"), scriptsRoot, { recursive: true });

    delete process.env.PLANBAN_REPO_ROOT;
    process.env.CODEX_HOME = codexHome;
    const cacheBust = `?test=${Date.now()}`;
    const fastOpen = await import(`${pathToFileURL(join(scriptsRoot, "codex-fast-open-planban.mjs")).href}${cacheBust}`);
    const launcher = await import(`${pathToFileURL(join(scriptsRoot, "launch-planban.mjs")).href}${cacheBust}`);

    assert.equal(fastOpen.resolveRuntimeRoot(), marketplaceRoot);
    assert.equal(launcher.resolveRuntimeRoot(), marketplaceRoot);
  } finally {
    if (previousRepoRoot === undefined) delete process.env.PLANBAN_REPO_ROOT;
    else process.env.PLANBAN_REPO_ROOT = previousRepoRoot;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
