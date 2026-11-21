# Why This Exists

The [grounding invariant](../README.md#credits) — every load-bearing fact in the wiki exists verbatim in a linked raw file — is not mine. [Astro-Han/karpathy-llm-wiki](https://github.com/Astro-Han/karpathy-llm-wiki) defined it and wrote `check_evidence.py` to enforce it. It works, and on clean markdown at modest scale it works well.

Verbatim is what that invariant becomes after 116 sources of slide decks.

Two things break when you scale it. **The checker's false positives drown the real defects** — its text normalization collapses whitespace and nothing else, so `pdftotext` output produces a firehose of phantom failures from page furniture and hyphenated line-wraps. A gate that cries wolf trains you to skim it, and the one true defect hides in the noise. And **PDFs aren't greppable** — the invariant presumes raw text is what the author typed, but decks become text through a lossy step that mangles quotes and silently drops figures entirely.

So Verbatim adds an adjudication layer and a first-class extraction stage, and — the part that matters most — an honest boundary around where the invariant *cannot* reach.
