# [Your Domain] Knowledge Base — Schema (Verbatim method)

## Purpose

<!-- CUSTOMIZE: one paragraph on your knowledge domain, your corpus, and the outputs this wiki feeds. -->
<!-- Example: "enterprise AI adoption, built from an executive course's PDFs and transcripts, feeding teaching material and an annual adoption plan." -->
This is an LLM-maintained knowledge base on [YOUR DOMAIN] following Karpathy's llm-wiki pattern: the LLM writes and maintains everything under `wiki/`, the human curates sources into `raw/` and asks questions. The engine is the vendored `karpathy-llm-wiki` Agent Skill at `.claude/skills/karpathy-llm-wiki/`; the page-type taxonomy is grafted from the tonbistudio llm-wiki template. The corpus is [YOUR SOURCES]. The compounding outputs are [YOUR EXTRACTION PRODUCTS].

## Authority

`.claude/skills/karpathy-llm-wiki/SKILL.md` governs all operations: ingest, triage dispositions, compile, cascade updates, query, archiving, lint, the grounding invariant, and the `index.md` / `log.md` formats. Read it before any operation. This file adds domain conventions on top and must never contradict it.

Precedence: **SKILL.md wins on mechanics** (file formats, metadata header fields, link resolution, log and index entry shapes, what lint does). **CLAUDE.md wins on domain taxonomy** (which directory a page goes in, page types, tags, confidence, required sections, PDF handling). If a rule here appears to override a mechanic, it is a defect in this file — follow SKILL.md and report the conflict.

## Directory Layout

- `raw/` — Immutable source material. Never modify, never delete. One level of topic subdirectories.
- `wiki/` — Compiled articles. One level of subdirectories, and those directories are the **page types** below.
- `wiki/index.md` — Global index (SKILL.md `references/index-template.md` format). Every page appears here.
- `wiki/log.md` — Append-only operation log (SKILL.md format).
- `presentations/` — Derived material. **Not part of `wiki/`**; never linked as evidence, never indexed, never linted.

### Page-type topic directories

The skill's one-level "topic" directories are page types in this repo. Every article lives in exactly one:

- `wiki/concepts/` — Frameworks, methodologies, patterns, models. Anything transferable across contexts.
- `wiki/entities/` — Named things: tools, vendors, platforms, models, organizations, institutions, people, specific technologies.
- `wiki/summaries/` — Exactly one page per raw source. Per-lecture, per-deck, per-reading. Exception: a talk split into multi-part transcripts (Video N Part 1..k) gets ONE combined summary page whose Raw field links every part; never one page per part.
- `wiki/syntheses/` — Cross-cutting work: comparisons, decision frameworks, extraction-product building blocks, and archive pages written from a Query.

Choosing between them: if it is named and specific, it is an entity; if it generalizes, it is a concept; if it tracks one source, it is a summary; if it spans sources or pages, it is a synthesis. When a source introduces both a framework and the vendor that sells it, write both pages and cross-link them.

Granularity policy (choose one and state it here; the fine-grained default is recommended): concept pages may be fine-grained — a distinct, memorable, reusable claim or pattern merits its own page even if thin; merge only true duplicates of an existing page's core thesis. People who contribute substantively to the material — including historical figures invoked by lecturers — merit person entity pages; thin pages compound as later sources land.

### raw/ organization

`raw/` topic directories name the **corpus stream the source came from**, not the page type — do not create `raw/concepts/`. <!-- CUSTOMIZE: name your streams, e.g. raw/course-m1/, raw/research/, raw/vendor/. --> Reuse an existing directory when close enough; create a new one only for a genuinely distinct stream. File naming follows SKILL.md: `raw/<topic>/YYYY-MM-DD-descriptive-slug.md`, kebab-case, max 60 characters, date prefix omitted when the published date is unknown.

## PDF and Deck Corpus Rules

When sources arrive as PDFs or slide decks: two files per source, same directory, same slug:

- `raw/<topic>/<slug>.pdf` — the original binary. Immutable. Never edited, never regenerated in place.
- `raw/<topic>/<slug>.md` — extracted text produced by `scripts/ExtractPdf.ts`. This is the greppable layer the grounding invariant is verified against. It carries the SKILL.md raw metadata header (Source, Collected, Published) and its Source field points at the sibling `.pdf`.

Rules:

1. An article's `> Raw:` field links the **extracted `.md`**, never the `.pdf`. Evidence checking greps text; a binary cannot be verified.
2. Re-extraction replaces `<slug>.md` wholesale from the same PDF. Never hand-edit extracted text to make a claim verify — that inverts the invariant.
3. Slide decks extract sparsely. Figures, charts, diagrams, and speaker-notes-free slides lose meaning in extraction.
4. When a claim rests on something that did not extract cleanly, you may describe it — but set page `confidence: medium` or `low`, and state in the prose that the specifics come from a figure not present in the extracted text.
5. **Never write a number, date, or quote that is not verbatim in the extracted text.** Not from the PDF you can see, not from memory, not reconstructed from a chart. If a figure shows a value and the text does not, describe the direction without the number.

## Page Format

Every article keeps the skill's article structure intact — H1 title, then the blockquote metadata header, then `## Overview`, then body sections, then optional `## See Also` — and **adds** a YAML frontmatter block above the H1.

```markdown
---
type: concept | entity | summary | synthesis
tags: [tag-1, tag-2, ...]
confidence: high | medium | low
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# {Title}

> Sources: {Author or organization, YYYY-MM-DD; ...}
> Raw: [{source}](../../raw/{topic}/{slug}.md)
> Updated: {YYYY-MM-DD}

## Overview
...
```

Frontmatter rules:

- Carry **only** these five fields. Do not duplicate title, Sources, or Raw into frontmatter — the blockquote header is the single source of truth for those, and lint and `check_evidence.py` read it.
- `updated:` must always equal the blockquote `> Updated:` value. The blockquote is authoritative; the frontmatter mirrors it. Both refresh only when knowledge content changes, not on typo or formatting fixes.
- `created:` is set once and never changed.
- Dates are ISO 8601, `YYYY-MM-DD`.
- Archive pages produced by Query use the archive template's `> Archived:` header (Sources link wiki pages, no Raw field) and still carry frontmatter with `type: synthesis`.

**Lint exemption:** frontmatter sits above the H1, so `check_evidence.py` scans its dates as body candidates and will report `created`/`updated` values as fidelity suspects. This is expected noise, not a finding — `scripts/AdjudicateSuspects.py` filters it automatically.

## Required Sections by Page Type

`## Overview` comes first on every page, per the article template. Then:

**Concept** (`wiki/concepts/`)
- `## Definition` — one paragraph, plain English, jargon defined on first use.
- `## How It Works` — mechanics, stages, or structure.
- `## When To Use` — conditions, preconditions, what makes it a fit.
- `## Risks & Pitfalls` — failure modes, limits, what it does not solve.
- <!-- CUSTOMIZE: optional domain-fit section, e.g. "## Higher-Ed Fit" — how the concept lands in your specific context. Include only when a source supports it or the inference is marked as inference. -->

**Entity** (`wiki/entities/`) — things (tools, vendors, platforms, organizations, technologies):
- `## What It Is` — category, who makes or runs it, what it does.
- `## Characteristics` — capabilities, positioning, adoption profile, cost model where sourced.
- `## Adoption Considerations` — what an adopting organization must weigh: integration, data, skills, lock-in, procurement.
- `## Track Record` — optional; documented deployments and outcomes.

**Entity — person variant** (`wiki/entities/`, for people):
- `## Who They Are` — role, affiliation, relationship to the corpus.
- `## Contributions` — the frameworks, claims, and distinctions they contribute, with links to the pages that carry them.
- `## Appears In` — optional; sources where they appear, when not obvious from Raw.
Omit Adoption Considerations and Track Record — they do not apply to people.

**Summary** (`wiki/summaries/`)
- `## Key Points` — the source's main claims, one bullet each.
- `## Evidence Presented` — data, cases, and studies the source offers, with values verbatim from the extracted text.
- `## Concepts and Entities Introduced` — links to the concept and entity pages this source feeds.
- `## Open Questions` — what the source asserts without support, or leaves unresolved.

**Synthesis** (`wiki/syntheses/`)
- `## Question` — what this page resolves.
- `## Comparison` or `## Analysis` — a table for like-for-like comparisons, prose for cross-cutting analysis.
- `## Recommendations` — what to do, and under what conditions. Mark inference explicitly where it goes beyond the sources.
- `## Pages Compared` — relative links to every wiki page the synthesis draws on.

Do **not** add a `## Sources` section. The `> Sources:` and `> Raw:` header fields are the sources, and lint validates them. Do **not** add `## Related Concepts` or `## Related Entities` — all cross-references go in `## See Also`, which lint maintains.

## Linking

- Standard relative markdown links only: `[Page Title](../concepts/some-page.md)`. **Never Obsidian `[[wikilinks]]`** — lint and `check_evidence.py` cannot resolve them.
- Same directory: `[Page](other-page.md)`. Different page type: `[Page](../concepts/other-page.md)`. Raw from an article: `../../raw/<topic>/<slug>.md`.
- In conversation output, cite with project-root-relative paths (`wiki/concepts/page.md`); inside wiki files, always file-relative.
- **No orphans.** Every page links to at least one other page, and every new page gets at least one inbound link added from an existing page in the same change.
- Mentioning a concept, entity, or framework that has a page means linking it on first mention in the body — but never place a markdown link inside a quoted span (link syntax is not in the raw and breaks verbatim matching).

## Tag Taxonomy

<!-- CUSTOMIZE: design 4-6 categories with 3-8 tags each for your domain. Keep the structural axes below; replace the example tags. -->
Tags are lowercase kebab-case and drawn only from the lists below. Use 3–6 tags per page: at least one lifecycle tag, at least one dimension tag, and at least one evidence-kind tag. Exception: person entity pages are exempt from the evidence-kind minimum — a bio is not an evidence claim; tag people `[<lifecycle>, people]` plus whatever else genuinely applies. Introducing a new tag requires adding it to this file in the same change — an untracked tag is a lint finding.

- **Lifecycle / phase** — `tag-1`, `tag-2`, `tag-3` <!-- e.g. awareness, pilot, scaling, governance -->
- **Dimension** — `tag-4`, `tag-5`, `tag-6` <!-- e.g. strategy, people, process, technology, data -->
- **Capability / subject area** — `tag-7`, `tag-8`, `tag-9`
- **Evidence kind** — `framework`, `case-study`, `empirical`, `benchmark`, `opinion`, `anecdote`
- **Audience and use** — `practitioner`, `teaching`, `[your-extraction-product-tag]` <!-- working tags marking pages earmarked for extraction; avoid four-digit years in tags (they become spurious evidence candidates) -->
- **Status and scope** — `foundational`, `emerging`, `speculative`, `contested`

Extraction-product tags are the query surface for your derived outputs — tag generously.

## Confidence Levels

- **high** — Corroborated by two or more independent raw sources, or stated explicitly with supporting data in one authoritative source. Every number, date, and quote verifies verbatim against the linked raw files.
- **medium** — Single-source, or well-supported in substance while some specifics come from sparse deck extraction. Also the ceiling for any page whose claims depend on figures that did not extract.
- **low** — Speculative, a single passing mention, inferred from a chart or diagram rather than text, or extended by inference beyond what the source states.

Confidence describes the page as a whole; downgrade the page when any load-bearing claim is weak. A claim contested between sources gets a `> **Status: Disputed**` block per the article template *and* the `contested` tag. Superseded claims get `> **Status: Outdated**` with its date. Never silently rewrite history.

## Extraction Products

<!-- CUSTOMIZE: name your derived outputs (teaching decks, plans, reports). -->
Derived outputs are **built as synthesis pages first**, then exported. Do not draft them directly in `presentations/`.

1. Assemble the argument as one or more pages in `wiki/syntheses/`, tagged with your extraction-product tags, grounded and linted like any other page.
2. Export derived slides, handouts, and documents into `presentations/`.
3. `presentations/` is downstream and disposable: nothing there is evidence, nothing there is indexed, and nothing in `wiki/` ever links to it. Regenerate from the synthesis pages rather than editing exports and back-porting.

This keeps the grounding invariant covering everything that will be taught or proposed: if a number survives into a deck, it traces to a synthesis page, to a raw extracted `.md`, to a source.

## Quote Discipline (hard-won; follow exactly)

- Quotes are character-exact from the raw — grep each one BEFORE writing. Match case, punctuation, and apostrophe style **per raw file** (files vary between straight `'` and curly `’` — copy the bytes you find; check each file's style before drafting).
- No editorial brackets, added punctuation, re-capitalization, or synonym swaps inside quotation marks — restructure your sentence or paraphrase outside quotes instead.
- No ellipsis-splicing of non-adjacent sentences. Quote one contiguous span, or split into separate exact quotes joined by your own prose. Spoken filler ("you know", ", right?") inside a span stays in the quote.
- Never write a derived or complementary figure the raw does not state (raw says "80%" → do not write "20%" for the remainder; describe it in words).
- A specific figure or quote may only appear on a page whose Raw field links the raw containing it; on other pages, reference the carrying page instead.
- Avoid quoting across PDF page-break markers — page furniture interrupts the span and defeats verification.
- After every ingest, run `python3 scripts/AdjudicateSuspects.py`: it separates extraction-artifact FALSE-POSITIVEs (leave them) from REAL MISMATCHes (fix them). Do not finish an ingest with a nonzero REAL MISMATCH count on your pages.

## Standing Rules

- Never modify or delete anything in `raw/`. Both the `.pdf` and its extracted `.md` are immutable.
- Locate every number, date, and quote in the linked raw file *before* writing it, and write it exactly as found. Derived values show their components.
- Run the Ingest triage before touching `wiki/`, and state the disposition. A thin source that adds nothing gets a **No material** log entry — do not force a page out of it.
- Update `wiki/index.md` and append to `wiki/log.md` on every ingest that writes; log-only on No material. Every raw source in the corpus must end up with a log entry.
- One concept per page. Split a page that outgrows its subject rather than letting it sprawl.
- Prefer merging into an existing page over creating a near-duplicate.
- When uncertain about a claim, set `confidence: low` and say what the uncertainty is in the prose.
- File names are lowercase kebab-case, matching the page title slug, no dates in `wiki/` file names (dates belong to raw file names).
- Concept and entity pages are named for the concept or entity, never for the raw file that introduced it.
