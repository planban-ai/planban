import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

// Homebrew installs each Node release in a versioned folder such as
// /opt/homebrew/Cellar/node@24/24.21.0_2/bin/node, and deletes that folder when it
// upgrades Node. Its opt link (/opt/homebrew/opt/node@24/bin/node) always points at
// the current release, so a path written there keeps working after an upgrade.
const CELLAR_NODE = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/;

/** The Node path to record in a config file: the Homebrew opt link when it leads to the same program, else the path given. */
export function stableNodePath(execPath) {
  const match = CELLAR_NODE.exec(execPath);
  if (!match) return execPath;
  const [, prefix, formula] = match;
  const optPath = join(prefix, "opt", formula, "bin", "node");
  try {
    if (existsSync(optPath) && realpathSync(optPath) === realpathSync(execPath)) return optPath;
  } catch {
    // Fall back to the path that ran this script.
  }
  return execPath;
}
