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

    def test_video_time_markers_are_furniture(self):
        # CaptureVideo.ts splits the transcript into <!-- t=MM:SS --> blocks; a quote that spans a block boundary
        # is present once the marker is stripped, in both the MM:SS and the H:MM:SS form.
        for marker in ("<!-- t=00:30 -->", "<!-- t=1:02:05 -->"):
            self.check(
                f"the coil switches on and the spikes {marker}\nsettle within a second.\n",
                'The maker says "the coil switches on and the spikes settle within a second" plainly.\n',
                0, ["FALSE-POSITIVE"],
            )

    def test_time_markers_do_not_hide_an_invented_quote(self):
        self.check(
            "the coil switches on <!-- t=00:30 -->\nand the spikes settle.\n",
            'The maker says "the coil switches on and the spikes explode" plainly.\n',
            1, ["REAL MISMATCH"],
        )

    def test_a_malformed_marker_is_not_furniture(self):
        # Only the exact CaptureVideo shapes are stripped: seconds must be two digits and the comment well formed.
        self.check(
            "the coil switches on <!-- t=0:5 -->\nand the spikes settle within a second.\n",
            'The maker says "the coil switches on and the spikes settle within a second" plainly.\n',
            1, ["REAL MISMATCH"],
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

    # --- a decimal glued to a unit: the checker's backtracking phantom ("0.84A" is tokenized as "0.8") ---------

    AMPS_RAW = "It was labeled to take 12V and claimed to use 0.84A to lift 90lbs. Experiments followed.\n"

    def test_phantom_truncation_of_a_decimal_with_a_unit_is_cleared(self):
        out = self.check(self.AMPS_RAW, "The part was rated to use 0.84A to lift 90lbs.\n", 0,
                         ["FALSE-POSITIVE (truncated unit figure", "REAL MISMATCHES: 0"])
        self.assertIn('"0.8"', out)  # the token the checker really extracts

    def test_a_wrong_figure_with_a_unit_is_still_real(self):
        self.check(self.AMPS_RAW, "The part was rated to use 0.85A to lift 90lbs.\n", 1, ["REAL MISMATCH", '"0.8"'])
        self.check(self.AMPS_RAW, "The part was rated to use 0.84Amps to lift 90lbs.\n", 1, ["REAL MISMATCH"])
        self.check(self.AMPS_RAW, "The part was rated to use 0.84mA to lift 90lbs.\n", 1, ["REAL MISMATCH"])

    def test_truncation_rule_needs_the_full_token_at_a_boundary(self):
        # "10.84A" in the raw does not contain the page's "0.84A" as a token of its own.
        self.check("It claimed to use 10.84A to lift 90lbs.\n", "It claimed to use 0.84A to lift 90lbs.\n", 1,
                   ["REAL MISMATCH"])
        # a figure that is only a truncation and whose full token is absent stays real
        self.check("It claimed to use a current to lift 90lbs.\n", "It claimed to use 0.84A to lift 90lbs.\n", 1,
                   ["REAL MISMATCH"])

    def test_a_bare_figure_elsewhere_on_the_page_blocks_the_clearance(self):
        # The page states "0.8" on its own as well; the raw only has "0.84A". That is the claim, so it is real.
        self.check(self.AMPS_RAW, "It used 0.84A.\n\nLater it dropped to 0.8 under load.\n", 1, ["REAL MISMATCH", '"0.8"'])

    def test_unit_rule_keeps_the_number_boundary(self):
        # "4,000" inside "14,000" is still real while the unit figure beside it is cleared.
        out = self.check("About 14,000 users drew 0.84A each.\n", "About 4,000 users drew 0.84A each.\n", 1,
                         ["REAL MISMATCHES: 1", '"4,000"'])
        self.assertIn("FALSE-POSITIVE (truncated unit figure", out)

    # --- pdftotext furniture: running headers, bare page numbers, wraps across a blank line --------------------

    SPAN = 'The maker says "the coil switches on and the spikes settle within a second" plainly.\n'

    def test_running_header_after_a_page_marker_is_furniture(self):
        raw = ("the coil switches on and the spikes\n\n---\n\n<!-- page 4 -->\n\n"
               "Chapter 3. Methodology\n\nsettle within a second.\n")
        self.check(raw, self.SPAN, 0, ["FALSE-POSITIVE"])
        raw = ("the coil switches on and the spikes\n\n---\n\n<!-- page 9 -->\n\n"
               "   Chapter 12. Previous Work and Results\n\nsettle within a second.\n")
        self.check(raw, self.SPAN, 0, ["FALSE-POSITIVE"])

    def test_a_chapter_line_that_is_not_a_running_header_is_kept(self):
        # not after a page marker
        self.check("the coil switches on and the spikes\n\nChapter 3. Methodology\n\nsettle within a second.\n",
                   self.SPAN, 1, ["REAL MISMATCH"])
        # a sentence that starts with it, or mentions Chapter 3 inline
        raw = ("the coil switches on and the spikes\n\n---\n\n<!-- page 4 -->\n\n"
               "Chapter 3. Methodology builds on settle within a second.\n")
        self.check(raw, self.SPAN, 1, ["REAL MISMATCH"])
        raw = "the coil switches on and the spikes <!-- page 4 --> see Chapter 3 settle within a second.\n"
        self.check(raw, self.SPAN, 1, ["REAL MISMATCH"])
        # a bare chapter opener has no title and is not a running header
        raw = "the coil switches on and the spikes\n\n---\n\n<!-- page 4 -->\n\nChapter 3\n\nsettle within a second.\n"
        self.check(raw, self.SPAN, 1, ["REAL MISMATCH"])

    def test_bare_page_numbers_before_a_page_break_are_furniture(self):
        for number in ("28", "7", "123", "iv", "xii"):
            raw = (f"the coil switches on and the spikes\n\n{'':20}{number}\n\n---\n\n<!-- page 5 -->\n\n"
                   "settle within a second.\n")
            self.check(raw, self.SPAN, 0, ["FALSE-POSITIVE"])

    def test_a_number_line_that_is_not_a_page_number_is_kept(self):
        # mid-text (a footnote marker or a table cell), four digits, or words: all stay content
        self.check("the coil switches on and the spikes\n\n2\n\nsettle within a second.\n", self.SPAN, 1, ["REAL MISMATCH"])
        for line in ("2019", "12 A", "iv.", "dim", "IV"):
            raw = (f"the coil switches on and the spikes\n\n{line}\n\n---\n\n<!-- page 5 -->\n\n"
                   "settle within a second.\n")
            self.check(raw, self.SPAN, 1, ["REAL MISMATCH"])

    def test_stripping_a_page_number_cannot_verify_a_quote_that_contains_it(self):
        raw = "the cost fell to\n\n28\n\n---\n\n<!-- page 5 -->\n\npercent in the quarter.\n"
        self.check(raw, 'They say "the cost fell to 28 percent in the quarter" plainly.\n', 1, ["REAL MISMATCH"])

    def test_wraps_across_a_blank_line_are_joined(self):
        for left, right in (("coat-", "ings"), ("fer-", "rofluid"), ("solu-", "tion"), ("cumber-", "some")):
            word = left[:-1] + right
            raw = f"the maker says the {left}\n\n{right} is the part that matters here.\n"
            # the typesetting reading (hyphen dropped) and the compound reading (hyphen kept) both verify
            self.check(raw, f'The maker says "the {word} is the part that matters" outright.\n', 0, ["FALSE-POSITIVE"])
            self.check(raw, f'The maker says "the {left}{right} is the part that matters" outright.\n', 0,
                       ["FALSE-POSITIVE"])

    def test_dropped_hyphen_joins_letter_to_letter_only(self):
        # letter-digit and digit-digit wraps never lose the hyphen, blank line or not
        self.check("The COVID-\n\n19 pandemic reshaped adoption plans everywhere.\n",
                   'The speaker says "COVID19 pandemic reshaped adoption" outright.\n', 1, ["REAL MISMATCH"])
        self.check("Fiscal 2019-\n\n10 firms joined the program early.\n", "In 2019-10 the firms joined.\n", 1,
                   ["REAL MISMATCH", "2019-10"])
        self.check("the maker says the fer-\n\nrofluid matters here.\n",
                   'The maker says "the fer rofluid matters" outright.\n', 1, ["REAL MISMATCH"])

    # --- inch marks: a `"` after a digit must not shift the checker's quote pairing --------------------------------

    INCH_RAW = ('The tower measures 16" x 12" x 12" in total. Later she said "ferrofluid climbs the iron spiral '
                'tower" on camera. The sheet is 3/4" by 2" and "up to 80" units fit.\n')

    def test_inch_marks_do_not_shift_quote_pairing(self):
        # Before the fix, the three bare inch marks paired with the next quote delimiters, the true quote was
        # lost, and a fabricated quote later in the paragraph passed with exit 0.
        self.check(self.INCH_RAW, 'The tower measures 16" x 12" x 12" in total. Later she said "ferrofluid climbs the '
                   'iron spiral tower" on camera.\n', 0, ["REAL MISMATCHES: 0"])
        self.check(self.INCH_RAW, 'The tower measures 16" x 12" x 12" in total. Later she said "ferrofluid defies the '
                   'laws of gravity entirely" on camera.\n', 1, ["REAL MISMATCH", "ferrofluid defies the laws"])

    def test_a_quote_holding_a_dimension_is_compared_exactly(self):
        raw = 'The label reads: tower measures 16" x 12" x 12" in total, nothing more.\n'
        self.check(raw, 'The label says "tower measures 16" x 12" x 12" in total" outright.\n', 0, ["REAL MISMATCHES: 0"])
        out = self.check(raw, 'The label says "tower measures 16" x 12" x 18" in total" outright.\n', 1,
                         ["REAL MISMATCH"])
        self.assertIn('x 18" in total', out)  # reported with its inch marks, not the private placeholder
        self.assertNotIn("", out)

    def test_a_single_inch_mark_and_a_by_chain(self):
        self.check(self.INCH_RAW, 'A 16" tower, and she said "ferrofluid climbs the iron spiral tower" later.\n', 0,
                   ["REAL MISMATCHES: 0"])
        self.check(self.INCH_RAW, 'The sheet is 3/4" by 2" and she said "ferrofluid climbs the iron spiral tower".\n', 0,
                   ["REAL MISMATCHES: 0"])
        self.check(self.INCH_RAW, 'The sheet is 3/4" by 2" and she said "ferrofluid sinks the iron spiral tower".\n', 1,
                   ["REAL MISMATCH", "ferrofluid sinks"])

    def test_a_closing_quote_after_a_digit_is_still_a_quote(self):
        # `"up to 80"` closes on a digit with a quote open and no dimension chain: it must still pair, so the
        # fabricated quote after it is caught and a true one verifies.
        self.check(self.INCH_RAW, 'The page says "up to 80" and later "ferrofluid climbs the iron spiral tower".\n', 0,
                   ["REAL MISMATCHES: 0"])
        self.check(self.INCH_RAW, 'The page says "up to 80" and later "ferrofluid sinks the iron spiral tower".\n', 1,
                   ["REAL MISMATCH", "ferrofluid sinks"])

    def test_inch_marks_in_inline_code_and_across_paragraphs(self):
        # the code-span workaround keeps working, and an unpaired quote never leaks into the next paragraph
        self.check(self.INCH_RAW, 'It is `16" x 12" x 12"` and she said "ferrofluid climbs the iron spiral tower".\n\n'
                   'Then 8" more, and a lone " mark.\n\nShe said "ferrofluid sinks the iron spiral tower".\n', 1,
                   ["REAL MISMATCH", "ferrofluid sinks"])

    def test_mask_inch_marks_unit(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("adjudicate_under_test", SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        sys.modules["adjudicate_under_test"] = mod
        spec.loader.exec_module(mod)
        ph = mod.INCH_PLACEHOLDER
        self.assertEqual(mod.mask_inch_marks('a 16" x 12" x 12" tower'), f"a 16{ph} x 12{ph} x 12{ph} tower")
        self.assertEqual(mod.mask_inch_marks('said "it is 80" and "ok"'), 'said "it is 80" and "ok"')
        self.assertEqual(mod.mask_inch_marks('a 16" tower'), f"a 16{ph} tower")
        self.assertEqual(mod.mask_inch_marks('size 16.5" x 12 wide'), f"size 16.5{ph} x 12 wide")
        self.assertEqual(mod.mask_inch_marks('code `16" x 2"` here'), 'code `16" x 2"` here')
        self.assertEqual(mod.mask_inch_marks('plain "quote" only'), 'plain "quote" only')
        # a closing quote with a quote open stays a quote even when a later dimension chain follows
        self.assertEqual(mod.mask_inch_marks('"up to 80" then 2" x 3"'), f'"up to 80" then 2{ph} x 3{ph}')
        # a quote that opens after a space is never an inch mark
        self.assertEqual(mod.mask_inch_marks('size 5 "big" and "small"'), 'size 5 "big" and "small"')

    # --- images: alt text, the media path and a thumbnail's outer link are furniture, not claims -----------------

    IMG_RAW = 'The tower uses coils and she said "the ferrofluid climbs the spiral tower" on camera.\n'
    THUMB = ('[![Spike Tower 2016 video, 1200 px, 4096 frames, "quoted alt text here"]'
             '(../media/example-work-video-2016-12.jpg)](https://video.example.com/watch/1)')

    def test_numbers_and_quotes_in_image_alt_text_are_not_claims(self):
        page = ('The tower uses coils and she said "the ferrofluid climbs the spiral tower" on camera.\n\n'
                f'{self.THUMB}\n\n'
                '![Spike tower 48 coils, 2008-06-01, 12.5 mm](../media/tower-20161124-48.jpg "title with 99 and 2007-01-01")\n')
        out = self.check(self.IMG_RAW, page, 0, ["REAL MISMATCHES: 0", "FALSE-POSITIVE (image alt text"])
        for value in ("1200", "4096", "2016", "12.5", "2008-06-01"):
            self.assertIn(f'"{value}"', out)  # still listed, so a number in alt text stays visible
        self.assertNotIn("76979871", out)  # a thumbnail's outer link and the media path are never candidates
        self.assertNotIn("20161124", out)

    def test_the_same_number_in_prose_is_still_a_claim(self):
        page = f'The tower has 4096 frames.\n\n{self.THUMB}\n'
        self.check(self.IMG_RAW, page, 1, ["REAL MISMATCH", '"4096"'])

    def test_a_stray_quote_in_alt_text_does_not_shift_prose_quote_pairing(self):
        page = ('![a stray " quote in alt text](../media/x.jpg)\n'
                'She said "the ferrofluid defies gravity entirely" on camera.\n')
        self.check(self.IMG_RAW, page, 1, ["REAL MISMATCH", "the ferrofluid defies gravity entirely"])
        page_ok = ('![a stray " quote in alt text](../media/x.jpg)\n'
                   'She said "the ferrofluid climbs the spiral tower" on camera.\n')
        self.check(self.IMG_RAW, page_ok, 0, ["REAL MISMATCHES: 0"])

    def test_link_text_that_is_not_an_image_is_still_checked(self):
        self.check(self.IMG_RAW, 'See [Figure 12345](../concepts/x.md) for the layout.\n', 1, ["REAL MISMATCH", "12345"])

    # --- year ranges: "2021-2023" is read by the checker as the date "2021-20" -------------------------------

    def test_hyphen_year_range_with_both_years_in_the_raw_is_cleared(self):
        out = self.check("The studio worked from 2021 until 2023 on this series.\n",
                         "The studio was active 2021-2023 on this series.\n", 0,
                         ["REAL MISMATCHES: 0", "FALSE-POSITIVE (year range; both years verbatim in raw)", '"2021-20"'])
        self.assertNotIn("REAL MISMATCH ", out)

    def test_range_written_as_a_range_in_the_raw_is_cleared(self):
        self.check("Exhibited 2021-2023 in three cities.\n", "The work toured 2021-2023 in three cities.\n", 0,
                   ["REAL MISMATCHES: 0"])

    def test_en_dash_year_range_with_both_years_in_the_raw_passes(self):
        self.check("The studio worked from 2021 until 2023 on this series.\n",
                   "The studio was active 2021–2023 on this series.\n", 0, ["REAL MISMATCHES: 0"])

    def test_year_range_with_a_year_absent_from_the_raw_is_still_real(self):
        # 2023 is nowhere in the raw: the range must not clear it (the checker alone never even looked at 2023).
        self.check("The studio worked from 2021 on this series.\n", "The studio was active 2021-2023 on this series.\n", 1,
                   ["REAL MISMATCHES: 1", '"2021-20"'])
        self.check("The studio worked until 2023 on this series.\n", "The studio was active 2021-2023 on this series.\n", 1,
                   ["REAL MISMATCHES: 1"])
        self.check("The studio worked from 2021 on this series.\n", "The studio was active 2021–2023 on this series.\n", 1,
                   ["REAL MISMATCH", '"2023"'])

    def test_a_bare_truncated_date_outside_a_range_is_not_cleared_by_the_range_rule(self):
        # "2021-20" alone is not a range truncation; the raw has the years but not that date.
        self.check("Active in 2021 and 2020.\n", "The record is dated 2021-20 on the label.\n", 1, ["REAL MISMATCH"])

    def test_missing_raw_field_is_an_error(self):
        header = "# Page\n\n> Sources: Example Org\n> Updated: 2026-11-20\n\n## Overview\n\n"
        self.check("x\n", "Nothing quotable here.\n", 1, ["EVIDENCE ERROR", "no Raw field"], page_header=header)

    def test_missing_wiki_dir_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.run([sys.executable, str(SCRIPT), tmp], capture_output=True, text=True, timeout=60)
            self.assertEqual(proc.returncode, 1)


if __name__ == "__main__":
    unittest.main()
