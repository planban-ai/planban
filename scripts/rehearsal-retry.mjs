// One retry for the rehearsals' setup steps that fail for reasons outside Planban:
// a dropped download or a Windows file lock while npm installs, or a failed clone of
// the previous public release. Never wrap a step that checks Planban's behaviour.

/** True when an npm install failed on the network, or on a locked file under node_modules. */
export function isTransientInstallFailure(error) {
  const text = String(error?.message ?? error);
  return /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENOTFOUND)\b|npm error network/u.test(text)
    || /\bEPERM\b[^\n]*\b(rmdir|unlink|rename)\b[^\n]*node_modules/u.test(text);
}

/** Runs `step`, and once more after `beforeRetry` if `shouldRetry` accepts the first failure. */
export async function retryOnce(label, step, { shouldRetry = () => true, beforeRetry = async () => {} } = {}) {
  try {
    return await step();
  } catch (error) {
    if (!shouldRetry(error)) throw error;
    process.stderr.write(`  ${label} failed; retrying once. First failure:\n${String(error?.message ?? error).split("\n").slice(0, 5).join("\n")}\n`);
    await beforeRetry();
    return await step();
  }
}
