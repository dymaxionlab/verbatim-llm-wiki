# Attribution

Verbatim is built on the foundations and work of:

- **Andrej Karpathy** — the llm-wiki pattern (the original gist idea): three layers (raw/, wiki/, schema), three operations (ingest, query, lint).

- **Astro-Han/karpathy-llm-wiki** (https://github.com/Astro-Han/karpathy-llm-wiki, MIT) — the operational engine, vendored at .claude/skills/karpathy-llm-wiki/ (grounding invariant, check_evidence.py, triage, cascade updates, lint).

- **tonbistudio/llm-wiki** (https://github.com/tonbistudio/llm-wiki, MIT) — the page-type taxonomy grafted into CLAUDE.md (concepts/entities/summaries/syntheses, tags, confidence levels).

## Third-Party Licenses

Both upstream projects are MIT-licensed, and their license texts travel with this repository as MIT requires:

| Project | License text |
|---------|--------------|
| Astro-Han/karpathy-llm-wiki | [.claude/skills/karpathy-llm-wiki/LICENSE](./.claude/skills/karpathy-llm-wiki/LICENSE) |
| tonbistudio/llm-wiki | [LICENSES/tonbistudio-llm-wiki-LICENSE](./LICENSES/tonbistudio-llm-wiki-LICENSE) |

Verbatim's own code and documentation are MIT-licensed under [LICENSE](./LICENSE).

## Scope Of The Contribution

To be precise about what is and isn't original here, since the distinction matters:

**Not original.** The grounding invariant — every number, date, and quote in the wiki exists verbatim in a linked raw source — is Astro-Han's, defined in their `SKILL.md` and enforced by their `check_evidence.py`, vendored here without modification. The page-type taxonomy is tonbistudio's. The three-layer pattern is Karpathy's.

**Original to this repo.** The adjudication layer (`AdjudicateSuspects.py`) that separates extraction artifacts from real quote defects, without which the checker's output is unusable against PDF-derived text. The PDF corpus pipeline (`ExtractPdf.ts`) and the two-file immutable convention, which upstream does not address at all. The quote-failure taxonomy in `CLAUDE.md`, gathered empirically across a 116-source run. The confidence policy tying page confidence to extraction fidelity, and the stated limits of what verification covers.

Verbatim is an independent project. It is not affiliated with or endorsed by Andrej Karpathy, Astro-Han, or tonbistudio.
