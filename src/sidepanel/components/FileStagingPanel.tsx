import { useEffect, useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import { MAX_STAGED_UPLOAD_BYTES, formatFileSize } from "../../shared/fileData";
import { createId } from "../../shared/ids";
import { clearStagedUploadFile, loadStagedUploadFile, saveStagedUploadFile } from "../../shared/storage";
import type { StagedUploadFile } from "../../shared/types";

interface FileStagingPanelProps {
  disabled?: boolean;
}

export function FileStagingPanel({ disabled = false }: FileStagingPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [stagedFile, setStagedFile] = useState<StagedUploadFile | undefined>();
  const [status, setStatus] = useState<string | undefined>();

  useEffect(() => {
    let mounted = true;
    void loadStagedUploadFile().then((file) => {
      if (mounted) {
        setStagedFile(file);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  async function handleChooseFile(file: File | undefined) {
    if (!file) {
      return;
    }

    if (file.size > MAX_STAGED_UPLOAD_BYTES) {
      setStatus(`File is too large. Max staged size is ${formatFileSize(MAX_STAGED_UPLOAD_BYTES)}.`);
      if (inputRef.current) {
        inputRef.current.value = "";
      }
      return;
    }

    const dataUrl = await readFileAsDataUrl(file);
    const nextFile: StagedUploadFile = {
      id: createId("file"),
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      dataUrl,
      createdAt: Date.now()
    };

    await saveStagedUploadFile(nextFile);
    setStagedFile(nextFile);
    setStatus(`Staged ${file.name}.`);
  }

  async function handleClear() {
    await clearStagedUploadFile();
    setStagedFile(undefined);
    setStatus("Cleared staged file.");
    if (inputRef.current) {
      inputRef.current.value = "";
    }
  }

  return (
    <div className="file-inline" aria-label="File upload staging">
      <input
        ref={inputRef}
        className="file-input-hidden"
        type="file"
        disabled={disabled}
        onChange={(event) => void handleChooseFile(event.target.files?.[0])}
      />

      <button
        type="button"
        className={`icon-button plus-file-button ${stagedFile ? "has-file" : ""}`}
        title={stagedFile ? `Replace staged file: ${stagedFile.name}` : "Stage a file for upload"}
        aria-label={stagedFile ? `Replace staged file: ${stagedFile.name}` : "Stage a file for upload"}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <Paperclip aria-hidden="true" />
      </button>

      {stagedFile ? (
        <>
          <span className="file-inline-name" title={`${stagedFile.name} - ${formatFileSize(stagedFile.size)}`}>
            {stagedFile.name}
          </span>
          <button
            type="button"
            className="icon-button clear-file-button"
            title="Clear staged file"
            aria-label="Clear staged file"
            disabled={disabled}
            onClick={() => void handleClear()}
          >
            <X aria-hidden="true" />
          </button>
        </>
      ) : null}

      {status ? <span className="file-inline-status">{status}</span> : null}
    </div>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}
