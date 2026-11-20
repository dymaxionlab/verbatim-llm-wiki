# Vendored Skill: karpathy-llm-wiki

- **Upstream repository:** https://github.com/Astro-Han/karpathy-llm-wiki
- **Vendored date:** 2026-07-30
- **Upstream commit:** `eafcc77001e496cc43499e4923b663aec722c813`
- **License:** MIT (see `LICENSE` in this directory)

## What was vendored

- `SKILL.md`
- `references/` (all files)
- `scripts/check_evidence.py`
- `tests/` (all files)
- `LICENSE`

## What was excluded

- `.git` — VCS metadata, not needed in the vendor copy.
- `assets/` — screenshot images, not needed for skill operation.
- `examples/` — demo content, not needed for skill operation. Note: one test in `tests/test_check_evidence.py` (`ExamplesSmokeTest.test_examples_have_zero_suspects`) depends on this directory and will fail/error here as a result — this is expected, not a regression in the vendored code. Run the suite through `python3 scripts/run_tests.py` from the repository root; it runs every other test unmodified and skips only that class.
- `.gitignore` — not applicable to the vendored location.
- `README.md` — upstream project README, not needed for skill operation.

## Local modifications

None. All path references in `SKILL.md` (`references/` relative to the skill file, and `<skill-dir>/scripts/check_evidence.py`) and in `scripts/check_evidence.py` (which takes `project-root` as an explicit argument rather than deriving paths from its own location) already resolve correctly from this vendored location without changes.
