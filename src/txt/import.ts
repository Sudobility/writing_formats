import type { StyleRole } from '@sudobility/writing_core';
import { DocBuilder, plainRuns, textFromRuns } from '../shared/build.js';
import { ReportBuilder } from '../report.js';
import type { ImportOptions, ImportResult } from '../types.js';
import { HEADING_RE, isAllCapsLine } from '../fountain/classify.js';

/**
 * Smart plain-text (`.txt`) import.
 *
 * Unlike Fountain (which relies on an exact blank-line convention and keeps every physical line), this reads
 * a screenplay typed or exported as ordinary text and guesses each element from how the text is *formatted*:
 * indentation, ALL-CAPS cues, the INT./EXT. slug, parenthesis shape and transition wording. It handles the
 * three shapes real .txt files come in — industry-standard indented exports, flat left-aligned scripts with
 * blank lines between elements, and text copied out of a PDF (page numbers, CONTINUED/MORE markers, and
 * hard-wrapped lines). Wrapped lines of the same element are reflowed into one paragraph with the newlines
 * removed, which is the whole point of importing from .txt rather than treating each line as its own element.
 *
 * Everything here is heuristic; the report carries a confidence and the style tools (Tab / Cmd+number) are the
 * fix-up path for the cases no amount of formatting can disambiguate (e.g. a last line of dialogue that runs
 * straight into action with no blank line and no new cue — the same ambiguity Fountain's blank lines avoid).
 */

/** Roles emitted here. Everything collapses to these six screenplay elements. */
type TxtRole = 'sceneHeading' | 'action' | 'character' | 'dialogue' | 'parenthetical' | 'transition';

/** These merge consecutive lines into one reflowed paragraph; the rest are always one line each. */
const MERGEABLE: ReadonlySet<TxtRole> = new Set<TxtRole>(['action', 'dialogue']);

/** A line that is only a page number (`12` or `12.`), left over from a PDF or a printed page. */
const PAGE_NUMBER_RE = /^\s*\d{1,4}\.?\s*$/;
/** Standalone CONTINUED / (CONTINUED) / CONTINUED: / (MORE) page-break artifacts. */
const CONTINUATION_RE = /^\s*\(?\s*(?:CONTINUED|MORE)\s*\)?\s*:?\s*$/i;
/** A `(CONT'D)` / `(CONTINUED)` suffix on a character cue, which the editor regenerates itself. */
const CONTD_SUFFIX_RE = /\s*\((?:CONT['’]?D|CONTINUED)\)\s*$/i;

/** Visual indent width of a line, counting a tab as four columns. */
function indentWidth(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === ' ') w++;
    else if (ch === '\t') w += 4;
    else break;
  }
  return w;
}

/** Collapses runs of inner whitespace so a reflowed paragraph reads as one clean line. */
function reflow(lines: readonly string[]): string {
  return lines.map((l) => l.trim()).join(' ').replace(/\s{2,}/g, ' ').trim();
}

const isParenthetical = (t: string): boolean => /^\(.*\)$/.test(t);

/** A transition line: ALL CAPS and either ends in `TO:` or opens with a known transition word. */
function isTransition(t: string): boolean {
  if (!isAllCapsLine(t)) return false;
  if (/\bTO:$/.test(t)) return true;
  return /^(?:FADE (?:IN|OUT|TO)|CUT TO|SMASH CUT|MATCH CUT|JUMP CUT|DISSOLVE|INTERCUT|BACK TO|WIPE TO|IRIS (?:IN|OUT)|THE END)\b/.test(t);
}

/** The cue name with a trailing dual `^`, a `(CONT'D)` and any `(V.O.)`/`(O.S.)` extension left in place but trimmed. */
const cueCore = (t: string): string => t.replace(/\^\s*$/, '').replace(/\([^)]*\)\s*$/, '').trim();

/**
 * Whether a line reads like a character cue: ALL CAPS, short, and not a full sentence (real cues do not end in
 * `.`/`!`/`?`). The caller still gates this on the cue sitting at the cue indent column (indented scripts) or
 * being followed by a dialogue-shaped line (flat scripts), to keep SHOUTED dialogue from reading as a new cue.
 */
function looksLikeCue(t: string): boolean {
  if (!isAllCapsLine(t)) return false;
  const core = cueCore(t);
  if (core.length === 0 || core.length > 50) return false;
  return !/[.!?]$/.test(core);
}

/**
 * A scene heading's text with flanking scene numbers stripped, or null when the line is not a heading.
 * Numbers set off by two or more spaces (or a leading `12.`) are scene numbers; a single-spaced trailing
 * number (e.g. `INT. ROOM 237`) is left as part of the slug.
 */
function headingText(t: string): string | null {
  const stripped = t.replace(/^\d{1,4}[A-Za-z]?(?:\.|\)|\s{2,})\s*/, '').replace(/\s{2,}\d{1,4}[A-Za-z]?$/, '').trim();
  if (HEADING_RE.test(stripped)) return stripped;
  if (HEADING_RE.test(t)) return t;
  return null;
}

interface Profile {
  base: number;
  indented: boolean;
  /** The column cues sit at, when the script indents them consistently; null when it does not. */
  cueWidth: number | null;
  /** At or beyond this relative indent a line is dialogue-indented (indented scripts only). */
  dialogueMin: number;
}

/** Looks at the indentation of every content line to decide whether (and how) this script encodes elements by margin. */
function indentProfile(contentLines: readonly string[]): Profile {
  const widths = contentLines.map(indentWidth);
  const base = widths.length ? Math.min(...widths) : 0;
  const spread = widths.length ? Math.max(...widths) - base : 0;
  const indentedCount = widths.filter((w) => w - base >= 3).length;
  const indented = spread >= 4 && indentedCount / Math.max(1, widths.length) >= 0.1;

  let cueWidth: number | null = null;
  if (indented) {
    const counts = new Map<number, number>();
    contentLines.forEach((line, k) => {
      const t = line.trim();
      if (headingText(t) || isTransition(t) || isParenthetical(t)) return;
      if (looksLikeCue(t)) counts.set(widths[k]!, (counts.get(widths[k]!) ?? 0) + 1);
    });
    let best = -1;
    for (const [w, n] of counts) if (n > best || (n === best && w > (cueWidth ?? -1))) { best = n; cueWidth = w; }
  }
  return { base, indented, cueWidth, dialogueMin: base + 2 };
}

const CONTINUES_DIALOGUE = (r: TxtRole | null): boolean => r === 'character' || r === 'dialogue' || r === 'parenthetical';

/** Classifies one content line given the indent profile, the previous role (reset at blank lines) and a lookahead line. */
function classify(line: string, prof: Profile, prev: TxtRole | null, next: string | undefined): TxtRole {
  const t = line.trim();
  if (headingText(t)) return 'sceneHeading';
  if (isParenthetical(t)) return 'parenthetical';
  if (isTransition(t)) return 'transition';

  const rel = indentWidth(line) - prof.base;
  if (looksLikeCue(t)) {
    const atCueColumn = prof.cueWidth !== null && Math.abs(indentWidth(line) - prof.cueWidth) <= 2;
    const nextIsDialogue = next !== undefined && next.trim() !== '' && (!isAllCapsLine(next.trim()) || isParenthetical(next.trim()));
    if (prof.indented ? (atCueColumn || (prof.cueWidth === null && nextIsDialogue)) : nextIsDialogue) return 'character';
  }

  if (prof.indented && rel >= prof.dialogueMin) return 'dialogue';
  if (CONTINUES_DIALOGUE(prev)) return 'dialogue';
  return 'action';
}

export function importText(input: string, options: ImportOptions = {}): ImportResult {
  const report = new ReportBuilder('import', 'txt');
  const b = new DocBuilder(options);
  const src = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  // Clean page artifacts; a form feed and a dropped artifact both act as an element boundary (an empty line).
  let artifacts = 0;
  const lines = src.split('\n').map((raw) => {
    const line = raw.replace(/\f/g, '').replace(/\s+$/, '');
    if (PAGE_NUMBER_RE.test(line) || CONTINUATION_RE.test(line)) { artifacts++; return ''; }
    return line;
  });

  const content = lines.filter((l) => l.trim() !== '');
  const prof = indentProfile(content);

  const S = (role: TxtRole): string => b.styleForRole(role).id;
  let reflowed = 0;

  // Buffer merges consecutive mergeable lines; single-line roles flush it and emit on their own.
  let buf: string[] = [];
  let bufRole: TxtRole | null = null;
  const flush = (): void => {
    if (buf.length && bufRole) {
      if (buf.length > 1) reflowed++;
      b.add(b.makeElement(S(bufRole), textFromRuns(plainRuns(reflow(buf)))));
    }
    buf = [];
    bufRole = null;
  };
  const emitSingle = (role: TxtRole, text: string): void => {
    flush();
    b.add(b.makeElement(S(role), textFromRuns(plainRuns(text))));
  };

  let prev: TxtRole | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') { flush(); prev = null; continue; }

    const role = classify(line, prof, prev, lines[i + 1]);
    if (role === 'sceneHeading') emitSingle('sceneHeading', headingText(line.trim()) ?? line.trim());
    else if (role === 'character') emitSingle('character', line.trim().replace(CONTD_SUFFIX_RE, ''));
    else if (role === 'parenthetical' || role === 'transition') emitSingle(role, line.trim());
    else if (bufRole === role) buf.push(line);
    else { flush(); bufRole = role; buf = [line]; }
    prev = role;
  }
  flush();

  // A valid document needs at least one element; an all-blank file becomes one empty action line.
  if (b.json.elements.length === 0) b.add(b.makeElement(S('action'), textFromRuns([])));

  const scenes = b.countScenes();
  const structural = b.json.elements.filter((e) => {
    const role = b.roleOfStyle(e.style);
    return role === 'sceneHeading' || role === 'character' || role === 'transition';
  }).length;
  const confidence = Math.min(1, structural / Math.max(1, b.json.elements.length));

  if (artifacts) report.info('TXT_PAGE_ARTIFACTS', 'pagination', 'Page numbers and CONTINUED/MORE markers were removed.');
  if (reflowed) report.info('TXT_REFLOW', 'formatting', 'Lines wrapped across the page were joined back into single paragraphs.');
  report.info('TXT_HEURISTIC', 'formatting', 'Elements were detected from the text formatting; review and adjust any the importer guessed wrong with the style tools.');
  if (scenes === 0) report.warn('TXT_NO_SCENES', 'structure', 'No scene headings (INT./EXT.) were found; the whole script was imported without scene breaks.');

  const document = b.finish({ source: 'txt', fileName: options.fileName });
  return {
    document,
    report: report.build({ elements: document.elements.length, scenes }, { confidence }),
  };
}
