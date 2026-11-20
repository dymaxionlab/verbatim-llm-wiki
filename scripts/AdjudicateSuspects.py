#!/usr/bin/env python3
"""Adjudicate check_evidence fidelity suspects against furniture-stripped raw text.

The vendored checker (check_evidence.py) is deliberately strict: its only text
normalization is whitespace collapse, so text that went through pdftotext
produces phantom suspects from page furniture (headers, footers, page markers)
and hyphen or em-dash line wraps. This script re-tests each suspect against the
same raw text with that furniture removed and sorts it into:

  FALSE-POSITIVE  the quote or figure IS in the raw once furniture is stripped
  REAL MISMATCH   it still is not: fix the wiki page

It reuses the checker's own code (imported, not re-parsed) so the rules cannot
drift: the same Raw-link resolution and containment check, the same
header-stripped raw body (collection dates never count as evidence), and the
same boundary-guarded matching for numbers and dates ("4,000" does not match
inside "14,000"). It only ever downgrades a suspect the checker already found.
It never introduces a new check. The one thing it ignores outright is the
`created:` / `updated:` date lines of a valid frontmatter block (bookkeeping,
not claims); nothing else is exempt. Beyond that it clears a suspect only when
the raw, with furniture and hyphen/em-dash line-wraps normalized, really
contains it. A wrap is joined between any two letters or digits except
digit-to-digit, which is the one join that could manufacture a date or figure.

Evidence errors the checker reports (no Raw field, a Raw link that escapes raw/
or does not resolve) are failures here too.

Exit status: 0 when REAL MISMATCHES and EVIDENCE ERRORS are both zero, else 1.

Usage:  python3 scripts/AdjudicateSuspects.py [project-root]
        (default project root: the repository this script lives in)
"""
import sys

if sys.version_info < (3, 10):
    sys.exit("AdjudicateSuspects.py needs Python 3.10 or newer (the vendored checker uses 3.10 syntax).")

import importlib.util
import re
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CHECKER = REPO / ".claude" / "skills" / "karpathy-llm-wiki" / "scripts" / "check_evidence.py"

# CUSTOMIZE: page-furniture patterns for YOUR corpus: the repeating headers/
# footers pdftotext leaves mid-text (copyright lines, contact footers, site
# URLs, page numbers). Grep a few extracted raws to find yours.
FURNITURE_PATTERNS = [
    r"<!-- page \d+ -->",           # ExtractPdf.ts page markers (keep)
    r"Page \d+ of \d+",            # generic page numbering (keep)
    # r"©\s*\d{4} Example Org",      # example: copyright footer
    # r"example\.org",               # example: site URL header
]


def load_checker():
    spec = importlib.util.spec_from_file_location("check_evidence", CHECKER)
    if spec is None or spec.loader is None:
        sys.exit(f"cannot load the vendored checker at {CHECKER}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["check_evidence"] = module  # dataclasses resolve their module by name
    spec.loader.exec_module(module)
    return module


ce = load_checker()


def strip_furniture(text: str) -> str:
    for pat in FURNITURE_PATTERNS:
        text = re.sub(pat, " ", text)
    text = re.sub(r"^---$", " ", text, flags=re.M)
    # Join a hyphen or em-dash line-wrap: "problem-\nsolving" -> "problem-solving", "COVID-\n19" -> "COVID-19",
    # "café-\nrestaurant" -> "café-restaurant" (any Unicode letter or digit). The one exception: never join
    # a digit to a digit, because that is the only join that can manufacture a date or figure the raw never
    # states ("2019-\n10" -> "2019-10"). A genuine wrapped date therefore stays a REAL MISMATCH: fail safe.
    text = re.sub(r"([^\W_])-[ \t]*\n[ \t]*([^\W_])", _join_wrap("-"), text)
    text = re.sub(r"([^\W_])—[ \t]*\n[ \t]*([^\W_])", _join_wrap("—"), text)
    text = re.sub(r"\s+", " ", text)
    # also collapse the "word- word" wrap artifact inside already-flattened text (same digit-digit exception;
    # note whitespace collapse has already turned any blank-line gap into a single space by this point)
    text = re.sub(r"([^\W_])- ([^\W_])", _join_wrap("-"), text)
    text = re.sub(r"([^\W_])— ([^\W_])", _join_wrap("—"), text)
    return text


def _join_wrap(dash: str):
    def join(m: re.Match) -> str:
        left, right = m.group(1), m.group(2)
        if left.isdigit() and right.isdigit():
            return m.group(0)  # leave a digit-digit wrap alone
        return f"{left}{dash}{right}"
    return join


def raw_body_stripped(path: Path) -> str:
    """Raw body (metadata header removed, as the checker does) with furniture stripped."""
    document = ce.parse_document(path.read_text(encoding="utf-8"))
    return strip_furniture("\n".join(document.body))


# A real frontmatter block: a leading "---", one or more "key: value" lines, a closing "---",
# then the page's "# " title. Anything that does not look exactly like that is NOT frontmatter,
# so a stray "---" rule or an unclosed block can never hide page content from the gate.
FRONTMATTER_RE = re.compile(r"\A---\n((?:[A-Za-z_][\w-]*:[^\n]*\n)+)---\n(?:[ \t]*\n)*# ")
BOOKKEEPING_LINE_RE = re.compile(r"(?:created|updated):[ \t]*\d{4}-\d{2}-\d{2}[ \t]*\n")


def drop_frontmatter_dates(text: str) -> str:
    """Blank only the `created:` / `updated:` date lines of a valid frontmatter block.
    Those dates are bookkeeping noise (CLAUDE.md, Page Format). Every other frontmatter
    line, and all body content, stays subject to the gate."""
    m = FRONTMATTER_RE.match(text)
    if not m:
        return text
    kept = "".join(line for line in m.group(1).splitlines(True) if not BOOKKEEPING_LINE_RE.fullmatch(line))
    return text[: m.start(1)] + kept + text[m.end(1):]


def adjudicate_article(article: Path, root: Path):
    """Return (results, errors) for one article. results: [(verdict, quote)]."""
    try:
        text = article.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [], [f"unreadable article: {exc}"]
    links = ce.raw_links_of(text)
    if not links:
        if any(ce.ARCHIVED_RE.match(line.strip()) for line in ce.parse_document(text).header):
            return [], []
        return [], ["article has no Raw field"]

    raw_root = (root / "raw").resolve()
    plain, stripped, errors = [], [], []
    for link in links:
        target = (article.parent / link).resolve()
        if not target.is_relative_to(raw_root):
            errors.append(f"Raw link escapes raw/: {link}")
        elif not target.is_file():
            errors.append(f"unresolvable Raw link: {link}")
        else:
            try:
                plain.append(ce.source_content(target))
                stripped.append(raw_body_stripped(target))
            except (OSError, UnicodeDecodeError) as exc:
                errors.append(f"unreadable raw {link}: {exc}")

    results = []
    if plain:
        for cand in ce.extract_candidates(drop_frontmatter_dates(text)):
            cand = ce.Candidate(cand.kind, ce.normalize(cand.value))
            if not cand.value:
                results.append(("REAL MISMATCH", cand.value))
            elif any(ce.contains(raw, cand) for raw in plain):
                continue  # not a suspect at all: the checker is satisfied
            elif any(ce.contains(raw, cand) for raw in stripped):
                results.append(("FALSE-POSITIVE (verbatim in stripped raw)", cand.value))
            else:
                results.append(("REAL MISMATCH", cand.value))
    return results, errors


def main(argv: list[str]) -> int:
    root = Path(argv[1]).resolve() if len(argv) > 1 else REPO
    wiki_dir = root / "wiki"
    if not wiki_dir.is_dir():
        print(f"no wiki/ directory under {root}")
        return 1

    rows, all_errors = [], []
    for article in ce.iter_articles(wiki_dir):
        page = article.relative_to(root).as_posix()
        results, errors = adjudicate_article(article, root)
        rows.extend((verdict, page, quote[:90]) for verdict, quote in results)
        all_errors.extend((page, e) for e in errors)

    for verdict, page, quote in sorted(rows):
        print(f"{verdict:45s} {page}\n{'':45s}   \"{quote}\"")
    for page, error in all_errors:
        print(f"EVIDENCE ERROR  {page}: {error}")

    real = [r for r in rows if r[0] == "REAL MISMATCH"]
    print(f"\ntotal suspects adjudicated: {len(rows)}")
    print(f"REAL MISMATCHES: {len(real)}")
    print(f"EVIDENCE ERRORS: {len(all_errors)}")
    return 1 if real or all_errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
