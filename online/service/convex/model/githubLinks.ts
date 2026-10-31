// Reading a board's linked GitHub repositories (see github.ts), shared by the
// board reads and the webhook without either importing the other.
import type { QueryCtx } from "../_generated/server";

/** A board's links, oldest first, including any still being unlinked. */
export async function boardLinks(ctx: QueryCtx, boardId: string) {
  return (await ctx.db.query("githubLinks").withIndex("by_board", (q) => q.eq("boardId", boardId)).collect())
    .sort((a, b) => a._creationTime - b._creationTime);
}

/** The repositories linked to a board, the home repository first: the first one, whose `#123` a bare reference means. */
export async function linkedRepos(ctx: QueryCtx, boardId: string): Promise<string[]> {
  return (await boardLinks(ctx, boardId)).filter((link) => !link.removing).map((link) => link.repo);
}

/**
 * The linked repositories GitHub itself confirmed (see github.ts), whose merges hosted surfaces
 * may call checked. An unconfirmed link's merges are still recorded, but credited to the person
 * who set it up.
 */
export async function confirmedRepos(ctx: QueryCtx, boardId: string): Promise<string[]> {
  return (await boardLinks(ctx, boardId)).filter((link) => !link.removing && link.confirmedAt !== undefined).map((link) => link.repo);
}
