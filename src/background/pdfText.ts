const MAX_PDF_PAGES = 20;
const MAX_PDF_TEXT_CHARS = 30000;

export interface PdfTextExtraction {
  text: string;
  pageCount?: number;
  extractedPages?: number;
  engine: "pdfjs" | "fallback";
  warning?: string;
}

export async function extractPdfText(bytes: Uint8Array): Promise<PdfTextExtraction> {
  try {
    return await extractPdfTextWithPdfJs(bytes);
  } catch (error) {
    console.warn("[BYOK Agent] PDF.js extraction failed; using fallback extractor.", error);
    return extractPdfTextFallback(bytes, error);
  }
}

async function extractPdfTextWithPdfJs(bytes: Uint8Array): Promise<PdfTextExtraction> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const loadingTask = pdfjs.getDocument({
    data,
    disableWorker: true,
    disableFontFace: true,
    isEvalSupported: false
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]);

  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;
  const extractedPages = Math.min(pageCount, MAX_PDF_PAGES);
  const pageTexts: string[] = [];

  for (let pageNumber = 1; pageNumber <= extractedPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map(getPdfTextItemString)
      .filter(Boolean)
      .join(" ");
    if (pageText.trim()) {
      pageTexts.push(`Page ${pageNumber}: ${normalizeWhitespace(pageText)}`);
    }

    if (pageTexts.join("\n").length >= MAX_PDF_TEXT_CHARS) {
      break;
    }
  }

  const text = truncateText(pageTexts.join("\n"), MAX_PDF_TEXT_CHARS);
  return {
    text,
    pageCount,
    extractedPages,
    engine: "pdfjs"
  };
}

function extractPdfTextFallback(bytes: Uint8Array, error: unknown): PdfTextExtraction {
  const raw = new TextDecoder("latin1").decode(bytes);
  const literalStrings = Array.from(raw.matchAll(/\((?:\\.|[^\\)]){2,}\)/g))
    .map((match) => decodePdfLiteralString(match[0]))
    .filter((value) => /[A-Za-z0-9]{2}/.test(value));
  const hexStrings = Array.from(raw.matchAll(/<([0-9A-Fa-f\s]{8,})>/g))
    .map((match) => decodePdfHexString(match[1]))
    .filter((value) => /[A-Za-z0-9]{2}/.test(value));
  const text = truncateText(normalizeWhitespace([...literalStrings, ...hexStrings].join(" ")), MAX_PDF_TEXT_CHARS);

  return {
    text,
    engine: "fallback",
    warning: error instanceof Error ? error.message : String(error)
  };
}

function getPdfTextItemString(item: unknown): string {
  if (item && typeof item === "object" && "str" in item) {
    return String((item as { str?: unknown }).str || "");
  }
  return "";
}

function decodePdfLiteralString(value: string): string {
  return value
    .slice(1, -1)
    .replace(/\\([nrtbf()\\])/g, (_match, escaped: string) => {
      const replacements: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        "(": "(",
        ")": ")",
        "\\": "\\"
      };
      return replacements[escaped] || escaped;
    })
    .replace(/\\([0-7]{1,3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

function decodePdfHexString(value: string): string {
  const compact = value.replace(/\s+/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < compact.length - 1; index += 2) {
    const byte = Number.parseInt(compact.slice(index, index + 2), 16);
    if (Number.isFinite(byte)) {
      bytes.push(byte);
    }
  }

  try {
    return new TextDecoder("utf-16be").decode(new Uint8Array(bytes));
  } catch {
    return String.fromCharCode(...bytes);
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 28)}\n[truncated PDF text]`;
}

