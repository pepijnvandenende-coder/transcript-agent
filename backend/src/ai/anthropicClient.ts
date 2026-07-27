import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env";

// Lazily-constructed singleton, isolated in its own module for two reasons:
// (1) ANTHROPIC_API_KEY is only required once a real-LLM skill (currently
// only DraftGenerator, see ai/skills/draftGenerator.ts) actually runs --
// most of the test suite and the server/worker startup path never touch
// this module, so env.ts itself doesn't require the key eagerly; (2) tests
// that exercise DraftGenerator end-to-end (tests/jobs/worker.test.ts) mock
// this whole module instead of hitting the real API, keeping the existing
// "no network dependency in tests" convention.
let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!client) {
    if (!env.anthropicApiKey) {
      throw new Error("Missing required environment variable: ANTHROPIC_API_KEY");
    }
    client = new Anthropic({ apiKey: env.anthropicApiKey });
  }
  return client;
}
