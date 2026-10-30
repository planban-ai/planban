import { spawn } from "node:child_process";

const WINDOWS_COMMAND_SHIMS = new Set(["codex", "codex.cmd", "npm", "npm.cmd", "npx", "npx.cmd"]);

export function platformInvocation(command, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const normalized = command.toLowerCase().split(/[\\\\/]/u).at(-1);
  if (platform === "win32" && WINDOWS_COMMAND_SHIMS.has(normalized)) {
    return {
      command: options.comspec || process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }
  return { command, args };
}

/**
 * Stops a command started from platformInvocation. On Windows a shim such as
 * npm or codex runs under cmd.exe, and stopping cmd.exe alone leaves the real
 * command running and holding its files, so the whole process tree is stopped.
 */
export function stopInvocation(child, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && child.pid) {
    try {
      const stopper = (options.spawn ?? spawn)("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      stopper.once("error", () => child.kill());
      return;
    } catch {
      // Fall back to stopping the shell itself.
    }
  }
  child.kill("SIGTERM");
}
