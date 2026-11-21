# Designing Your Schema

The schema is `CLAUDE.md` in the repo root. Claude Code reads it before every ingest, so it decides what kind of wiki gets built. Spend an hour here before you ingest anything: the choices compound across every page the wiki ever writes.

The file ships as a working template. Search it for `CUSTOMIZE` to find the five places that are yours to fill in. Everything else is the structure and quote discipline that make verification work; leave it alone unless you know why.

## The five places to customize

1. **Purpose** (top of the file). One paragraph: your domain, your corpus, and what the wiki feeds (a teaching deck, a plan, a report).
2. **Raw streams** (`## Directory Layout` → `raw/ organization`). Name the streams your sources come from, for example `raw/course-m1/`, `raw/research/`, `raw/vendor/`. Streams describe where a source came from, never what kind of page it becomes.
3. **Domain-fit section** (`## Required Sections by Page Type` → Concept). An optional extra section such as `## Higher-Ed Fit`, to be used only when a source supports it.
4. **Tag taxonomy** (`## Tag Taxonomy`). Design 4-6 categories with 3-8 tags each. Pages carry 3-6 tags, and a new tag must be added to this file in the same change, so the vocabulary stays controlled.
5. **Extraction products** (`## Extraction Products`). Name the outputs you derive from the wiki (decks, plans, reports). They are built as synthesis pages first and exported to `presentations/` last, so anything you teach traces back to a source.

## The four page types

Every page lives in exactly one folder under `wiki/`. The rule of thumb from the schema:

- **Concept** (`wiki/concepts/`): a framework, method or pattern that generalizes across contexts.
- **Entity** (`wiki/entities/`): a named, specific thing such as a tool, vendor, organization or person.
- **Summary** (`wiki/summaries/`): exactly one page per raw source.
- **Synthesis** (`wiki/syntheses/`): cross-cutting work that spans sources or pages, such as comparisons and decision frameworks.

Each type has required sections (for example, a summary has Key Points, Evidence Presented, Concepts and Entities Introduced, Open Questions). They are listed in `CLAUDE.md` under `## Required Sections by Page Type`.

## Confidence levels

Each page carries `confidence: high | medium | low` for the page as a whole. A page whose claims lean on a chart or diagram that did not extract as text is capped at `medium`. The full definitions are in `CLAUDE.md`.

## What the schema does not change

Quote discipline and the standing rules are what the checker enforces: quotes are character-exact from the raw file, no figure appears that the source does not state, and nothing in `raw/` is ever edited. Changing your domain does not change these. See [How LLMs Actually Break Quotes](how-llms-break-quotes.md) for why each rule exists.
