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
};
