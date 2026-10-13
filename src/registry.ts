import { detectFormat } from './detect.js';
import { exportFdx } from './fdx/export.js';
import { importFdx } from './fdx/import.js';
import { importFadeIn } from './fadein/import.js';
import { exportFountain } from './fountain/export.js';
import { importFountain } from './fountain/import.js';
import { importText } from './txt/import.js';
import { strFromU8 } from 'fflate';
import { FormatError, type FormatId, type ImportOptions, type ImportResult } from './types.js';
import type { DocumentJSON } from '@sudobility/writing_core';

export interface FormatDescriptor {
  id: FormatId;
  label: string;
  extensions: readonly string[];
  mimeTypes: readonly string[];
  import: boolean;
  export: boolean;
}

/** The formats this package reads and writes today. */
export const FORMATS: readonly FormatDescriptor[] = [
  { id: 'fountain', label: 'Fountain', extensions: ['.fountain', '.spmd'], mimeTypes: ['text/plain'], import: true, export: true },
  { id: 'fdx', label: 'Final Draft', extensions: ['.fdx'], mimeTypes: ['application/xml'], import: true, export: true },
  { id: 'fadein', label: 'Fade In', extensions: ['.fadein', '.osf'], mimeTypes: ['application/zip'], import: true, export: false },
  { id: 'txt', label: 'Plain text', extensions: ['.txt'], mimeTypes: ['text/plain'], import: true, export: false },
];

/** Detects the format from content and imports it. Throws `FormatError` for unsupported or unrecognised input. */
export function importAny(input: Uint8Array | string, filename?: string, options: ImportOptions = {}): ImportResult {
  const d = detectFormat(input, filename);
  const opts = { fileName: filename, ...options };
  const asText = () => (typeof input === 'string' ? input : strFromU8(input));
  // A .txt file is smart-imported (element detection + wrapped-line reflow) even when its content reads as
  // Fountain; explicit .fountain/.spmd files keep the strict Fountain parser.
  const isTxtFile = /\.txt$/i.test(filename ?? '');
  switch (d.format) {
    case 'fountain': return isTxtFile ? importText(asText(), opts) : importFountain(asText(), opts);
    case 'txt': return importText(asText(), opts);
    case 'fdx': return importFdx(asText(), opts);
    case 'fadein': return importFadeIn(input, opts);
    default:
      throw new FormatError(d.unsupported ? 'FORMAT_UNSUPPORTED' : 'FORMAT_UNRECOGNIZED', d.unsupported ?? `Cannot import this file (detected: ${d.format ?? 'unknown'}).`);
  }
}

export function exportAs(format: 'fountain' | 'fdx', document: DocumentJSON): { text: string; report: ReturnType<typeof exportFountain>['report'] } {
  if (format === 'fdx') { const r = exportFdx(document); return { text: r.xml, report: r.report }; }
  const r = exportFountain(document);
  return { text: r.text, report: r.report };
}
