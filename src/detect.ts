import { strFromU8, unzipSync } from 'fflate';
import { classifyBlock } from './fountain/classify.js';
import type { FormatId } from './types.js';

export interface DetectCandidate { format: FormatId; confidence: number }
export interface DetectResult {
  /** Best guess, or `null` when nothing matched. */
  format: FormatId | null;
  confidence: number;
  candidates: DetectCandidate[];
  /** Set when the content is recognised but this package cannot read it (spec 04 §1.2). */
  unsupported?: string;
}

const EXT: Record<string, FormatId> = {
  '.fountain': 'fountain', '.spmd': 'fountain', '.fdx': 'fdx', '.fadein': 'fadein', '.osf': 'fadein', '.pdf': 'pdf', '.rtf': 'rtf',
  '.docx': 'docx', '.html': 'html', '.htm': 'html', '.txt': 'txt',
};

function extOf(name?: string): FormatId | undefined {
  const m = /(\.[A-Za-z0-9]+)$/.exec(name ?? '');
  return m ? EXT[m[1]!.toLowerCase()] : undefined;
}

/**
 * True when the decoded text is almost certainly binary, not a plain-text document. UTF-8 decoding of
 * binary data yields NUL bytes, C0/C1 control characters and the replacement character (U+FFFD); real
 * text has essentially none of those (tab/newline/CR/FF/VT excepted). Without this, random bytes or an
 * unrecognised binary file would fall through to the `txt` branch below and be "imported" as a document.
 */
function looksBinary(text: string): boolean {
  const sample = text.slice(0, 4096);
  if (sample.length === 0) return false;
  let bad = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return true; // a NUL byte settles it
    // C0 controls except \t \n \v \f \r (0x09–0x0d), plus DEL and the Unicode replacement char.
    if (c < 0x09 || (c > 0x0d && c < 0x20) || c === 0x7f || c === 0xfffd) bad++;
  }
  return bad / sample.length > 0.1;
}

/** Spec 04 §4.5.8, thin: the fraction of blocks that read as something other than action, plus title page and heading bonuses. */
export function fountainScore(text: string): number {
  const head = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').slice(0, 200).join('\n');
  const blocks = head.split(/\n\s*\n/).map((b) => b.split('\n')).filter((b) => b.some((l) => l.trim()));
  if (blocks.length === 0) return 0;
  let strict = 0, headings = 0;
  for (const lines of blocks) {
    const kind = classifyBlock(lines);
    if (kind === 'heading') headings++;
    if (kind === 'heading' || kind === 'character' || kind === 'transition') strict++;
  }
  const titlePage = /^[A-Za-z][A-Za-z ]{0,30}:/.test(head.trimStart().split('\n')[0] ?? '') && /^(title|credit|author|authors|source|draft date|contact|copyright)\s*:/im.test(head) ? 0.3 : 0;
  return Math.min(1, strict / blocks.length + titlePage + Math.min(0.4, 0.2 * headings));
}

/** Content wins; the file name is a tiebreaker only (spec 04 §2.5). */
export function detectFormat(input: Uint8Array | string, filename?: string): DetectResult {
  const byName = extOf(filename);
  const done = (format: FormatId | null, confidence: number, extra: Partial<DetectResult> = {}): DetectResult => ({
    format, confidence, candidates: format ? [{ format, confidence }] : [], ...extra,
  });

  if (typeof input !== 'string' && input.length >= 4 && input[0] === 0x50 && input[1] === 0x4b && (input[2] === 3 || input[2] === 5)) {
    // Zip container: look inside.
    const names: string[] = [];
    let files: Record<string, Uint8Array> = {};
    try {
      files = unzipSync(input, { filter: (f) => { names.push(f.name); return f.name === 'document.xml' || f.name === '[Content_Types].xml'; } });
    } catch {
      return done(null, 0);
    }
    const doc = files['document.xml'];
    if (doc && /<document[^>]*Open Screenplay Format/i.test(strFromU8(doc.subarray(0, 2048)))) return done('fadein', 1);
    if (names.includes('word/document.xml')) return done('docx', 0.95);
    if (names.some((n) => n.endsWith('.scrivx'))) return done(null, 0, { unsupported: 'Scrivener projects are not supported yet.' });
    return done(null, 0);
  }

  const text = typeof input === 'string' ? input : strFromU8(input.subarray(0, 65536));
  const t = text.replace(/^﻿/, '');
  const lead = t.trimStart().slice(0, 2048);
  if (t.startsWith('%PDF-') || t.slice(0, 1024).includes('%PDF-')) return done('pdf', 1);
  if (t.startsWith('{\\rtf')) return done('rtf', 1);
  if (/<FinalDraft[\s>]/.test(lead)) return done('fdx', 1);
  if (/<document[^>]*Open Screenplay Format/i.test(lead)) return done('fadein', 1);
  if (/^<(!DOCTYPE html|html)/i.test(lead)) return done('html', 0.9);
  if (/\.(fdr|fdt|fcf|mmsw)$/i.test(filename ?? '')) return done(null, 0, { unsupported: 'Binary Final Draft and Movie Magic files are not supported; save as .fdx or PDF.' });
  if (looksBinary(t)) return done(null, 0);

  const score = fountainScore(t) + (byName === 'fountain' ? 0.3 : 0);
  const fountain: DetectCandidate = { format: 'fountain', confidence: Math.min(1, score) };
  const txt: DetectCandidate = { format: 'txt', confidence: 1 - Math.min(1, score) };
  const candidates = [fountain, txt].sort((a, b) => b.confidence - a.confidence);
  return { format: score >= 0.6 ? 'fountain' : 'txt', confidence: candidates[0]!.confidence, candidates };
}
