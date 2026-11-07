// A board shaped like the largest real online board (Revival): 120 open cards
// and 300 archived ones, each about 2 KB of card text, with Specs and Plans on
// some, so its roadmap is about 900 KB as JSON. Text is drawn from a fixed
// vocabulary, so it compresses about as well as real planning text. Not a test
// file itself.
import type { PlanbanRoadmap, PlanbanRoadmapItem, PlanbanStatus } from "../src/core/types";

const WORDS = ("ship release checkout migration staging owner review agent board card plan spec theme storefront "
  + "payment webhook shopify order customer email preview deploy rollback feature flag metric dashboard query "
  + "index cache budget quota latency session token sign-in invite member viewer editor history version snapshot "
  + "delta document section summary next action blocked waiting confirm verify browser phone layout copy wording "
  + "price product collection variant inventory warehouse shipping label refund tax currency market translation "
  + "search filter tag group parent child column archive complete pending progress up-next decision risk test "
  + "pull request branch merge commit check runner queue worker machine mini linux box convex worker edge route").split(" ");

/** Deterministic text of about `length` characters. */
function text(seed: number, length: number) {
  const out: string[] = [];
  let state = seed * 2654435761 >>> 0;
  let size = 0;
  while (size < length) {
    state = (state * 1103515245 + 12345) >>> 0;
    const word = WORDS[state % WORDS.length]!;
    out.push(word);
    size += word.length + 1;
  }
  return out.join(" ");
}

export const LARGE_BOARD = { open: 120, archived: 300 } as const;

export function largeBoardItems(): PlanbanRoadmapItem[] {
  const items: PlanbanRoadmapItem[] = [];
  const statuses: PlanbanStatus[] = ["in-progress", "up-next", "pending"];
  const total = LARGE_BOARD.open + LARGE_BOARD.archived;
  const ranks = new Map<PlanbanStatus, number>();
  for (let index = 0; index < total; index += 1) {
    const open = index < LARGE_BOARD.open;
    const status: PlanbanStatus = open ? statuses[index % statuses.length]! : "archived";
    ranks.set(status, (ranks.get(status) ?? 0) + 1);
    items.push({
      id: `card-${String(index).padStart(3, "0")}`,
      title: text(index + 1, 50),
      status,
      priority: null,
      summary: text(index + 1000, 1100),
      nextAction: text(index + 2000, 300),
      tags: [WORDS[index % WORDS.length]!, WORDS[(index * 7) % WORDS.length]!],
      icon: null,
      blockedBy: null,
      specDoc: null,
      planDoc: null,
      completedAt: open ? null : "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      progressNotedAt: "2026-11-01T00:00:00.000Z",
      isGroup: false,
      parentId: null,
      boardRank: ranks.get(status)!,
      groupRank: null,
      metadata: { owner: "pierce", area: WORDS[(index * 3) % WORDS.length], pr: `https://github.com/example/repo/pull/${index + 100}`, note: text(index + 3000, 300) },
    });
  }
  return items;
}

/** The large board's cards on top of a newly created board's roadmap. */
export function largeRoadmap(empty: PlanbanRoadmap): PlanbanRoadmap {
  return { ...empty, roadmapItems: largeBoardItems() };
}
