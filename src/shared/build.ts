import {
  createDocument, cryptoIdSource, documentToJSON, emptyTextJSON, getBuiltinTemplate, lettersToIndices, indicesToLetters,
  newId, DEFAULT_TEMPLATE_KEY,
  type DocumentJSON, type ElementJSON, type IdSource, type NoteJSON, type NumberLabel, type StyleDef, type StyleRole,
  type TextJSON, type TitleField,
} from '@sudobility/writing_core';
import type { ImportOptions } from '../types.js';

/** A run of text with the formatting marks this package understands. */
export interface Run {
  text: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
}

const MARK_ORDER = ['b', 'i', 'u', 's'] as const;

function attrsOf(r: Run): Record<string, boolean | string> {
  const a: Record<string, boolean | string> = {};
  if (r.b) a.b = true;
  if (r.i) a.i = true;
  if (r.u) a.u = 'single';
  if (r.s) a.s = true;
  return a;
}

function sameMarks(a: Run, b: Run): boolean {
  return MARK_ORDER.every((k) => !!a[k] === !!b[k]);
}

/** Merges adjacent runs with identical marks and drops empty ones; builds a valid `TextJSON`. */
export function textFromRuns(runs: readonly Run[]): TextJSON {
  const merged: Run[] = [];
  for (const r of runs) {
    if (r.text === '') continue;
    const last = merged[merged.length - 1];
    if (last && sameMarks(last, r)) last.text += r.text;
    else merged.push({ ...r });
  }
  if (merged.length === 0) return emptyTextJSON();
  return { plain: merged.map((r) => r.text).join(''), runs: merged.map((r) => ({ text: r.text, attrs: attrsOf(r) })), embeds: [] };
}

/** Reads a `TextJSON` back into `Run`s (only b/i/u/s marks survive). */
export function runsFromText(t: TextJSON): Run[] {
  return t.runs.map((r) => {
    const run: Run = { text: r.text };
    if (r.attrs.b) run.b = true;
    if (r.attrs.i) run.i = true;
    if (r.attrs.u) run.u = true;
    if (r.attrs.s) run.s = true;
    return run;
  });
}

export function plainRuns(text: string): Run[] {
  return text === '' ? [] : [{ text }];
}

/** Spec 02 §21 label from a typed scene number (`12`, `12A`, `A12`, `12AB`); anything else is `custom`. */
export function parseNumberLabel(text: string): NumberLabel {
  const m = /^([A-Za-z]{0,3})(\d{1,6})([A-Za-z]{0,3})$/.exec(text.trim());
  if (!m) return { base: 0, prefix: [], suffix: [], custom: text.trim() };
  const seg = (s: string) => (s ? [{ kind: 'letters' as const, value: lettersToIndices(s) }] : []);
  return { base: Number(m[2]), prefix: seg(m[1]!), suffix: seg(m[3]!) };
}

export function formatNumberLabel(label: NumberLabel): string {
  if (label.custom !== undefined) return label.custom;
  const seg = (segs: NumberLabel['prefix']) => segs.map((s) => (s.kind === 'letters' ? indicesToLetters(s.value) : String(s.value))).join('');
  return `${seg(label.prefix)}${label.base}${seg(label.suffix)}`;
}

/** Nearest-role fallbacks for templates that lack a role (spec 01 role fallback, thin version). */
const ROLE_FALLBACK: Partial<Record<StyleRole, StyleRole[]>> = {
  shot: ['action'], lyrics: ['dialogue', 'action'], transition: ['action'], parenthetical: ['dialogue', 'action'],
  dialogue: ['action'], character: ['action'], sceneHeading: ['action'], synopsis: ['note', 'action'], note: ['synopsis', 'action'],
  actStart: ['sceneHeading', 'action'], actEnd: ['action'], sequence: ['action'], outline: ['sequence', 'action'],
  castList: ['action'], notation: ['action'], soundCue: ['action'], action: ['normal'], normal: [],
};

export interface Ctx {
  json: DocumentJSON;
  ids: IdSource;
  uid: string;
  now: number;
}

/** Wraps a fresh `DocumentJSON` (from `writing_core`'s own document creation) that importers fill in. */
export class DocBuilder {
  readonly json: DocumentJSON;
  readonly ids: IdSource;
  readonly uid: string;
  readonly now: number;
  private readonly noteTypeId: string;

  constructor(options: ImportOptions & { ids?: IdSource } = {}) {
    this.ids = options.ids ?? cryptoIdSource;
    this.uid = options.uid ?? 'import';
    this.now = (options.now ?? (() => Date.now()))(); // platform-free-ok: injectable clock default
    const template = getBuiltinTemplate(options.templateKey ?? DEFAULT_TEMPLATE_KEY);
    if (!template) throw new Error(`unknown template: ${options.templateKey}`);
    const ydoc = createDocument({ template, uid: this.uid, ids: this.ids, clock: () => this.now });
    // documentToJSON may hand back shared (frozen) template objects; importers mutate the template, so take a private copy.
    this.json = JSON.parse(JSON.stringify(documentToJSON(ydoc))) as DocumentJSON;
    ydoc.destroy();
    this.json.elements = [];
    this.json.titlePage = { elements: [], fields: {}, computed: {} };
    this.noteTypeId = this.json.noteTypes[0]?.id ?? '';
  }

  get styles(): readonly StyleDef[] { return this.json.template.styles; }

  /** First style with this role (with `outlineLevel` when given), falling back along `ROLE_FALLBACK`. */
  styleForRole(role: StyleRole, outlineLevel?: number): StyleDef {
    const tryRole = (r: StyleRole): StyleDef | undefined => {
      const all = this.styles.filter((s) => s.role === r);
      if (outlineLevel !== undefined) return all.find((s) => s.outlineLevel === outlineLevel) ?? all[all.length - 1] ?? undefined;
      return all[0];
    };
    const direct = tryRole(role);
    if (direct) return direct;
    for (const r of ROLE_FALLBACK[role] ?? []) {
      const s = tryRole(r);
      if (s) return s;
    }
    return this.styles[0]!;
  }

  styleByName(name: string): StyleDef | undefined {
    const n = name.trim().toLowerCase();
    return this.styles.find((s) => s.name.toLowerCase() === n);
  }

  roleOfStyle(styleId: string): StyleRole {
    return this.styles.find((s) => s.id === styleId)?.role ?? 'normal';
  }

  private meta() {
    return { createdBy: this.uid, createdAt: this.now, editedBy: this.uid, editedAt: this.now };
  }

  makeElement(styleId: string, text: TextJSON, extra: Partial<ElementJSON> = {}): ElementJSON {
    const el: ElementJSON = { id: newId('el', this.ids), style: styleId as never, text, meta: this.meta(), ...extra };
    if (this.roleOfStyle(styleId) === 'sceneHeading' && !el.scene) {
      el.scene = {
        synopsis: emptyTextJSON(), color: null, title: '', locationId: null, storyDay: '', arcBeats: {}, storylineIds: [],
        omit: null, versions: [], estimatedSeconds: null,
      };
    }
    return el;
  }

  add(el: ElementJSON): ElementJSON {
    this.json.elements.push(el);
    return el;
  }

  addNote(elementId: string, body: string, title = ''): void {
    const note: NoteJSON = {
      id: newId('note', this.ids), anchor: { kind: 'element', elementId: elementId as never }, typeId: this.noteTypeId as never,
      title, body: { plain: body, runs: body ? [{ text: body, attrs: {} }] : [], embeds: [] }, color: null, authorUid: this.uid,
      createdAt: this.now, updatedAt: this.now, resolved: null, includeInPdf: false, replies: [], mentions: [],
    };
    this.json.notes.push(note);
  }

  /** New `dd_` group id (dual dialogue). */
  newDualGroup(): string {
    return `dd_${newId('el', this.ids).slice(3)}`;
  }

  titleStyleFor(field: TitleField | null, align: 'left' | 'center' | 'right'): string {
    if (field === 'title') return 'st_title';
    return align === 'center' ? 'st_title_center' : align === 'right' ? 'st_title_right' : 'st_title_left';
  }

  addTitleElement(styleId: string, text: TextJSON, field?: TitleField, ov?: ElementJSON['ov']): ElementJSON {
    const el: ElementJSON = { id: newId('el', this.ids), style: styleId as never, text, meta: this.meta(), ...(ov ? { ov } : {}), ...(field ? { field } : {}) };
    this.json.titlePage.elements.push(el);
    if (field && !(field in this.json.titlePage.fields)) this.json.titlePage.fields[field] = el.id;
    return el;
  }

  /** Position for the scene numbers switched on by `finish` (FDX/Fade In may say; default both margins). */
  sceneNumberPosition: 'left' | 'right' | 'both' = 'both';

  /** Turns scene numbering on for the scene heading style, so imported numbers are displayed. */
  enableSceneNumbers(position: 'left' | 'right' | 'both' = this.sceneNumberPosition): void {
    const t = this.json.template;
    const style = t.styles.find((s) => s.id === t.sceneNumbering.styleId) ?? this.styleForRole('sceneHeading');
    style.numbering = {
      counter: 'own', start: 1, format: '{n}', leftOffset: 685_800, rightOffset: 6_748_272, hideRightOnOverlap: true,
      resetAfterStyle: null, resetEvery: 0, suffixMode: '1AB', skipIO: false, autoOmit: false, omittedText: null, numberFont: null,
      ...(style.numbering ?? {}), enabled: true, position,
    };
  }

  finish(importMeta: { source: 'fountain' | 'fdx' | 'fadein' | 'txt'; fileName?: string; version?: number; fdxVersion?: string; unknown?: Record<string, never> | Record<string, unknown> }): DocumentJSON {
    // Numbers are all-or-nothing on a page; a script with only some headings numbered keeps them stored but not displayed.
    const headings = this.json.elements.filter((e) => this.roleOfStyle(e.style) === 'sceneHeading');
    if (headings.length > 0 && headings.every((e) => e.num)) this.enableSceneNumbers();
    this.json.importMeta = {
      source: importMeta.source, fileName: importMeta.fileName ?? '', importedAt: this.now,
      ...(importMeta.version !== undefined ? { osfVersion: importMeta.version } : {}),
      ...(importMeta.fdxVersion !== undefined ? { fdxVersion: importMeta.fdxVersion } : {}),
      unknown: (importMeta.unknown ?? {}) as never,
    };
    return this.json;
  }

  countScenes(): number {
    return this.json.elements.filter((e) => this.roleOfStyle(e.style) === 'sceneHeading').length;
  }
}
