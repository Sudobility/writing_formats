import { describe, expect, it } from 'vitest';
import { importText } from './import.js';
import { importAny } from '../registry.js';
import { detectFormat } from '../detect.js';
import type { DocumentJSON, ElementJSON } from '@sudobility/writing_core';

/** The role of each element, for terse assertions. */
function roles(doc: DocumentJSON): string[] {
  const styleRole = new Map(doc.template.styles.map((s) => [s.id, s.role]));
  return doc.elements.map((e) => styleRole.get(e.style) ?? 'normal');
}
const texts = (doc: DocumentJSON): string[] => doc.elements.map((e: ElementJSON) => e.text.plain);
const now = () => 1_700_000_000_000;

describe('importText', () => {
  it('reads an indented, industry-standard script and reflows wrapped dialogue', () => {
    // Character cues deeply indented, dialogue less so, action at the margin — Final Draft "Save as Text" shape.
    const src = [
      'INT. KITCHEN - DAY',
      '',
      'Maya stands at the counter, staring at a letter she has read',
      'four times already and still does not believe.',
      '',
      '                    MAYA',
      '          I cannot believe they said yes. After',
      '          everything, they actually said yes.',
      '',
      '                    JAMES',
      '          Then we should go.',
      '',
      '          CUT TO:',
    ].join('\n');
    const { document, report } = importText(src, { now });
    expect(roles(document)).toEqual(['sceneHeading', 'action', 'character', 'dialogue', 'character', 'dialogue', 'transition']);
    // Wrapped action and dialogue each became ONE element with the newlines removed.
    expect(texts(document)[1]).toBe('Maya stands at the counter, staring at a letter she has read four times already and still does not believe.');
    expect(texts(document)[3]).toBe('I cannot believe they said yes. After everything, they actually said yes.');
    expect(document.elements[2]!.text.plain).toBe('MAYA');
    expect(report.summary.warn).toBe(0);
    expect(report.confidence).toBeGreaterThan(0);
  });

  it('reads a flat, left-aligned script with blank lines between elements', () => {
    const src = [
      'INT. OFFICE - NIGHT',
      '',
      'The lights are off. A single monitor glows.',
      '',
      'SAM',
      '(whispering)',
      'Is anyone still here?',
      '',
      'FADE OUT.',
    ].join('\n');
    const { document } = importText(src, { now });
    expect(roles(document)).toEqual(['sceneHeading', 'action', 'character', 'parenthetical', 'dialogue', 'transition']);
    expect(document.elements[2]!.text.plain).toBe('SAM');
    expect(document.elements[4]!.text.plain).toBe('Is anyone still here?');
  });

  it('cleans PDF artifacts (page numbers, CONTINUED/MORE, CONT’D) and reflows', () => {
    const src = [
      '12.',
      '',
      'INT. HALLWAY - CONTINUOUS                                   12',
      '',
      '          MAYA (CONT’D)',
      '          We have to keep moving before they',
      '          realize we are gone.',
      '',
      '(CONTINUED)',
      '',
      'CONTINUED:',
      '',
      'She runs.',
    ].join('\n');
    const { document, report } = importText(src, { now });
    expect(roles(document)).toEqual(['sceneHeading', 'character', 'dialogue', 'action']);
    // Flanking scene numbers stripped from the heading.
    expect(document.elements[0]!.text.plain).toBe('INT. HALLWAY - CONTINUOUS');
    // (CONT'D) stripped from the cue.
    expect(document.elements[1]!.text.plain).toBe('MAYA');
    expect(document.elements[2]!.text.plain).toBe('We have to keep moving before they realize we are gone.');
    expect(report.summary.info).toBeGreaterThan(0);
  });

  it('warns when there are no scene headings but still imports the text', () => {
    const { document, report } = importText('Just a paragraph of prose with no screenplay structure at all.\n', { now });
    expect(document.elements).toHaveLength(1);
    expect(roles(document)).toEqual(['action']);
    expect(report.summary.warn).toBeGreaterThan(0);
  });

  it('never produces an empty document', () => {
    const { document } = importText('\n\n   \n', { now });
    expect(document.elements).toHaveLength(1);
  });

  it('records txt as the import source', () => {
    const { document } = importText('INT. A - DAY\n', { now });
    expect(document.importMeta?.source).toBe('txt');
  });
});

describe('importAny routing for .txt', () => {
  it('routes a .txt file through the smart importer (reflowing wrapped lines) even when it reads as Fountain', () => {
    const src = 'INT. HOUSE - DAY\n\nMAYA\nHello there, this is one\nwrapped speech.\n';
    const doc = importAny(src, 'script.txt', { now }).document;
    // The two physical dialogue lines were reflowed into one element (Fountain would keep both).
    const dialogue = doc.elements.find((e) => doc.template.styles.find((s) => s.id === e.style)?.role === 'dialogue');
    expect(dialogue?.text.plain).toBe('Hello there, this is one wrapped speech.');
  });

  it('keeps the strict Fountain parser for .fountain files', () => {
    const doc = importAny('INT. HOUSE - DAY\n\nMAYA\nHello.\n', 'a.fountain', { now }).document;
    expect(doc.importMeta?.source).toBe('fountain');
  });

  it('refuses binary content rather than importing it as text', () => {
    const bytes = new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 37 + 3) % 256));
    expect(detectFormat(bytes, 'notes.bin').format).toBeNull();
    expect(() => importAny(bytes, 'notes.bin')).toThrowError(/Cannot import/);
  });
});
