#!/usr/bin/env python3
"""Tests for AdjudicateSuspects.py: it must clear extraction artifacts and must
never clear a figure, date or quote that is genuinely absent from the raw.

Run from anywhere:  python3 scripts/test_adjudicate.py
"""
import sys

if sys.version_info < (3, 10):
    sys.exit("test_adjudicate.py needs Python 3.10 or newer (the vendored checker uses 3.10 syntax).")

import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "AdjudicateSuspects.py"

RAW_HEADER = "# Source Deck\n\n> Source: https://example.org/deck.pdf\n> Collected: 2026-11-20\n> Published: 2025-03-01\n\n"

PAGE_HEADER = (
    "---\ntype: summary\ntags: [pilot]\nconfidence: high\ncreated: 2026-11-20\nupdated: 2026-11-20\n---\n\n"
    "# Page\n\n> Sources: Example Org, 2025-03-01\n> Raw: [deck](../../raw/m1/deck.md)\n> Updated: 2026-11-20\n\n"
    "## Overview\n\n"
)


class Wiki:
    """A throwaway project root with one raw file and one wiki page."""

    def __init__(self, raw_body: str, page_body: str, page_header: str = PAGE_HEADER):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "raw" / "m1").mkdir(parents=True)
        (self.root / "wiki" / "summaries").mkdir(parents=True)
        (self.root / "raw" / "m1" / "deck.md").write_text(RAW_HEADER + raw_body, encoding="utf-8")
        (self.root / "wiki" / "summaries" / "page.md").write_text(page_header + page_body, encoding="utf-8")

    def run(self):
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), str(self.root)], capture_output=True, text=True, timeout=60
        )
        return proc.returncode, proc.stdout

    def close(self):
        self.tmp.cleanup()


class AdjudicateTest(unittest.TestCase):
    def check(self, raw_body, page_body, expect_code, expect_in_stdout=(), page_header=PAGE_HEADER):
        wiki = Wiki(raw_body, page_body, page_header)
        self.addCleanup(wiki.close)
        code, out = wiki.run()
        self.assertEqual(code, expect_code, out)
        for needle in expect_in_stdout:
            self.assertIn(needle, out)
        return out

    def test_clean_page_passes(self):
        self.check("Churn fell to 13.5 points in the quarter.\n", "Churn fell to 13.5 points in the quarter.\n", 0,
                   ["REAL MISMATCHES: 0", "EVIDENCE ERRORS: 0"])

    def test_substring_of_larger_number_is_real(self):
        self.check("We have 14,000 customers.\n", "We have 4,000 customers.\n", 1, ["REAL MISMATCH", "4,000"])

    def test_substring_of_decimal_is_real(self):
        self.check("Churn rose by 13.5 points.\n", "Churn rose by 3.5 points.\n", 1, ["REAL MISMATCH", "3.5"])

    def test_year_only_in_raw_header_is_real(self):
        # Collected: 2026-11-20 is bookkeeping; the body never says 2026.
        self.check("Churn fell sharply.\n", "In 2026 churn fell sharply.\n", 1, ["REAL MISMATCH", "2026"])

    def test_fabricated_body_date_is_real(self):
        self.check("Launched in the spring.\n", "It launched on 1999-04-01 as planned.\n", 1,
                   ["REAL MISMATCH", "1999-04-01"])

    def test_frontmatter_dates_are_not_counted(self):
        # created/updated in frontmatter would be suspects for the checker; they are noise here.
        self.check("Churn fell sharply.\n", "Churn fell sharply.\n", 0, ["REAL MISMATCHES: 0"])

    def test_hyphen_wrap_is_false_positive(self):
        out = self.check(
            "Good problem-\nsolving is a skill that matters a great deal.\n",
            'The speaker says "problem-solving is a skill that matters" outright.\n',
            0, ["FALSE-POSITIVE"],
        )
        self.assertNotIn("REAL MISMATCH ", out)

    def test_page_furniture_is_false_positive(self):
        self.check(
            "The platform strategy must be <!-- page 4 -->\nowned by the business unit.\n",
            'They state "platform strategy must be owned by the business unit" plainly.\n',
            0, ["FALSE-POSITIVE"],
        )

    def test_invented_quote_is_real(self):
        self.check("The deck covers adoption.\n", 'The speaker says "we will triple revenue by next year".\n', 1,
                   ["REAL MISMATCH"])

    def test_self_link_cannot_clear_a_quote(self):
        header = PAGE_HEADER.replace("../../raw/m1/deck.md", "../../wiki/summaries/page.md")
        self.check("The deck covers adoption.\n", 'The speaker says "we will triple revenue by next year".\n', 1,
                   ["EVIDENCE ERROR", "escapes raw/"], page_header=header)

    def test_absolute_raw_link_is_rejected(self):
        header = PAGE_HEADER.replace("../../raw/m1/deck.md", "/etc/hostname.md")
        self.check("x\n", "Nothing quotable here.\n", 1, ["EVIDENCE ERROR", "escapes raw/"], page_header=header)

    CLAIMS = 'We surveyed 14,000 firms on 1999-04-01 and "revenue tripled in every single unit".\n'
    BARE_HEADER = (
        "# Page\n\n> Sources: Example Org, 2025-03-01\n> Raw: [deck](../../raw/m1/deck.md)\n"
        "> Updated: 2026-11-20\n\n## Overview\n\n"
    )

    def test_leading_rule_is_not_frontmatter(self):
        # "---" ... "---" around the whole page must not hide the body from the gate.
        self.check("The deck covers adoption.\n", self.CLAIMS + "\n---\n", 1, ["REAL MISMATCH"],
                   page_header="---\n" + self.BARE_HEADER)

    def test_unclosed_frontmatter_is_not_frontmatter(self):
        header = "---\ntype: summary\ncreated: 2026-11-20\n\n" + self.BARE_HEADER
        self.check("The deck covers adoption.\n", self.CLAIMS + "\n---\n", 1, ["REAL MISMATCH"], page_header=header)

    def test_claims_inside_frontmatter_are_still_checked(self):
        header = (
            "---\ntype: summary\nsummary: Revenue tripled to 14,000 units on 1999-04-01\n"
            "created: 2026-11-20\nupdated: 2026-11-20\n---\n\n" + self.BARE_HEADER
        )
        out = self.check("The deck covers adoption.\n", "Nothing else to say here.\n", 1, ["REAL MISMATCH"], page_header=header)
        self.assertIn("14,000", out)

    def test_wrap_joining_cannot_manufacture_a_date(self):
        # Raw says "2019-" then, after a blank line, "10 firms". Joining across digits would invent "2019-10".
        self.check("Fiscal 2019-\n\n10 firms joined the program early.\n", "In 2019-10 the firms joined.\n", 1,
                   ["REAL MISMATCH", "2019-10"])
        self.check("Range 2019- 10 firms joined the program early.\n", "In 2019-10 the firms joined.\n", 1,
                   ["REAL MISMATCH", "2019-10"])

    def test_single_line_break_digit_wrap_cannot_manufacture_a_date(self):
        self.check("Fiscal 2019-\n10 firms joined the program early.\n", "In 2019-10 the firms joined.\n", 1,
                   ["REAL MISMATCH", "2019-10"])

    def test_claim_on_a_created_line_is_still_checked(self):
        # Only a bare date is bookkeeping; a claim sharing the line must not be swallowed with it.
        header = (
            "---\ntype: summary\ncreated: 2026-11-20 revenue 14,000\nupdated: 2026-11-20\n---\n\n" + self.BARE_HEADER
        )
        out = self.check("The deck covers adoption.\n", "Nothing else to say here.\n", 1, ["REAL MISMATCH"], page_header=header)
        self.assertIn("14,000", out)

    def test_letter_digit_and_unicode_wraps_are_false_positives(self):
        self.check("The COVID-\n19 pandemic reshaped adoption plans everywhere.\n",
                   'The speaker says "COVID-19 pandemic reshaped adoption" outright.\n', 0, ["FALSE-POSITIVE"])
        self.check("They opened a café-\nrestaurant near the campus last year.\n",
                   'The speaker says "café-restaurant near the campus" outright.\n', 0, ["FALSE-POSITIVE"])

    def test_non_ascii_digit_wrap_cannot_manufacture_a_date(self):
        # Arabic-Indic digits are digits to str.isdigit() and to the checker's \d; a digit-digit join must not happen.
        self.check("Fiscal ٢٠١٩-\n١٠ firms joined the program early.\n",
                   "In ٢٠١٩-١٠ the firms joined.\n", 1, ["REAL MISMATCH"])

    def test_em_dash_wrap_is_false_positive(self):
        self.check("A strong—\nstart matters a great deal here.\n",
                   'The speaker says "strong—start matters a great deal" outright.\n', 0, ["FALSE-POSITIVE"])

    def test_missing_raw_field_is_an_error(self):
        header = "# Page\n\n> Sources: Example Org\n> Updated: 2026-11-20\n\n## Overview\n\n"
        self.check("x\n", "Nothing quotable here.\n", 1, ["EVIDENCE ERROR", "no Raw field"], page_header=header)

    def test_missing_wiki_dir_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.run([sys.executable, str(SCRIPT), tmp], capture_output=True, text=True, timeout=60)
            self.assertEqual(proc.returncode, 1)


if __name__ == "__main__":
    unittest.main()
