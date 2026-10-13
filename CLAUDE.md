# @sudobility/writing_formats

> **Git policy.** Commit on `main`. Speed mode: local packages only, no npm publishing, no version bumps, no workflows.

File-format import/export for Fadewright. Converts between script files and `writing_core`'s plain
`DocumentJSON`. Platform-free (bytes/strings in and out; no Node built-ins, no DOM) so it runs in the
browser, Bun and React Native.

## Implemented (spec `screenwriter_plans/specs/04-file-formats.md`)

| Format | Import | Export |
|---|---|---|
| Fountain (§4.5) | `importFountain(text, opts)` | `exportFountain(doc, opts)` |
| Final Draft `.fdx` (§4.4) | `importFdx(xml, opts)` | `exportFdx(doc)` |
| Fade In `.fadein` (§4.2) | `importFadeIn(bytes \| xml, opts)` | not implemented |
| Plain text `.txt` | `importText(text, opts)` | not implemented |

`importText` is **smart plain-text import**: a screenplay typed or exported as ordinary text (no Fountain markup), where element type is guessed from how the text is *formatted* — indentation, ALL-CAPS cues, the INT./EXT. slug, parenthesis shape and transition wording. It handles indented industry-standard exports, flat left-aligned scripts with blank lines, and text copied from a PDF (strips page numbers and CONTINUED/MORE markers, flanking scene numbers, `(CONT'D)` cue suffixes), and — unlike Fountain, which keeps every physical line — **reflows wrapped lines of the same element into one paragraph** (the whole reason to import `.txt` rather than treat each line as an element). Everything is heuristic: the report carries a `confidence` and the editor's style tools are the fix-up path. `importAny` routes any `.txt` *file* here (even when its content scores as Fountain, so wrapped lines still reflow); explicit `.fountain`/`.spmd` files keep the strict Fountain parser.

Also `detectFormat(bytes | string, filename?)` (sniffing, §2.5; now refuses binary content — NUL/control/replacement-char heavy — as `format: null` instead of letting it fall through to `txt`), `importAny`, `exportAs`, `FORMATS`.
Every function returns a `ConversionReport` (§3.1): `diagnostics[]` (`info | warn | loss | error`, stable `code`,
`feature`, `count`), `stats`, `summary`. Only a wrong-format input throws (`FormatError`); unsupported features warn.

## Structure

- `src/types.ts` — `FormatId`, `Diagnostic`, `ConversionReport`, `ImportOptions`, `FormatError`.
- `src/report.ts` — `ReportBuilder` (folds repeats by code+severity, keeps up to 50 locations).
- `src/shared/build.ts` — `DocBuilder`: makes a fresh `DocumentJSON` via `writing_core`'s `createDocument` + `documentToJSON`,
  then importers fill `elements`, `titlePage`, `notes`, `bin`. Also `textFromRuns`, `parseNumberLabel`.
- `src/shared/read.ts` — `DocReader` (role/all-caps lookups for exporters) and `scanExportLosses`.
- `src/shared/xml.ts` — `fast-xml-parser` wrapped into a DOM-free `XNode` tree; DOCTYPE stripped (no entity expansion).
- `src/fountain/` — `classify.ts` (shared reader/writer block classifier), `inline.ts` (emphasis), `import.ts`, `export.ts`. `classify.ts` is genuinely dependency-free, so `package.json` also exposes it as its own `./fountain-classify` subpath export (`writing_ui`'s live-document paste classifier imports just that, without pulling in this package's `fast-xml-parser`/`fflate` FDX/.fadein dependencies).
- `src/fdx/`, `src/fadein/` — one `import.ts`/`export.ts` each. `src/txt/import.ts` — `importText` (smart plain-text; reuses `classify.ts`'s `HEADING_RE`/`isAllCapsLine`). `src/detect.ts`, `src/registry.ts`.
- `src/test-support/helpers.ts` — `elementSequence`, `validate` (materialize + `validateDocument`), `layoutPages`.

## Commands

- `bunx tsc --noEmit` (or `bun run typecheck`) — the ONLY compile command. `noEmit` is set; never run an emitting `tsc` here:
  `writing_core` resolves by path and an emitting compile once wrote 430 `.js` files into `writing_core/src`.
- `bunx vitest run` (never `bun test`). The `.fadein` tests read two private scripts from `~/projects/writing/`, skip when absent, and
  print counts only. Never copy, commit or print those files' text.

## Patterns

- Build `DocumentJSON` directly. Do NOT issue `element.insert` commands (a `writing_core` bug scrambles order inside one `execute()`).
- Never import `yjs`; get documents through `writing_core` functions (`materializeDocument`, `openDocument`, ...).
- Style ids: `st_scene_heading`, `st_action`, `st_character`, `st_parenthetical`, `st_dialogue`, `st_transition`, `st_lyrics`,
  `st_outline_1..3` (Fountain sections), `st_summary`. Resolve by role with `DocBuilder.styleForRole`, not by id string.
- Element ids are prefixed ULIDs from `newId`; dual dialogue groups are `dd_` + a ULID body.
- Text marks are `b`, `i` (true), `u` (`'single'`), `s` (true); nothing else is imported.

## Gotchas

- `documentToJSON` can return shared frozen template objects; `DocBuilder` deep-copies before importers mutate the template.
- Fade In `.fadein` applies the file's page size, margins, lines per inch and the eight builtin style slots onto the embedded
  template (so `layoutDocument` uses the writer's geometry); custom styles are added; fonts other than Courier/Times/Arial are not.
- OSF attribute names are canonicalised (lowercase, underscores removed) so v1.2/v2/v30 spellings read; only v50 is verified
  against real files.
- Fountain export uppercases all-caps styles' body text but NOT title page values; forced `!`/`@`/`.`/`>` are added by running the
  reader's own `classifyBlock` on the output.

## Known gaps (speed mode)

Not imported/exported, each reported as a warning or loss: revisions, track changes, locked pages/scenes, tags, alternates, images,
headers/footers, watermarks, macros, SmartType lists (harvest rebuilds them), FDX `ElementSettings` and page layout, range/unanchored
notes, run-level font/size/colour/link, Fade In fadein_settings. Fade In export, FDX title-page semantic fields beyond a positional guess,
scene-number locking rules and Fountain `[[marker]]`/`{{tag}}` extensions are not done.

## Related projects

`writing_core` · `writing_ui` · `screenwriter_lib` · `screenwriter_plans`
