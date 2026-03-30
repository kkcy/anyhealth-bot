/**
 * Extract text content from a PDF buffer.
 * Implementation TBD — evaluate pdf-parse, pdfjs-dist, or other libraries.
 * For now, provides the interface that insurance tools depend on.
 */
export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  // TODO: Replace with chosen PDF library during implementation
  // Options to evaluate:
  // - pdf-parse (simple, works for text-based PDFs)
  // - pdfjs-dist (Mozilla's PDF.js, more robust)
  // - @anthropic-ai/pdf (if available)
  // - unstructured.io API (for scanned/image PDFs)
  throw new Error(
    "PDF extraction not yet implemented. Install and configure a PDF parsing library."
  );
}

/**
 * Download a file from a URL and return as Buffer.
 */
export async function downloadFile(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
