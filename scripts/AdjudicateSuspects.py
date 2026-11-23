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
inside "14,000"). It adds no kind of check of its own: it downgrades suspects the
checker found. The one place it can surface a suspect the checker missed is a
quote the checker's mis-paired quotes (an inch mark) had hidden, now paired correctly. The one thing it ignores outright is the
`created:` / `updated:` date lines of a valid frontmatter block (bookkeeping,
not claims); nothing else is exempt. Beyond that it clears a suspect only when
the raw, with furniture and hyphen/em-dash line-wraps normalized, really
contains it. A wrap is joined between any two letters or digits except
digit-to-digit, which is the one join that could manufacture a date or figure.
Each wrap is read both ways, hyphen kept ("high-energy") and, letter to letter
only, hyphen dropped ("ferrofluid"), because the text cannot say which it was.

Furniture stripped, beyond the page and time markers: running headers
(`Chapter <n>. <Title Case words>` alone on a line directly after a page marker)
and bare page numbers (1-3 digits or a roman numeral alone on a line directly
before a page break). Both are anchored to a page break so that a footnote
marker or a table cell is never mistaken for furniture.

One further downgrade: the checker's number tokenizer backtracks, so "0.84A"
yields the phantom figure "0.8". A number suspect is cleared when every place
the page holds it is the leading part of a longer number glued to letters and
that full token ("0.84A") is verbatim in the raw. A bare "0.8" on the page, or
a longer token the raw does not contain, stays a REAL MISMATCH.

One further downgrade: the checker reads a hyphenated year range "2021-2023" as the date "2021-20" and never checks
the second year. A date suspect that is the truncation of a YYYY-YYYY range written on the page is replaced by the two
full years, each re-tested as a number against the raw; it is cleared only when both are verbatim there (an en dash range
needs nothing, the checker already splits it into two numbers).

One further correction, to the checker's quote pairing: it pairs every straight `"` in a paragraph, so an inch
mark (16" x 12" x 12") shifts the pairing for the rest of the paragraph. Quotes after it are mis-paired and a
fabricated quote can pass unseen. Before candidates are extracted, a `"` that is an inch mark is masked (see
mask_inch_marks) and unmasked again in each candidate, so a quote that holds a dimension is still compared
character for character with the raw.

Image syntax is furniture too. The checker keeps a markdown image's alt text as page text, so numbers and quotes in
alt text (and a stray quote that shifts the quote pairing) would be judged as claims. Candidates are taken from the
page with every markdown image removed (`![alt](path "title")`, and the link around a linked thumbnail
`[![alt](path)](https://source)`); a candidate that exists only because of image syntax and is not in the raw is listed
as FALSE-POSITIVE (image alt text or media path), so it stays visible. A number that the prose also states is still a
claim. Alt text is therefore not checked: keep figures and quotes out of it.

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
    r"<!-- t=\d+:\d{2}(?::\d{2})? -->",  # CaptureVideo.ts time markers: MM:SS, or H:MM:SS from one hour (keep)
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


# pdftotext layout furniture. Both shapes are anchored to a page break, because that is what makes them furniture
# rather than content. Checked against a real extracted thesis: all 56 `Chapter N. Title` lines directly
# follow a page marker, and 76 bare page numbers directly precede a page break; the 7 other bare-digit lines are
# footnote markers inside the running text and are left alone.
_ROMAN = r"(?=[ivxlcdm])m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})"
# A line holding only 1-3 digits or a lowercase roman numeral, directly before a "---" page break and its page marker.
PAGE_NUMBER_RE = re.compile(
    rf"^[ \t]*(?:\d{{1,3}}|{_ROMAN})[ \t]*\n(?=(?:[ \t]*\n)*---[ \t]*\n(?:[ \t]*\n)*<!-- page \d+ -->)",
    re.M,
)
# A running header, `Chapter <n>. <Title Case words>` alone on its line, directly after a page marker.
_TITLE_WORD = r"[A-Z][A-Za-z]*"
_TITLE_JOINER = r"(?:and|of|the|for|in|on|to|a|an)"
RUNNING_HEADER_RE = re.compile(
    rf"(<!-- page \d+ -->[ \t]*\n(?:[ \t]*\n)*)[ \t]*Chapter [0-9]+\.[ \t]+{_TITLE_WORD}"
    rf"(?:[ \t]+(?:{_TITLE_WORD}|{_TITLE_JOINER}))*[ \t]*$",
    re.M,
)


def strip_furniture(text: str, drop_hyphen: bool = False) -> str:
    """Raw text with page furniture and line-wraps normalized out.

    drop_hyphen=False keeps the hyphen of a wrap ("problem-\\nsolving" -> "problem-solving", a real compound);
    drop_hyphen=True removes it between two letters ("fer-\\nrofluid" -> "ferrofluid", a typesetting hyphen).
    The text cannot say which a wrap is, so a suspect is tested against both readings."""
    # Furniture that is anchored to a page marker goes first, while the markers are still there.
    text = PAGE_NUMBER_RE.sub("", text)
    text = RUNNING_HEADER_RE.sub(r"\1", text)
    for pat in FURNITURE_PATTERNS:
        text = re.sub(pat, " ", text)
    text = re.sub(r"^---$", " ", text, flags=re.M)
    # Join a hyphen or em-dash line-wrap: "problem-\nsolving" -> "problem-solving", "COVID-\n19" -> "COVID-19",
    # "café-\nrestaurant" -> "café-restaurant" (any Unicode letter or digit). The one exception: never join
    # a digit to a digit, because that is the only join that can manufacture a date or figure the raw never
    # states ("2019-\n10" -> "2019-10"). A genuine wrapped date therefore stays a REAL MISMATCH: fail safe.
    text = re.sub(r"([^\W_])-[ \t]*\n[ \t]*([^\W_])", _join_wrap("-", drop_hyphen), text)
    text = re.sub(r"([^\W_])—[ \t]*\n[ \t]*([^\W_])", _join_wrap("—"), text)
    text = re.sub(r"\s+", " ", text)
    # Also collapse the "word- word" wrap artifact inside already-flattened text (same digit-digit exception).
    # Whitespace collapse has already turned a blank-line gap into a single space, so this is also what joins
    # a wrap across a blank line ("coat-\n\nings"), which pdftotext -layout emits between every line.
    text = re.sub(r"([^\W_])- ([^\W_])", _join_wrap("-", drop_hyphen), text)
    text = re.sub(r"([^\W_])— ([^\W_])", _join_wrap("—"), text)
    return text


def _join_wrap(dash: str, drop: bool = False):
    def join(m: re.Match) -> str:
        left, right = m.group(1), m.group(2)
        if left.isdigit() and right.isdigit():
            return m.group(0)  # leave a digit-digit wrap alone
        if drop and left.isalpha() and right.isalpha():
            return f"{left}{right}"  # letter to letter only: never a digit on either side
        return f"{left}{dash}{right}"
    return join


def raw_body_stripped(path: Path) -> list[str]:
    """Raw body (metadata header removed, as the checker does) with furniture stripped, once per hyphen reading."""
    document = ce.parse_document(path.read_text(encoding="utf-8"))
    body = "\n".join(document.body)
    return [strip_furniture(body), strip_furniture(body, drop_hyphen=True)]


# The checker's number tokenizer backtracks: in "0.84A" the full figure is followed by a letter, so it gives up
# one digit and emits "0.8" (followed by the digit 4). That phantom is never in the raw, which says "0.84A".
# A suspect number is cleared here only when EVERY place the page holds it is such a truncation, i.e. the number
# is the leading part of a longer number glued to letters, and that full number-with-unit token is in the raw.
NUMBER_UNIT_RE = re.compile(r"(\d+(?:,\d{3})*(?:\.\d+)*)([A-Za-z]+)")
STANDS_ALONE_RE = re.compile(r"[A-Za-z0-9]|[.,]\d|%")  # the checker's right-hand guard: any of these = not alone


def is_truncated_unit_figure(value: str, page_text: str, raws: list[str]) -> bool:
    found = False
    for m in re.finditer(r"(?<![\d.,])" + re.escape(value), page_text):
        if not STANDS_ALONE_RE.match(page_text[m.end():m.end() + 2]):
            return False  # the page states the bare figure: that is the claim, and the raw lacks it
        full = NUMBER_UNIT_RE.match(page_text, m.start())
        if not full or len(full.group(1)) <= len(value):
            return False  # not the leading part of a longer number-with-unit (e.g. "3.5" inside "13.5")
        token = full.group(0)
        pattern = r"(?<![\d.,])" + re.escape(token) + r"(?![A-Za-z0-9]|[.,]\d)"
        if not any(re.search(pattern, raw) for raw in raws):
            return False  # the longer token is not in the raw either: truly absent
        found = True
    return found


# Year ranges. The checker's date pattern is `\d{4}-\d{2}`, so a hyphenated range "2021-2023" is read as the date
# "2021-20" (the trailing "23" is then too short to count as a number) and the second year is never checked at all.
# That phantom is never in the raw. A date suspect that is the 7-character truncation of a YYYY-YYYY range written on
# the page is therefore replaced by its two full years, each re-checked on its own as a number against the raw. (An en
# dash range "2021–2023" already tokenizes as the two numbers, so it needs nothing.) The suspect is cleared only when
# EVERY place the page holds the token is such a range and BOTH years stand verbatim in the raw; a year the raw lacks
# keeps it a REAL MISMATCH, and a bare "2021-20" on the page, not part of a range, is left to the ordinary verdict.
YEAR_RANGE_RE = re.compile(r"(?<![\d.,])(\d{4})-(\d{4})(?!\d)")


def year_range_years(value: str, page_text: str) -> list[str] | None:
    """The years of every YYYY-YYYY range on the page that `value` (a "YYYY-YY" date token) is the truncation of,
    or None when the token is not a pure range truncation (it also occurs outside a range, or in none)."""
    if not re.fullmatch(r"\d{4}-\d{2}", value):
        return None
    holds = [m for m in re.finditer(r"(?<![\d.,])" + re.escape(value), page_text)]
    if not holds:
        return None
    years: list[str] = []
    for hold in holds:
        rng = YEAR_RANGE_RE.match(page_text, hold.start())
        if not rng or f"{rng.group(1)}-{rng.group(2)[:2]}" != value:
            return None  # this occurrence is not a range truncation: not furniture, leave it to the ordinary verdict
        years.extend(rng.groups())
    return years


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


# Inch marks. The checker pairs every straight `"` in a paragraph, so `16" x 12" x 12"` is read as quote delimiters and
# the pairing for the rest of the paragraph shifts: a real quote after it is lost or mis-paired, and a fabricated one
# can pass. A `"` is an inch mark in two cases:
#   - it is part of a dimension chain: a number, `"`, then one or more `x` / `×` / `by` and another number (each with an
#     optional `"`), e.g. `16" x 12" x 12"`, `16.5" x 12`, `3/4" by 2"`;
#   - it directly follows a digit while no quote is open (an opening quote never follows a digit), e.g. `a 16" tower`.
# A `"` that follows a digit while a quote is open, and is not in a chain, stays a closing quote ("up to 80").
# Inline code spans are skipped (the checker strips them too). The open/closed state resets at every blank line.
INCH_PLACEHOLDER = ""
_NUM = r"\d+(?:[.,/]\d+)*"
INCH_TOKEN_RE = re.compile(
    r"(?P<code>`[^`\n]*`)"
    rf"|(?P<chain>(?<![\w.,/]){_NUM}\"(?:[ \t]*(?:[x×]|by)[ \t]*{_NUM}\"?)+)"
    r"|(?P<quote>\")"
)


def mask_inch_marks(text: str) -> str:
    """Replace each `"` that is an inch mark with INCH_PLACEHOLDER; every other character is untouched."""
    out_lines = []
    is_open = False
    prev_bq = False
    for line in text.split("\n"):
        bq = line.lstrip().startswith(">")
        if bq != prev_bq:
            is_open = False  # the checker pairs quotes per paragraph, never across a blockquote line
        prev_bq = bq
        if not line.strip():
            is_open = False
            out_lines.append(line)
            continue
        out, pos = [], 0
        for m in INCH_TOKEN_RE.finditer(line):
            out.append(line[pos:m.start()])
            pos = m.end()
            if m.group("code"):
                out.append(m.group(0))
            elif m.group("chain"):
                out.append(m.group(0).replace('"', INCH_PLACEHOLDER))
            elif not is_open and m.start() > 0 and line[m.start() - 1].isdigit():
                out.append(INCH_PLACEHOLDER)  # a bare digit-then-quote with no quote open
            else:
                is_open = not is_open
                out.append('"')
        out.append(line[pos:])
        out_lines.append("".join(out))
    return "\n".join(out_lines)


# Markdown images, plain (`![alt](path "title")`) and linked thumbnails (`[![alt](path)](https://source)`). Single-line
# only, like a linked thumbnail. The alt text, the media path and the outer link are not claims.
LINKED_IMAGE_RE = re.compile(r"\[[ \t]*!\[[^\]\n]*\]\([^)\n]*\)[ \t]*\]\([^)\n]*\)")
IMAGE_RE = re.compile(r"!\[[^\]\n]*\]\([^)\n]*\)")


def strip_images(text: str) -> str:
    """The text with every markdown image, and the link wrapped around a linked thumbnail, removed."""
    return IMAGE_RE.sub("", LINKED_IMAGE_RE.sub("", text))


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
                stripped.extend(raw_body_stripped(target))
            except (OSError, UnicodeDecodeError) as exc:
                errors.append(f"unreadable raw {link}: {exc}")

    results = []
    if plain:
        claims = drop_frontmatter_dates(text)
        page_text = ce.strip_noise(claims)  # what the checker tokenizes: inline code and link syntax removed

        def candidates_of(body: str) -> list:
            return [
                ce.Candidate(c.kind, ce.normalize(c.value.replace(INCH_PLACEHOLDER, '"')))
                for c in ce.extract_candidates(mask_inch_marks(body))
            ]

        # Image syntax is furniture, not prose: the checker keeps a markdown image's alt text (and a stray quote in
        # it shifts the quote pairing), so numbers and quotes in alt text would be judged as claims. Candidates are
        # taken from the page with every image removed. Anything the checker would have flagged only because of
        # image syntax is listed below as a FALSE-POSITIVE, so it stays visible in the output.
        prose = candidates_of(strip_images(claims))
        prose_set = set(prose)
        image_only = [c for c in candidates_of(claims) if c not in prose_set and c.value]
        for cand in image_only:
            if not any(ce.contains(raw, cand) for raw in plain):
                results.append(("FALSE-POSITIVE (image alt text or media path, not page prose)", cand.value))
        for cand in prose:
            if not cand.value:
                results.append(("REAL MISMATCH", cand.value))
            elif any(ce.contains(raw, cand) for raw in plain):
                continue  # not a suspect at all: the checker is satisfied
            elif any(ce.contains(raw, cand) for raw in stripped):
                results.append(("FALSE-POSITIVE (verbatim in stripped raw)", cand.value))
            elif cand.kind == "number" and is_truncated_unit_figure(cand.value, page_text, plain + stripped):
                results.append(("FALSE-POSITIVE (truncated unit figure; full token verbatim in raw)", cand.value))
            elif cand.kind == "date" and (years := year_range_years(cand.value, page_text)) is not None:
                # Re-check the full years one by one, against the same texts as any other figure.
                if all(any(ce.contains(raw, ce.Candidate("number", y)) for raw in plain + stripped) for y in years):
                    results.append(("FALSE-POSITIVE (year range; both years verbatim in raw)", cand.value))
                else:
                    results.append(("REAL MISMATCH", cand.value))
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
