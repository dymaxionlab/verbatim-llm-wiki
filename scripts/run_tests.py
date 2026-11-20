#!/usr/bin/env python3
"""Run the vendored check_evidence test suite.

Why a wrapper: the vendored suite includes ExamplesSmokeTest, which reads the
upstream project's examples/ directory. That directory is deliberately not
vendored (see .claude/skills/karpathy-llm-wiki/VENDORED.md), so that one test
cannot pass here. This wrapper runs every other test, unmodified, and fails
if the suite does not look like the one that was vendored (an import error, or
far fewer tests than expected, must never read as a pass).

Run from anywhere:  python3 scripts/run_tests.py
"""
import sys

if sys.version_info < (3, 10):
    sys.exit("run_tests.py needs Python 3.10 or newer (the vendored suite uses 3.10 syntax).")

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / ".claude" / "skills" / "karpathy-llm-wiki" / "tests"
EXCLUDED_CLASS = "ExamplesSmokeTest"
MIN_TESTS = 40  # the vendored suite has 52; a collapse means something is wrong, not "passing"


def flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from flatten(item)
        else:
            yield item


def main() -> int:
    loader = unittest.TestLoader()
    discovered = loader.discover(str(TESTS), top_level_dir=str(TESTS))
    tests = list(flatten(discovered))

    # A module that fails to import shows up as a _FailedTest; never hide that behind a "not found" note.
    failed_imports = [t for t in tests if type(t).__name__ == "_FailedTest"]
    if failed_imports:
        print(f"FAIL: {len(failed_imports)} test module(s) failed to import:", flush=True)
        for t in failed_imports:
            print(f"  {t.id()}", flush=True)
        result = unittest.TextTestRunner(verbosity=1).run(unittest.TestSuite(failed_imports))
        return 1

    kept = [t for t in tests if type(t).__name__ != EXCLUDED_CLASS]
    dropped = len(tests) - len(kept)
    if dropped == 0:
        print(f"note: {EXCLUDED_CLASS} not found; running the full suite", flush=True)
    else:
        print(f"skipping {dropped} test(s) in {EXCLUDED_CLASS} (needs upstream examples/, not vendored)", flush=True)
    if len(kept) < MIN_TESTS:
        print(f"FAIL: only {len(kept)} tests found, expected at least {MIN_TESTS}", flush=True)
        return 1

    result = unittest.TextTestRunner(verbosity=1).run(unittest.TestSuite(kept))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
