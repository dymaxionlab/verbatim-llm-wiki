# Operational Lessons

Learned across a 116-source production run, encoded in the schema and scripts:

- Verification runs per-source during ingest, not once at the end — a defect caught at source one is cheap; at source eight it's an archaeology dig.
- Multi-part talks get one combined summary; module-closing recaps get a "No material" log entry rather than a forced thin page; every corpus source ends with a log entry, so silent truncation is detectable.
- Agent batches need a completeness gate (every assigned raw appears in the log) and an independent verification gate before commit.
- Never hand-edit extracted text to make a claim verify. That inverts the invariant and is the one unforgivable move.
