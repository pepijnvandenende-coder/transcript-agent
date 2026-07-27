/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev-server proxy to the backend (default port 3000, see
// backend/src/config/env.ts) -- avoids needing any CORS configuration on the
// backend for this phase. Production deployment/reverse-proxying is out of
// scope (see Phase 10 plan's "Out of scope").
//
// The bare "/workflows/:id" path is ambiguous: it's both a backend JSON
// endpoint (GET /workflows/:id) and the SPA's own client-side route
// (WorkflowPage). Client-side navigation (React Router) never hits the
// network, so the proxy never sees it -- but a hard refresh or a direct
// visit to that URL is a real page-load request, and without this bypass it
// was being proxied straight to the backend, showing raw JSON instead of the
// app (Phase 11 feedback item 8). Deeper paths (e.g.
// /workflows/:id/final-report/download) have no SPA route collision and
// always proxy normally regardless of Accept header.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/workflows": {
        target: "http://localhost:3000",
        bypass(req) {
          const isBareWorkflowResource = /^\/workflows\/[^/]+\/?(?:\?.*)?$/.test(req.url ?? "");
          if (isBareWorkflowResource && req.headers.accept?.includes("text/html")) {
            return "/index.html";
          }
        },
      },
      "/users": "http://localhost:3000",
      // Phase 13: GET /report-type-policies -- not workflow-scoped, so it's
      // mounted at its own top-level path (see backend/src/api/app.ts), and
      // needs its own proxy entry here for the same reason /users does.
      "/report-type-policies": "http://localhost:3000",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
  },
});
