/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev-server proxy to the backend (default port 3000, see
// backend/src/config/env.ts) -- avoids needing any CORS configuration on the
// backend for this phase. Production deployment/reverse-proxying is out of
// scope (see Phase 10 plan's "Out of scope").
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/workflows": "http://localhost:3000",
      "/users": "http://localhost:3000",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/setupTests.ts"],
  },
});
