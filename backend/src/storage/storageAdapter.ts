// The Object Storage interface from the architecture doc. Phase 2 provides
// only a local filesystem implementation (localFilesystemStorage.ts); this
// interface is what callers (upload routes, job runners) depend on, so a
// later S3/MinIO adapter can swap in without touching them.
export interface StorageAdapter {
  put(ref: string, content: string): Promise<void>;
  get(ref: string): Promise<string>;
  // Phase 15 item 4: the .docx final report is a binary Open-XML archive,
  // not UTF-8 text -- additive alongside put/get so every existing text
  // caller (transcripts, notes) is unaffected.
  putBinary(ref: string, content: Buffer): Promise<void>;
  getBinary(ref: string): Promise<Buffer>;
}
