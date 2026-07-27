import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "../config/env";
import type { StorageAdapter } from "./storageAdapter";

export class PathTraversalError extends Error {
  constructor(public readonly ref: string) {
    super(`storage_ref "${ref}" resolves outside the storage root`);
    this.name = "PathTraversalError";
  }
}

// Resolves ref against root and rejects anything that escapes it -- covers
// both "../"-style relative traversal and a ref supplying its own absolute
// path, since both are caught by checking the final resolved path rather
// than inspecting ref's shape.
function resolveWithinRoot(root: string, ref: string): string {
  const resolved = path.resolve(root, ref);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathTraversalError(ref);
  }
  return resolved;
}

export function createLocalFilesystemStorage(rootDir: string): StorageAdapter {
  const root = path.resolve(rootDir);

  return {
    async put(ref, content) {
      const target = resolveWithinRoot(root, ref);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    },
    async get(ref) {
      const target = resolveWithinRoot(root, ref);
      return fs.readFile(target, "utf8");
    },
    async putBinary(ref, content) {
      const target = resolveWithinRoot(root, ref);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    },
    async getBinary(ref) {
      const target = resolveWithinRoot(root, ref);
      return fs.readFile(target);
    },
  };
}

// Shared instance for the running process, rooted at STORAGE_ROOT_DIR.
export const localFilesystemStorage = createLocalFilesystemStorage(env.storageRootDir);
