# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's **private vulnerability reporting**: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for a security problem.

What counts: anything in `scripts/` or the vendored engine that could execute attacker-controlled input, for example a crafted PDF or markdown file that makes `ExtractPdf.ts` or `AdjudicateSuspects.py` run commands, write outside the repository, or read files it should not.

I aim to acknowledge a report within a week. This is a small, volunteer-maintained project, so fixes are best-effort.

## Scope

- In scope: `scripts/` and the repository's own documentation.
- Out of scope: the vendored `karpathy-llm-wiki` skill under `.claude/skills/`. Report issues there to [Astro-Han/karpathy-llm-wiki](https://github.com/Astro-Han/karpathy-llm-wiki), the upstream project.

## What the tools do on your machine

- `ExtractPdf.ts` runs `pdftotext` and `pdfinfo` (poppler-utils) on PDFs you point it at, and writes only under `raw/`.
- `AdjudicateSuspects.py` imports the vendored `check_evidence.py` and reads the wiki pages under the project root you give it (default: this repository) plus the raw files those pages link, which must resolve inside that project's `raw/`.
- Neither tool makes network requests.
