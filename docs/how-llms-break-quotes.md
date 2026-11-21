# How LLMs Actually Break Quotes

This is the field data, gathered by running the pattern hard enough to find its edges. Every item is a failure observed in production, not a hypothetical:

- **Ellipsis-splicing** — joining two non-adjacent sentences into one quoted span. Reads fine. Isn't what anyone said.
- **Apostrophe and case drift** — sources vary between straight `'` and curly `’`, sometimes within one corpus. The model normalizes silently and the quote stops matching its own source.
- **Invented complementary figures** — the source says 80%, the wiki writes 20% for the remainder. Arithmetically true, textually fabricated, and unverifiable by construction.
- **Cross-source leakage** — a figure from source A appearing on a page whose Raw field links only source B, where nothing can confirm it.
- **Page-break quoting** — spans crossing PDF page furniture, which defeats verification even when the quote is honest.
- **Editorial creep** — brackets, added punctuation, re-capitalization inside quotation marks.

`CLAUDE.md` names each one as a rule. The vendored `check_evidence.py` flags the ones that surface as quotes, dates, or figures that are not in the source, and `AdjudicateSuspects.py` separates its extraction-artifact false positives from the real defects. The terminal condition is `REAL MISMATCHES: 0` and `EVIDENCE ERRORS: 0`, and the script's exit status says so — a gate, not a report.
