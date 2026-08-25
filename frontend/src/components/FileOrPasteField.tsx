import { type ChangeEvent, useState } from "react";
import { extractFileText } from "./extractFileText";

// A single source field that accepts either a pasted-in textarea value or an
// uploaded file (Phase 11 feedback item 3) -- both paths write to the same
// piece of state. Shared between UploadScreen (transcript) and
// ContextStepScreen (notes/context types, Phase 19) -- previously duplicated
// as a local component in UploadScreen.tsx before the context step moved
// onto its own screen.
export function FileOrPasteField({
  id,
  label,
  instructions,
  value,
  onChange,
  required,
}: {
  id: string;
  label: string;
  instructions: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  const [fileError, setFileError] = useState<string | null>(null);

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setFileError(null);
    try {
      onChange(await extractFileText(file));
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "Kon het bestand niet lezen.");
    }
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <p className="helper-text">{instructions}</p>
      <input type="file" accept=".txt,.docx,.pdf,text/plain" aria-label={`${label} als bestand uploaden`} onChange={handleFile} />
      {fileError && <p role="alert">{fileError}</p>}
      <textarea id={id} value={value} onChange={(event) => onChange(event.target.value)} required={required} rows={10} />
    </div>
  );
}
