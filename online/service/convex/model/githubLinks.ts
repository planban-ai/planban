// Reading a board's linked GitHub repositories (see github.ts), shared by the
// board reads and the webhook without either importing the other.
import type { QueryCtx } from "../_generated/server";

/** A board's links, oldest first: the first is the home repository, whose `#123` a bare reference means. */
export async function boardLinks(ctx: QueryCtx, boardId: string) {
  return (await ctx.db.query("githubLinks").withIndex("by_board", (q) => q.eq("boardId", boardId)).collect())
    .sort((a, b) => a._creationTime - b._creationTime);
}

/** The repositories linked to a board, the home repository first. */
export async function linkedRepos(ctx: QueryCtx, boardId: string): Promise<string[]> {
  return (await boardLinks(ctx, boardId)).map((link) => link.repo);
}
