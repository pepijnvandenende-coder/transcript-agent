import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // Test files share one Postgres database, including genuinely global
    // tables (approval_policies, the jobs queue) that aren't scoped per
    // workflow. Phase 3 added tests that temporarily mutate a shared
    // approval_policies row (retry/max-retries scenarios) and rely on the
    // job queue's claim-oldest-first semantics -- both unsafe under
    // file-level parallelism, so files run sequentially instead.
    fileParallelism: false,
  },
});
