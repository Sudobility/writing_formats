# @sudobility/writing_formats

Import and export screenwriting file formats to and from [`writing_core`](../writing_core)'s `DocumentJSON`.
Platform-free: bytes and strings in, bytes and strings out, no Node built-ins and no DOM, so it runs in
browsers, Bun and React Native. Part of the Fadewright screenwriting toolchain.

| Format | Read | Write |
|---|---|---|
| Fountain (`.fountain`, `.spmd`) | yes | yes |
| Final Draft (`.fdx`) | yes | yes |
| Fade In (`.fadein`, `.osf`) | yes | no |
| Plain text (`.txt`) | yes (smart import) | no |

## Install

```sh
bun install @sudobility/writing_formats
```

The `@sudobility` scope is published to GitHub Packages; an `.npmrc` in this repo routes it there
(authentication comes from your own `~/.npmrc`). Peer-installs `@sudobility/writing_core`.

## Usage

```ts
import {
  detectFormat, importAny, exportAs, FORMATS,
  importFountain, exportFountain,
  importFdx, exportFdx,
  importFadeIn, importText,
} from '@sudobility/writing_formats';

const { document, report } = importFountain(text);     // DocumentJSON + ConversionReport
const { xml } = exportFdx(document);                    // -> Final Draft XML
const fadein = importFadeIn(new Uint8Array(buffer));    // .fadein / .osf is a zip
const txt = importText(plainText);                      // smart plain-text screenplay import

detectFormat(bytesOrString, 'script.txt');              // { format, confidence, candidates }
importAny(bytesOrString, 'script.fdx');                 // detect + import in one call
exportAs('fountain', document);                         // { text, report }
FORMATS;                                                // descriptors: id, label, extensions, mime, import/export
```

`importText` is a **smart plain-text import**: a screenplay saved as ordinary text with no Fountain markup,
where each element's type is guessed from how it is formatted — indentation, ALL-CAPS cues, the `INT.`/`EXT.`
slug, parenthesis shape and transition wording. It handles indented industry exports, flat left-aligned
scripts, and text copied from a PDF (strips page numbers, `CONTINUED`/`MORE` markers, flanking scene numbers
and `(CONT'D)` suffixes), and — unlike the Fountain parser, which keeps every physical line — reflows wrapped
lines of the same element back into one paragraph. It is heuristic: the report carries a `confidence`.
`importAny` routes any `.txt` file here even when its content scores as Fountain; explicit `.fountain`/`.spmd`
files always use the strict Fountain parser.

Every import/export returns a `ConversionReport`: `diagnostics[]` (severity `info | warn | loss | error`, a
stable `code`, a `feature` group and a `count`), `stats` and a `summary`. Unsupported features never throw;
they appear as `warn` or `loss`. Only input that is not the format at all throws a `FormatError`.
A `classify`-only entry point is published separately at `@sudobility/writing_formats/fountain-classify`
(the Fountain block classifier, with no XML/zip dependencies).

## Development

Uses [Bun](https://bun.sh). During the local-packages phase `@sudobility/writing_core` is resolved from the
sibling checkout `../writing_core/src/index.ts` — by `paths` in `tsconfig.json` (typecheck) and by a matching
alias in `vitest.config.ts` (tests), both applied only when that sibling exists; otherwise the published npm
dependency is used.

```sh
bun install
bun run typecheck    # tsc --noEmit (base config; never run a bare emitting tsc — see CLAUDE.md)
bun run test:unit    # vitest run
bun run build        # tsc -p tsconfig.esm.json -> dist/ (safe emit; clears the sibling paths)
bun run verify       # typecheck + test:unit + build
```

The Fade In tests read two private scripts from a local path and skip when they are absent, so a fresh
checkout runs green without them.

## License

BUSL-1.1
