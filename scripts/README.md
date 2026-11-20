# scripts/

## ExtractPdf.ts

Turns a PDF source into the two files the karpathy-llm-wiki grounding
invariant needs: the immutable original binary under `raw/<topic>/`, and a
sibling extracted-text markdown file that's greppable and citable to a
page.

### Usage

```
bun scripts/ExtractPdf.ts <pdf-or-dir>... [--topic <topic>] [--force]
```

- `<pdf-or-dir>...` — one or more PDFs and/or directories searched
  recursively for `*.pdf` files. Can point anywhere on disk. Symlinked
  PDF files are read; symlinked directories are not followed.
- `--topic <topic>` — topic subdirectory under `raw/` (default:
  `sources`). Ignored for PDFs that are already inside `raw/<topic>/`
  — the existing topic directory is reused and the file is extracted in
  place, no copy.
- `--force` — re-extract even if the target `.md` already exists.

### What it writes

For an input PDF not already under `raw/`:

- `raw/<topic>/<slug>.pdf` — a copy of the original (never moved or
  deleted from its source location; never overwritten if a same-named
  file already exists there — see Collisions below)
- `raw/<topic>/<slug>.md` — extracted text with a raw-template metadata
  header (`Source`, `Collected`, `Published`), a note that the text came
  from `pdftotext`, and the page content split by `<!-- page N -->`
  markers so wiki claims can be cited to a specific slide or page

`<slug>` is the PDF's filename, kebab-cased and truncated to 60
characters.

For a PDF already at `raw/<topic>/x.pdf`, only `raw/<topic>/x.md` is
written (or rewritten, with `--force`) — the PDF is read in place, never
copied.

### Idempotency and safety

- Skips extraction (with a message) if the target `.md` already exists,
  unless `--force` is passed.
- Never overwrites a `.pdf`. If a PDF with the same target slug already
  exists in `raw/<topic>/` and its content differs from the new source,
  that is a slug collision: the new source is NOT added, the run reports
  an error and exits non-zero (even when the `.md` already exists).
  Rename one of the two files. The same applies when a `raw/<topic>/<slug>.md`
  already exists that was not extracted from that PDF slug (its `> Source:`
  line does not name it): the source is not added, and `--force` will not
  replace it. A fresh clone that has the `.md` files but not the gitignored
  PDFs re-runs as a plain skip. Known limit: in such a clone the tool cannot
  tell two different PDFs with the same slug apart (the original PDF is gone),
  so a different PDF with the same name is skipped, and `--force` would
  replace the `.md`. Keep the PDFs (or distinct names) when re-extracting.
- Whatever already sits at the PDF destination (a symlink, a FIFO, a
  directory) is refused before it is read.
- Writes only inside `raw/`: a destination whose real directory is outside
  `raw/`, or whose final path is a symlink (even a dangling one), is
  refused. `--topic` must be a single plain directory name.
- Processing several inputs continues past individual failures and reports
  a summary; the process exits non-zero if any file failed.

### OCR caveat

If `pdftotext -layout` yields under 100 characters of text, the PDF is
almost certainly an image-only slide deck (scanned pages, or slides
exported as flattened images). The tool writes no `.md` and copies nothing
into `raw/` for that file, prints a clear error, and leaves it to you to run
OCR (e.g. `ocrmypdf`) before re-running extraction on the OCR'd PDF, which
may reuse the same file name. The check is a total-character threshold, so a
scan with a text footer on every page can pass it.

### Requirements

- `pdftotext` (poppler-utils) on `PATH`. The tool exits with a clear
  error if it's missing.
- `pdfinfo` (poppler-utils) is used opportunistically, if present, to
  fill in the `Published` date and `Title` from PDF metadata; extraction
  still works without it, falling back to `Published: Unknown` and a
  title derived from the filename.
- No external npm dependencies — Bun/Node standard APIs only.

## AdjudicateSuspects.py

Imports the vendored `check_evidence.py` (it does not re-parse its output) and, for every quote, date and figure the checker flags on a page, re-tests it against the page's linked raws with PDF page furniture and hyphen/em-dash line-wraps normalized out (joined between any two letters or digits, but never digit-to-digit, so a wrapped date such as `2019-` / `10` stays a REAL MISMATCH rather than risk inventing one). It uses the checker's own rules: the same Raw-link resolution (a link that escapes `raw/` or does not resolve is an evidence error), the raw body with its metadata header removed (collection dates are never evidence), and boundary-safe matching (`4,000` does not match inside `14,000`). Dates are re-tested like everything else. Only the `created:` / `updated:` date lines of a valid frontmatter block are ignored; claims anywhere else in a page, frontmatter included, stay subject to the gate.

Each suspect is FALSE-POSITIVE (present once furniture is stripped) or REAL MISMATCH (fix the wiki page). It only ever downgrades a suspect the checker already found; it adds no check of its own.

Exit status: 0 only when `REAL MISMATCHES` and `EVIDENCE ERRORS` are both 0, otherwise 1. Usage: `python3 scripts/AdjudicateSuspects.py [project-root]` (default: this repository; works from any directory). Needs Python 3.10+. Raw files should carry a `# ` title: a raw file without one has its `Collected:` line treated as body text. `ExtractPdf.ts` always writes a title.

Tests: `python3 scripts/test_adjudicate.py`.
