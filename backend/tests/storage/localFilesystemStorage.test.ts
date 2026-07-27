import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalFilesystemStorage, PathTraversalError } from "../../src/storage/localFilesystemStorage";

// Pure filesystem tests -- no database needed.
describe("localFilesystemStorage", () => {
  let root: string;
  let storage: ReturnType<typeof createLocalFilesystemStorage>;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "transcript-agent-storage-"));
    storage = createLocalFilesystemStorage(root);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("round-trips content through put/get, creating nested directories as needed", async () => {
    await storage.put("workflow-1/transcripts/v1.txt", "hello world");
    const content = await storage.get("workflow-1/transcripts/v1.txt");
    expect(content).toBe("hello world");
  });

  it("versions independently by ref -- writing v2 does not touch v1", async () => {
    await storage.put("workflow-1/transcripts/v1.txt", "first version");
    await storage.put("workflow-1/transcripts/v2.txt", "second version");
    expect(await storage.get("workflow-1/transcripts/v1.txt")).toBe("first version");
    expect(await storage.get("workflow-1/transcripts/v2.txt")).toBe("second version");
  });

  it("rejects a relative traversal ref on put and get", async () => {
    await expect(storage.put("../escape.txt", "x")).rejects.toBeInstanceOf(PathTraversalError);
    await expect(storage.get("../escape.txt")).rejects.toBeInstanceOf(PathTraversalError);
  });

  it("rejects a nested relative traversal ref", async () => {
    await expect(storage.put("workflow-1/../../escape.txt", "x")).rejects.toBeInstanceOf(PathTraversalError);
  });

  it("rejects a ref that supplies its own absolute path outside the root", async () => {
    const absoluteEscape = path.resolve(tmpdir(), "outside-root.txt");
    await expect(storage.put(absoluteEscape, "x")).rejects.toBeInstanceOf(PathTraversalError);
  });

  // Phase 15 item 4: the .docx final report is binary content, not UTF-8
  // text -- putBinary/getBinary round-trip a Buffer without any encoding
  // applied, unlike put/get.
  it("round-trips binary content through putBinary/getBinary, creating nested directories as needed", async () => {
    const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10]);
    await storage.putBinary("workflow-1/final-reports/report.docx", binary);
    const content = await storage.getBinary("workflow-1/final-reports/report.docx");
    expect(Buffer.compare(content, binary)).toBe(0);
  });

  it("rejects a relative traversal ref on putBinary and getBinary", async () => {
    await expect(storage.putBinary("../escape.docx", Buffer.from("x"))).rejects.toBeInstanceOf(PathTraversalError);
    await expect(storage.getBinary("../escape.docx")).rejects.toBeInstanceOf(PathTraversalError);
  });
});
