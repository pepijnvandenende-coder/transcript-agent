import mammoth from "mammoth";

// Client-side text extraction for the "upload as file" option (Phase 11
// feedback item 3) -- no backend change needed: the extracted text goes
// through the same POST .../transcript|notes {content: string} the
// paste-text path already used since Phase 2 (see api-client/client.ts).
// .docx uses mammoth (raw text only, no formatting/styling extracted).
// .pdf is deliberately out of scope this phase, per the Phase 11 plan:
// explicitly flagged as "eventueel" (optional) in the feedback, and
// browser-side PDF text extraction needs pdfjs-dist plus layout heuristics
// -- a materially bigger addition than .txt/.docx.
// Plain FileReader rather than the newer File.text()/arrayBuffer() promise
// methods -- broader compatibility (jsdom's test environment, and older but
// still-supported browsers, implement FileReader more completely).
function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Kon het bestand niet lezen."));
    reader.readAsText(file);
  });
}

function readAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("Kon het bestand niet lezen."));
    reader.readAsArrayBuffer(file);
  });
}

export async function extractFileText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx")) {
    const arrayBuffer = await readAsArrayBuffer(file);
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value;
  }
  if (name.endsWith(".pdf")) {
    throw new Error("PDF wordt nog niet ondersteund. Upload een .txt- of .docx-bestand, of plak de tekst hieronder.");
  }
  return readAsText(file);
}
