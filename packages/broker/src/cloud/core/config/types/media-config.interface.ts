export interface MediaConfig {
  maxAttachmentBytes: number;
  maxExtractedTextChars: number;
  maxRedirects: number;
  timeoutMs: number;
  allowUrl: boolean;
  pdf: {
    maxPages: number;
    maxPixels: number;
    minTextChars: number;
    maxRenderedPages: number;
  };
  spreadsheet: {
    maxSheets: number;
    maxRowsPerSheet: number;
    maxCells: number;
  };
}
