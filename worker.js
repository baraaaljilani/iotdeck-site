import { handle } from "./lib/core.js";

// Server routes go to the API code; everything else is served from public/
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/api/") || pathname === "/ingest" || pathname.startsWith("/ws/")) {
      return handle(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
