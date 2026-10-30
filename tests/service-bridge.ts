// The online service's real handlers at a local address, as a development
// backend runs, for tests that drive Planban on a computer (CLI, local MCP,
// board page) against it. Development sign-in (onlineLogin with devUser)
// works for any user id; people get an example.com email. Not a test file.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { apiResponse } from "../online/service/convex/http";
import * as connections from "../online/service/convex/connections";
import { memoryService } from "./hosted-harness";

const ENV = ["PLANBAN_PUBLIC_URL", "CONVEX_SITE_URL", "PLANBAN_EDGE_PROOF_SHA256", "PLANBAN_DEV_AUTH"] as const;

export async function serviceBridge(people: Array<[userId: string, name: string]> = [["ana", "Ana"], ["ben", "Ben"]]) {
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  const service = memoryService();
  let url = "";
  // A test may hold or answer a request itself, by path (a slow or failing service).
  const control: { intercept?: (path: string) => Promise<{ status: number; body: unknown } | void> } = {};
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (req.url === "/dev/token") {
      // Development sign-in, as the service's /dev/token makes it.
      const { userId } = JSON.parse(body.toString("utf8"));
      const token = `pbd_${randomBytes(24).toString("base64url")}`;
      await (connections.createDevConnection as any)._handler(service.ctx, {
        tokenHash: createHash("sha256").update(token).digest("hex"), userId, clientName: "Planban CLI", boards: "all", level: "complete",
      });
      res.writeHead(201, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ token }));
    }
    const intercepted = await control.intercept?.(req.url!);
    if (intercepted) {
      res.writeHead(intercepted.status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(intercepted.body));
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
    const response = await apiResponse(service.actionCtx, new Request(`${url}${req.url}`, { method: req.method!, headers, ...(body.length ? { body } : {}) }));
    await service.runJobs();
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
  Object.assign(process.env, { PLANBAN_PUBLIC_URL: url, CONVEX_SITE_URL: url, PLANBAN_DEV_AUTH: "1" });
  delete process.env.PLANBAN_EDGE_PROOF_SHA256;
  for (const [userId, name] of people) {
    await service.ctx.db.insert("people", { userId, name, email: `${userId}@example.com`, updatedAt: new Date().toISOString() });
  }
  return {
    url, service, control,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const name of ENV) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    },
  };
}
