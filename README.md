# Verbatim

**A method template, built on an Agent Skill, for LLM-maintained wikis that can't misquote your sources.** Drop documents into `raw/`, tell the agent to ingest, and it writes an interlinked wiki where every checked quote, date, and figure is mechanically verified to exist verbatim in a linked source. ("Checked" has a stated boundary: see [Where The Invariant Doesn't Reach](#where-the-invariant-doesnt-reach).)

> Every LLM knowledge tool claims to cite its sources. This one greps the source and exits non-zero when a quote drifts — deterministic verification, not a model grading its own homework.

```
ingest raw/course-m1/2026-04-12-platform-strategy.md
```

This repo is the **method template**: clone it, customize the schema, drop in your corpus, ingest. It contains no domain content — instances built with it live in their own repos.

## Why This Exists

The [grounding invariant](#lineage) — every load-bearing fact in the wiki exists verbatim in a linked raw file — is not mine. [Astro-Han/karpathy-llm-wiki](https://github.com/Astro-Han/karpathy-llm-wiki) defined it and wrote `check_evidence.py` to enforce it. It works, and on clean markdown at modest scale it works well.

Verbatim is what that invariant becomes after 116 sources of slide decks.

Two things break when you scale it. **The checker's false positives drown the real defects** — its text normalization collapses whitespace and nothing else, so `pdftotext` output produces a firehose of phantom failures from page furniture and hyphenated line-wraps. A gate that cries wolf trains you to skim it, and the one true defect hides in the noise. And **PDFs aren't greppable** — the invariant presumes raw text is what the author typed, but decks become text through a lossy step that mangles quotes and silently drops figures entirely.

So Verbatim adds an adjudication layer and a first-class extraction stage, and — the part that matters most — an honest boundary around where the invariant *cannot* reach.

## How LLMs Actually Break Quotes

This is the field data, gathered by running the pattern hard enough to find its edges. Every item is a failure observed in production, not a hypothetical:

- **Ellipsis-splicing** — joining two non-adjacent sentences into one quoted span. Reads fine. Isn't what anyone said.
- **Apostrophe and case drift** — sources vary between straight `'` and curly `’`, sometimes within one corpus. The model normalizes silently and the quote stops matching its own source.
- **Invented complementary figures** — the source says 80%, the wiki writes 20% for the remainder. Arithmetically true, textually fabricated, and unverifiable by construction.
- **Cross-source leakage** — a figure from source A appearing on a page whose Raw field links only source B, where nothing can confirm it.
- **Page-break quoting** — spans crossing PDF page furniture, which defeats verification even when the quote is honest.
- **Editorial creep** — brackets, added punctuation, re-capitalization inside quotation marks.

`CLAUDE.md` names each one as a rule. The vendored `check_evidence.py` flags the ones that surface as quotes, dates, or figures that are not in the source, and `AdjudicateSuspects.py` separates its extraction-artifact false positives from the real defects. The terminal condition is `REAL MISMATCHES: 0` and `EVIDENCE ERRORS: 0`, and the script's exit status says so — a gate, not a report.

## What's In The Box

- **`.claude/skills/karpathy-llm-wiki/`** — the vendored operations engine (Astro-Han, MIT, unmodified): ingest / query / lint, triage dispositions, cascade updates, Disputed/Outdated status blocks, and the grounding invariant verified by `check_evidence.py`.
- **`scripts/AdjudicateSuspects.py`** — the adjudication layer. Re-tests every suspect against furniture-stripped, wrap-joined raw text and splits the output into FALSE-POSITIVE (extraction artifact — leave it) versus REAL MISMATCH (fix the quote). This is what makes the gate survive its own results.
- **`scripts/ExtractPdf.ts`** — PDF → greppable raw markdown via pdftotext (Bun, zero dependencies): per-page markers for slide-level citation, PDF-metadata title/date pickup, idempotency, collision protection, an OCR-needed guard for image-only decks.
- **`CLAUDE.md`** — the schema template: page types (concepts / entities / summaries / syntheses, grafted from tonbistudio), frontmatter, tag-taxonomy scaffold, confidence levels, PDF corpus rules, quote discipline, extraction-product flow. Customize the marked sections for your domain.
- **`wiki/`**, **`raw/`**, **`presentations/`** — empty skeleton, ready for a corpus.

## The Method

1. **Customize `CLAUDE.md`** — domain purpose, tag taxonomy, extraction products, granularity policy. This file governs every future ingest; an hour here compounds across every page the wiki ever writes.
2. **Extract** — `bun scripts/ExtractPdf.ts <pdfs> --topic <stream>`. Originals stay immutable beside their extracted text; the article's Raw field always points at the extracted `.md`, never the binary. Evidence checking greps text — a PDF cannot be verified.
3. **Ingest** — in Claude Code: `ingest raw/<topic>/<file>.md`. Pilot ONE representative source first, review the pages it produces, tune the schema, then batch the rest. Sequential compilation only — index, log, and concept pages are shared state.
4. **Verify every batch** — `python3 scripts/AdjudicateSuspects.py` until `REAL MISMATCHES: 0` and `EVIDENCE ERRORS: 0` (it exits 0 only then). Customize its furniture patterns for your corpus's page format.
5. **Query and synthesize** — answers cite pages; durable answers become synthesis pages; extraction products (decks, plans, reports) are built as syntheses first and exported to `presentations/` last, so anything you teach traces back to a source.

## Where The Invariant Doesn't Reach

Stated plainly, because a verification tool that oversells its coverage is worse than none:

- **Slide decks extract sparsely.** Figures, charts, and diagrams lose their meaning in extraction. A claim resting on a chart caps the page at `confidence: medium` or lower, and the prose must say the specifics come from a figure absent from the extracted text.
- **Verification covers literals, not reasoning.** Numbers, dates, and quotes are checked. Whether the page's argument is *sound* is not — that remains a human judgment.
- **Image-only PDFs are rejected, not guessed at.** A deck that yields under 100 characters of text is refused, adds nothing to `raw/`, and the error tells you to run OCR first. A scanned deck with a text footer on every page can slip past that threshold, so skim the first extraction of any scan.
- **Only some literals are checked, and only in some places.** The checker verifies quotes of 15+ characters, ISO dates, and figures that are comma-grouped, decimal, suffixed (K/M/B/%), or four or more digits. A currency symbol is ignored, so `$4.5M` is checked as `4.5M`, and a leading sign is ignored, so `-40%` passes against `40%`. A figure attached to letters is not checked as itself: a unit or lowercase suffix such as `2.5mg`, `3.5x`, `$4.5m`, `$10bn` or `1,200kg` can be wrong and pass (the checker may test only a leading digit run, such as the `1200` in `1200.5mg`, which an unrelated `1200` in the raw would satisfy). An unbalanced double quote in a paragraph (an inch mark, say) mis-pairs the quote spans after it, so a quote there can go unchecked. Small plain integers, spelled-out dates and single-quoted text are not checked either. It also never reads: `> **Status:` blocks (so competing figures in a Disputed block are unchecked), pages with an `> Archived:` header, inline code and fenced code (an unclosed fence hides the rest of the page), the Source/Sources/Raw/Collected/Published/Updated/Archived header lines, link targets, and `index.md` and `log.md`. A quote that is a verbatim fragment of a longer sentence passes even when cutting the rest reverses its meaning. The literal boundary is the "Coverage boundary" docstring at the top of the vendored `check_evidence.py`; the regions above are in its `extract_candidates` and `check_article` functions.

## Operational Lessons

Learned across a 116-source production run, encoded in the schema and scripts:

- Verification runs per-source during ingest, not once at the end — a defect caught at source one is cheap; at source eight it's an archaeology dig.
- Multi-part talks get one combined summary; module-closing recaps get a "No material" log entry rather than a forced thin page; every corpus source ends with a log entry, so silent truncation is detectable.
- Agent batches need a completeness gate (every assigned raw appears in the log) and an independent verification gate before commit.
- Never hand-edit extracted text to make a claim verify. That inverts the invariant and is the one unforgivable move.

## Requirements

- [Claude Code](https://claude.ai/code) (or any Agent Skills-compatible tool) for the engine
- [Bun](https://bun.sh) + `pdftotext` (poppler-utils) for extraction
- Python 3.10 or newer for verification (macOS ships an older `python3`; install a current one)

To check your install, run `python3 scripts/run_tests.py` (the vendored engine's test suite), `python3 scripts/test_adjudicate.py`, `bun test scripts/`, and `python3 scripts/AdjudicateSuspects.py`. On the empty skeleton the last prints `REAL MISMATCHES: 0` and exits 0. Without `pdftotext` installed, `bun test` prints a SKIPPED warning and still exits 0: that is not a pass, so install poppler-utils first.

## Lineage

Verbatim is a derivative work and says so. See [ATTRIBUTION.md](./ATTRIBUTION.md) for full credit and license texts:

- **Andrej Karpathy** — the llm-wiki pattern: three layers, three operations.
- **[Astro-Han/karpathy-llm-wiki](https://github.com/Astro-Han/karpathy-llm-wiki)** (MIT) — the operations engine and the grounding invariant itself, vendored unmodified.
- **[tonbistudio/llm-wiki](https://github.com/tonbistudio/llm-wiki)** (MIT) — the page-type taxonomy.

What's added here: the adjudication layer, the PDF corpus pipeline, the quote-failure taxonomy, and the stated limits above.
