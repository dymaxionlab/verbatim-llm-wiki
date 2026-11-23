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

## CaptureWeb.ts

Captures one web page as the two files the grounding invariant needs: the
original HTML under `raw/<topic>/`, and a sibling readable-text markdown file
that is greppable and citable.

### Usage

```
bun scripts/CaptureWeb.ts <url> [--slug <s>] [--from-html <file>] [--topic web] [--force]
```

- `<url>` — an `http` or `https` URL. Fetched exactly once: one request, a
  30 s timeout, no retry loop, no crawling. Non-2xx responses and non-HTML
  content types are errors that write nothing.
- `--slug <s>` — slug for the file name. Default: the kebab-cased page
  `<title>` (falling back to `og:title`, then the first `<h1>`, then the URL).
  Date prefix plus slug never exceed 60 characters. With `--slug`, a re-run
  skips (or reports a collision) before any request is made.
- `--from-html <file>` — read the HTML from a saved file instead of fetching.
  For JS-rendered pages fetched by another tool. `<url>` is still required:
  it is recorded as the Source. Nothing is fetched.
- `--topic <topic>` — topic subdirectory under `raw/` (default: `web`), a
  single plain directory name.
- `--force` — re-capture even if the target `.md` already exists.

### What it writes

- `raw/<topic>/<YYYY-MM-DD>-<slug>.html` — the original bytes, gitignored.
  The date is the **capture** date (local time), not the published date.
- `raw/<topic>/<YYYY-MM-DD>-<slug>.md` — the raw-template header (`Source`,
  `Collected`, `Published`, and `Author` when a byline is found), a note that
  the text came from CaptureWeb HTML-to-text, then the readable text.

`Author` is read from the first source that yields a name (sources are not
merged): `<meta name="author">` (also `citation_author`, `dc.creator`, a
non-URL `article:author`), JSON-LD `author`, `itemprop="author"`, then
`rel="author"` links inside the page's first `<article>` (a related-posts card
is a later `<article>`, so it is never read as the author). Several authors are
joined with `, `. A URL, an e-mail address or a bare number is never a name. No
byline, no `> Author:` line. The header line is bookkeeping, like `Published`:
the byline is evidence only when it also appears in the text, which it now does
(see HTML to text).

`Published` is read from `<meta property="article:published_time">`, then
`itemprop="datePublished"`, then JSON-LD `datePublished`, then the first
`<time datetime>`, and only when the value is ISO-style (`YYYY-MM-DD…`).
Otherwise it is `Unknown`; a human-written date is never guessed into digits.

### HTML to text

`script`, `style`, `nav`, `header`, `footer`, `noscript` and `svg` are
dropped (as are `head` and `template`), with one exception: an article's own
`<header>` and `<footer>` (one inside an `<article>` or `<main>`) hold its
byline, reference list, footnotes and author box, so an element inside them whose
class or id names one of those (`byline`, `author`, `authors`, `authorinfo`,
`reference(s)`, `footnote(s)`, `endnote(s)`, `bibliography`, matched as a whole
word between `-`/`_` boundaries) or that is `rel="author"` / `itemprop="author"`
is kept. Everything else in that header or footer (share buttons, category
links, newsletter promos), any `nav` inside a kept element, and every page-level
header and footer stay dropped. Some article pages keep their byline, reference
list, footnotes and author box in `<header class="article-header">` and
`<footer class="article-footer">`, which a rule dropping every header and footer
whole would lose. Headings become markdown `#` lines,
list items become `- ` lines, paragraphs and blocks get their own lines, and
table rows become one line each with the cells joined by ` | `. Entities
(named, decimal and hex, one level only) are decoded and whitespace is
collapsed. Quote and apostrophe characters are never normalized: a curly
quote in the source stays curly, a straight one stays straight, so verbatim
quoting against the `.md` works byte for byte. Formatting is approximate;
images, scripts and navigation are not captured. A page that yields under 40
characters of text (a JS shell) is refused with a pointer to `--from-html`.

### Idempotency and safety

- Skips (with a message) if the target `.md` exists and its `> Source:` line
  names this URL, unless `--force` is passed.
- An existing `.md` whose Source names a **different** URL is a slug
  collision: nothing is changed, the run exits non-zero, and `--force` will
  not replace it. Pass a different `--slug`. A lone `.html` with different
  bytes and no `.md` is also a collision.
- Without `--slug` the slug comes from the fetched page, so the fetch happens
  before the collision check; the fetched bytes are discarded on a collision.
- Symlinks at either destination, a symlinked `raw/` or topic directory, and
  anything resolving outside `raw/` are refused. `--force` replaces only
  regular files whose `.md` vouches for the same Source.

### Requirements

Bun only. No npm dependencies. Tests: `bun test scripts/CaptureWeb.test.ts`
(fixtures in `scripts/fixtures/`, a local HTTP server, no real site).

## CaptureVideo.ts

Captures a video's captions as a transcript for the grounding invariant,
using `yt-dlp` for metadata and subtitles. No video or audio is downloaded.

### Usage

```
bun scripts/CaptureVideo.ts <url> [--topic video] [--lang en] [--force]
```

- `<url>` — an `http` or `https` video URL that `yt-dlp` understands.
- `--topic <topic>` — topic subdirectory under `raw/` (default: `video`).
- `--lang <code>` — caption language (default: `en`), one language code.
- `--force` — re-capture even if the target `.md` already exists.

### What it writes

- `raw/<topic>/<YYYY-MM-DD>-<slug>.md` — capture date, slug from the video
  title (date prefix plus slug at most 60 characters). Header: `Source`,
  `Collected`, `Published` (the upload date as `YYYY-MM-DD`, else `Unknown`),
  `Captions: manual|auto`, `Channel` (uploader, else `Unknown`), then a note
  and the transcript.
- `raw/<topic>/<YYYY-MM-DD>-<slug>.vtt` — the original caption file, a
  gitignored sidecar.

The transcript is split into blocks, each opened by a
`<!-- t=MM:SS -->` marker (`<!-- t=H:MM:SS -->` from one hour on). A marker
opens at the first cue that contributes text at or after each 30-second
boundary and shows that cue's own start time, rounded down; text in a block
is one line. `<c>`, timestamp and `<v>` tags are removed and entities
decoded. For auto-generated captions, a line already shown in the previous
cue is dropped (YouTube auto VTT repeats each line as its window rolls);
manual captions are kept as written, repeated lines included. Quote
characters are never normalized. A quote that spans a marker still verifies:
`AdjudicateSuspects.py` strips the markers as furniture.

### Refusals

A video with no subtitles in the requested language is refused with the
manual and auto languages that do exist. There is no fallback to speech
recognition or anything else. A caption file with no text, a `yt-dlp`
failure (its stderr is shown), and `yt-dlp` missing from `PATH` are errors
that write nothing. Manual captions are preferred over auto captions when
both exist. `yt-dlp` runs once per invocation.

### Idempotency and safety

Same as `CaptureWeb.ts`: skip when the `.md` Source names this URL; a
different video under the same slug is a collision that `--force` does not
override; symlinks and anything resolving outside `raw/` are refused.

### Requirements

`yt-dlp` on `PATH`. No npm dependencies. The VTT parsing is a pure exported
function (`parseVtt`), tested without the network. Tests:
`bun test scripts/CaptureVideo.test.ts` (a fake `yt-dlp` in
`scripts/fixtures/` stands in for the real one).

## AdjudicateSuspects.py

Imports the vendored `check_evidence.py` (it does not re-parse its output) and, for every quote, date and figure the checker flags on a page, re-tests it against the page's linked raws with PDF page furniture (and the `<!-- t=MM:SS -->` / `<!-- t=H:MM:SS -->` time markers `CaptureVideo.ts` writes) and hyphen/em-dash line-wraps normalized out (joined between any two letters or digits, but never digit-to-digit, so a wrapped date such as `2019-` / `10` stays a REAL MISMATCH rather than risk inventing one).

The furniture stripped is: `<!-- page N -->` markers, the `---` page-break rule, `Page N of M`, the time markers, and two pdftotext shapes that are both anchored to a page break so that real content is never taken for furniture. A running header is a line holding exactly `Chapter <n>. <Title Case words>` (small joiner words such as "and" and "of" allowed after the first word) directly after a page marker; the same text mid-page, a header with extra words after the title, a bare `Chapter 3` opener, and a sentence that mentions "Chapter 3" inline are all kept. A bare page number is a line holding only 1 to 3 digits or a lowercase roman numeral directly before a `---` page break and its page marker; the same digits mid-text (a footnote marker, a table cell), four-digit numbers, uppercase numerals and anything with other characters are kept. A hyphen wrap across a blank line (`coat-` / blank / `ings`, as `pdftotext -layout` emits between every line) is joined like a single-line wrap. Because the text cannot say whether a wrapped hyphen was a typesetting hyphen or part of a compound, each wrap is read both ways: hyphen kept (`high-energy`) and, between two letters only, hyphen dropped (`ferrofluid`). Digit-digit and letter-digit wraps never lose the hyphen. Em-dash wraps keep the dash.

A hyphenated year range is a second tokenizer defect: the checker's date pattern is `YYYY-MM`, so `2021-2023` on a page is read as the date `2021-20` (and `23` is too short to count as a number, so the second year is never checked). A date suspect that is the truncation of a `YYYY-YYYY` range written on the page is replaced by the two full years, each re-tested on its own as a number against the raw text (furniture-stripped readings included): FALSE-POSITIVE (year range; both years verbatim in raw) when both are there, REAL MISMATCH when either is absent. It applies only when every place the page holds the token is such a range; a bare `2021-20` stays under the ordinary verdict. An en-dash range (`2021–2023`) already tokenizes as two numbers and needs no rule.

One more downgrade covers a defect in the checker's number tokenizer: it backtracks when a figure is glued to a letter, so `0.84A` is extracted as the phantom figure `0.8` (the checker finds `0.84` followed by a letter, gives up a digit, and accepts `0.8` followed by the digit 4). A number suspect is cleared as FALSE-POSITIVE (truncated unit figure) only when every place the page holds that figure is the leading part of a longer number glued to letters, and that full token (`0.84A`) is in the raw, matched on the checker's number boundaries. It never clears a bare figure on the page (a separate `0.8` stays REAL), a longer token the raw does not contain (`0.85A`, `0.84Amps`), or a figure whose left boundary fails (`0.84A` against a raw `10.84A`). It uses the checker's own rules: the same Raw-link resolution (a link that escapes `raw/` or does not resolve is an evidence error), the raw body with its metadata header removed (collection dates are never evidence), and boundary-safe matching (`4,000` does not match inside `14,000`). Dates are re-tested like everything else. Only the `created:` / `updated:` date lines of a valid frontmatter block are ignored; claims anywhere else in a page, frontmatter included, stay subject to the gate.

Two corrections to the checker's text handling, both applied before candidates are extracted:

- **Inch marks.** The checker pairs every straight `"` in a paragraph as quote delimiters, so `16" x 12" x 12"` shifts the pairing for the rest of the paragraph: the next real quote is lost or mis-paired, and a fabricated quote after it can pass with exit 0 (reproduced before the fix). A `"` is read as an inch mark when it is part of a dimension chain (a number, `"`, then one or more `x`, `×` or `by` and another number, each with an optional `"`: `16" x 12" x 12"`, `16.5" x 12`, `3/4" by 2"`), or when it directly follows a digit while no quote is open (`a 16" tower`; an opening quote never follows a digit). A `"` after a digit while a quote is open and no chain follows stays a closing quote (`"up to 80"`). Inch marks are masked for extraction and restored in each candidate, so a quote that holds a dimension is still compared character for character with the raw. Inline code spans are skipped, and the open/closed state resets at every blank line and blockquote line. The `` `16" x 12" x 12"` `` code-span workaround still works but is no longer needed. Known limit: `"... 16" x 12"` where the last `"` is meant as the closing quote is read as an inch mark.
- **Images.** The checker keeps a markdown image's alt text as page text, so numbers and quotes in it are judged as claims, and a stray `"` in it shifts the pairing. Candidates are taken from the page with every markdown image removed (`![alt](path "title")` and the link around a linked thumbnail `[![alt](path)](https://source)`; single-line only). A candidate that exists only because of image syntax and is not in the raw is listed as FALSE-POSITIVE (image alt text or media path), so it stays visible in the output. A number the prose also states is still a claim. The consequence: alt text is not checked, so keep figures and quotes out of it.

Each suspect is FALSE-POSITIVE (present once furniture is stripped) or REAL MISMATCH (fix the wiki page). It adds no kind of check of its own: it downgrades suspects the checker found, and the one place it can surface a suspect the checker missed is a quote that the checker's mis-paired quotes (an inch mark) had hidden, now paired correctly.

Exit status: 0 only when `REAL MISMATCHES` and `EVIDENCE ERRORS` are both 0, otherwise 1. Usage: `python3 scripts/AdjudicateSuspects.py [project-root]` (default: this repository; works from any directory). Needs Python 3.10+. Raw files should carry a `# ` title: a raw file without one has its `Collected:` line treated as body text. `ExtractPdf.ts` always writes a title.

Tests: `python3 scripts/test_adjudicate.py`.
