import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: requireEnv("DATABASE_URL"),
  storageRootDir: process.env.STORAGE_ROOT_DIR ?? "./storage",
  workerPollIntervalMs: Number(process.env.WORKER_POLL_INTERVAL_MS ?? 2000),
  // Phase 11: DraftGenerator calls the real Anthropic API (see
  // ai/anthropicClient.ts) instead of the deterministic stub it used since
  // Phase 6. Only required at the point the client is actually constructed
  // (lazily, on first use) -- see getAnthropicClient()'s own comment for why
  // this isn't `requireEnv` at module load time.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
};
