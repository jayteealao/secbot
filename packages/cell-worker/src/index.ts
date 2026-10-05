// The person-cell worker. The harness arrives in a later change; this release serves health only.
import { health } from "./health.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return health();
    return Response.json({ error: "not found" }, { status: 404 });
  },
};
