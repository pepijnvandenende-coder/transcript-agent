import { env } from "../config/env";
import { runPollingLoop } from "./worker";

// Entry point for `npm run worker`. Deliberately a separate process from the
// API server (src/api/server.ts) -- the API server only ever enqueues jobs,
// it never runs them, so job processing can be scaled/restarted/observed
// independently of request handling.
console.log(`transcript-agent worker polling every ${env.workerPollIntervalMs}ms`);

runPollingLoop(env.workerPollIntervalMs).catch((err) => {
  console.error("Worker polling loop crashed:", err);
  process.exit(1);
});
