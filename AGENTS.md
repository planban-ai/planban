# AGENTS.md

Guidance for AI agents working in this repository. Human contributors start
at `CONTRIBUTING.md`.

- Product principles: `PRODUCT.md`. Read it before changing the workflow,
  domain model or anything visible.
- Planning protocol and the house style for text on cards:
  `plugins/planban/skills/planban/references/planban-protocol.md` and
  `planban-house-style.md`.
- Commands: npm and Node 22 (`npm test`, `npm run typecheck`, `npm run build`,
  `npm run smoke`). Before a release, `npm run release:preflight` and the
  `Release readiness` workflow.
- Keep it light. Add process here only when it saves the owner time.
- Maintainers' agents also follow their own global instructions for owner
  decisions, checking work and landing work; this file adds only what is
  Planban's own.
- An app update cannot be undone once people's machines install it, only
  fixed by a newer one. Never publish one without the owner's yes.
- This repository is public: never commit secrets, private paths, personal
  details or anything from a private board.
