# Contributing to Planban

Thanks for taking a look at Planban.

Planban is early. The best contributions right now are small, focused fixes that
make the local Codex and Claude Code plugins, board UI, docs, install flow, or feedback flow more
reliable and easier to understand.

Before proposing a feature or materially changing Planban's workflow, domain model,
or visible information hierarchy, read the [Planban Product Constitution](PRODUCT.md).
Planban is intentionally designed for individual agentic project work and evaluates
visible complexity by whether it improves human sight or steering of that work.

## Contribution Policy

Planban does not use a CLA or enforced DCO at launch.

By submitting a pull request, you agree that your contribution is licensed under
the MIT License.

## What Is Welcome

- Bug reports with clear reproduction steps.
- Small docs improvements.
- Small focused bug fixes.
- Small reliability or install-flow fixes.
- Tests that cover a concrete bug or behavior change.
- UI polish with before/after screenshots.

## Open an Issue First

Please open an issue before working on:

- new product features;
- host support beyond Codex and Claude Code;
- broad refactors;
- storage or migration changes;
- public API, MCP, or CLI contract changes;
- changes that alter install, update, or security behavior.

Opening an issue first does not guarantee the work will be accepted, but it avoids
wasting your time on a direction that may not fit the current roadmap.

## Pull Request Expectations

Keep pull requests small and focused.

For a bug fix, a pull request should deliver an implemented and verified solution,
not merely propose one. Show that the reported failure was investigated, the original
scenario succeeds after the change, and the fix applies to current `main`. If the
change is still a hypothesis, workaround, or unverified local patch, file or update a
bug issue instead.

Explain:

- what changed;
- the observed problem and confirmed or best-supported root cause;
- why this implementation is appropriate;
- how you tested it;
- which environment or product surfaces were verified; and
- what risks or follow-up work remain.

For UI changes, include before/after screenshots. For motion, drag/drop, browser
opening, onboarding, or other interaction changes, include a short screen recording
or describe exactly how to verify the behavior.

## AI-Assisted Contributions

AI-assisted contributions are welcome, but please say so in the pull request.

If Codex, Claude, Cursor, or another agent helped, include enough context for a
reviewer to understand the change:

- what the agent was asked to do;
- what you reviewed manually;
- what tests or checks passed;
- any areas where you are uncertain.

You are responsible for understanding and validating the contribution before
submitting it.

## Local Checks

Run the relevant checks before asking for review:

```bash
npm run typecheck
npm test
npm run build
```

For release or install-path changes, also run:

```bash
npm run release:preflight
```

The board page ships pre-built in `dist/web`, so commit it with any change to its
source. To have git refuse a push whose `dist/web` is out of date, turn on the
pre-push hook once per clone:

```bash
git config core.hooksPath .githooks
```

The hook builds each commit you push in a temporary checkout, which takes about a
second, and leaves your own checkout alone. The preflight runs the same check first.

Preflight includes `node scripts/verify-cold-install.mjs`: it copies a fresh
marketplace and plugin cache without dependencies or configured local paths, then
executes MCP initialization, Board launch, and CLI startup. Keep bootstrap
regressions covered by executing these paths, not only matching their source text.
The Windows CI job runs the same cold-install check with paths containing spaces.

Updater CI separately checks the previous public version upgrade and repeated
updates of the candidate with unchanged dependencies, in both Codex and Claude Code. Dependency changes must take
the clean-install fallback; only the unchanged-dependency scenario is required to
reuse dependencies and meet the relative speed gate.

The updater rehearsal uses seven machines, five of them Windows, so it doesn't run on
every push. It runs when a pull request opens, reopens or is marked ready for review; later
pushes run only its quick compatibility checks, so its other checks show as skipped.
To run it on the latest commit, start it by hand with the branch and the exact commit:

```bash
gh workflow run updater-rehearsal.yml --ref <branch> -f target_ref=<branch> -f expected_commit=<commit>
```

A newer push cancels any CI or rehearsal run still going for an older commit on the
same branch, including one started by hand.

Before publishing a release, use the exact candidate commit and rehearse updating
from the previous public version. For example:

```bash
npm run release:upgrade-rehearsal -- --from-version 1.1.0 --expected-version 1.1.1
npm run release:claude-upgrade-rehearsal -- --from-version 1.1.0 --expected-version 1.1.1
```

The first command rehearses the Codex update. The second rehearses the Claude Code
update: it installs the previous release from a local-folder marketplace, updates the
same checkout to the candidate, re-adds the marketplace, runs
`claude plugin update planban@planban`, and checks that the plugin reports the new
version, that `claude mcp list` shows the Planban server connected, that the server
lists its tools, and that a board made by the previous release can still be read and
changed. It uses a throwaway home and Claude config folder and needs no Claude sign-in.
Both need their CLI on your `PATH`; CI pins the versions in the workflow files.

The manual `Release readiness` workflow runs the preflight, both upgrade rehearsals
and the full updater rehearsal against an exact commit SHA. Give it the branch or tag
whose head is that commit as `target_ref`, since the updater rehearsal updates from
it as people do. Preflight fails if that workflow stops running any of these.

In release notes, write Planban CLI examples as `node "$PLANBAN_ROOT/bin/planban.mjs" <command>`.
Planban is not published to npm, so users do not have a bare `planban` command on
their `PATH`.

## Privacy

Do not include private board contents, local project paths, logs, screenshots, API
keys, tokens, or personal project details in public issues or pull requests unless
you intentionally sanitize and approve them.

Use the security route for vulnerabilities or sensitive install/update behavior.
