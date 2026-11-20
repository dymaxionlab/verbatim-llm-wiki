// Tests for ExtractPdf.ts. Each test runs the script inside a throwaway copy of the repo layout
// (scripts/ + raw/), so nothing outside the temp directory is ever touched.
// Run: bun test scripts/
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SCRIPT = path.join(import.meta.dir, "ExtractPdf.ts");
const HAVE_POPPLER = Bun.which("pdftotext") !== null;
// Without poppler every test below is skipped, and "0 pass, N skip" exits 0. Never let that read as green in CI.
if (!HAVE_POPPLER && process.env.CI) {
  throw new Error("pdftotext (poppler-utils) is required to run these tests in CI");
}
if (!HAVE_POPPLER) {
  console.warn("WARNING: pdftotext not found; the ExtractPdf tests are SKIPPED, not passed. Install poppler-utils.");
}

/** A minimal one-page PDF whose single text line is `text` (empty string = no text at all). */
function makePdf(text: string): Uint8Array {
  const esc = text.replace(/[\\()]/g, (c) => "\\" + c);
  const content = text ? `BT /F1 12 Tf 72 720 Td (${esc}) Tj ET` : "";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const LONG =
  "Platform strategy must be owned by the business unit and funded as a product, not a project. " +
  "Teams that treat it as a one-off project stop investing once the launch date passes. ";

let work: string; // temp project root
let outside: string; // a directory the script must never write into

function run(args: string[]) {
  // The timeout turns a hang (e.g. reading a FIFO) into a failed test instead of a stalled run.
  const proc = Bun.spawnSync(["bun", path.join(work, "scripts", "ExtractPdf.ts"), ...args], { cwd: work, timeout: 30_000 });
  return {
    code: proc.exitCode,
    out: new TextDecoder().decode(proc.stdout),
    err: new TextDecoder().decode(proc.stderr),
  };
}

function writePdf(rel: string, text: string): string {
  const p = path.join(work, "src", rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, makePdf(text));
  return p;
}

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "extractpdf-work-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "extractpdf-outside-"));
  fs.mkdirSync(path.join(work, "scripts"));
  fs.copyFileSync(SCRIPT, path.join(work, "scripts", "ExtractPdf.ts"));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe.skipIf(!HAVE_POPPLER)("ExtractPdf", () => {
  test("extracts one PDF into raw/<topic>/ with page markers", () => {
    const pdf = writePdf("Deck A.pdf", LONG);
    const r = run([pdf, "--topic", "m1"]);
    expect(r.code).toBe(0);
    const md = fs.readFileSync(path.join(work, "raw/m1/deck-a.md"), "utf-8");
    expect(md).toContain("<!-- page 1 -->");
    expect(md).toContain("Platform strategy must be owned by the business unit");
    expect(fs.existsSync(path.join(work, "raw/m1/deck-a.pdf"))).toBe(true);
  });

  test("accepts several inputs, as the README command does", () => {
    const a = writePdf("one.pdf", LONG + "alpha");
    const b = writePdf("two.pdf", LONG + "beta");
    const r = run([a, b, "--topic", "m1"]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(work, "raw/m1/one.md"))).toBe(true);
    expect(fs.existsSync(path.join(work, "raw/m1/two.md"))).toBe(true);
  });

  test("re-running is idempotent", () => {
    const pdf = writePdf("deck.pdf", LONG);
    expect(run([pdf, "--topic", "m1"]).code).toBe(0);
    const again = run([pdf, "--topic", "m1"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("skip (already extracted)");
  });

  test("a slug collision is an error, not a silent skip", () => {
    const first = writePdf("Deck A.pdf", LONG + "first");
    const second = writePdf("deck-a.pdf", LONG + "second");
    expect(run([first, "--topic", "m1"]).code).toBe(0);
    const before = fs.readFileSync(path.join(work, "raw/m1/deck-a.pdf"));
    const r = run([second, "--topic", "m1"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("slug collision");
    expect(fs.readFileSync(path.join(work, "raw/m1/deck-a.pdf")).equals(before)).toBe(true);
  });

  test("an image-only deck is rejected and leaves nothing in raw/, so its OCR'd twin can reuse the name", () => {
    const img = writePdf("scan.pdf", "");
    const r = run([img, "--topic", "ocr"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("needs OCR");
    expect(fs.existsSync(path.join(work, "raw/ocr/scan.pdf"))).toBe(false);
    // The OCR'd replacement, same file name, now goes through.
    fs.writeFileSync(img, makePdf(LONG));
    expect(run([img, "--topic", "ocr"]).code).toBe(0);
    expect(fs.existsSync(path.join(work, "raw/ocr/scan.md"))).toBe(true);
  });

  test("a dangling symlink at the .md destination is refused, nothing is written outside", () => {
    fs.mkdirSync(path.join(work, "raw/evil"), { recursive: true });
    fs.copyFileSync(writePdf("seed.pdf", LONG), path.join(work, "raw/evil/deck-a.pdf"));
    const target = path.join(outside, "stolen.md");
    fs.symlinkSync(target, path.join(work, "raw/evil/deck-a.md"));
    const r = run([path.join(work, "raw/evil/deck-a.pdf")]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("symlink");
    expect(fs.existsSync(target)).toBe(false);
  });

  test("a symlinked topic directory pointing outside raw/ is refused", () => {
    fs.mkdirSync(path.join(work, "raw"), { recursive: true });
    fs.symlinkSync(outside, path.join(work, "raw/linked"));
    const pdf = writePdf("deck.pdf", LONG);
    const r = run([pdf, "--topic", "linked"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("outside raw/");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test("topics that could escape raw/ are rejected before anything runs", () => {
    const pdf = writePdf("deck.pdf", LONG);
    for (const topic of ["../escape", "a/b", "/abs", ".hidden", "x..y"]) {
      const r = run([pdf, "--topic", topic]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("--topic must be a single directory name");
    }
    expect(fs.existsSync(path.join(work, "raw"))).toBe(false);
  });

  test("a directory input finds PDFs, including symlinked PDF files", () => {
    const real = writePdf("pdfs/real.pdf", LONG + "real");
    fs.symlinkSync(writePdf("elsewhere/target.pdf", LONG + "target"), path.join(path.dirname(real), "linked.pdf"));
    const r = run([path.dirname(real), "--topic", "m1"]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(work, "raw/m1/real.md"))).toBe(true);
    expect(fs.existsSync(path.join(work, "raw/m1/linked.md"))).toBe(true);
  });

  test("a symlinked raw/ itself is refused, nothing is written outside", () => {
    fs.symlinkSync(outside, path.join(work, "raw"));
    const pdf = writePdf("deck.pdf", LONG);
    const r = run([pdf, "--topic", "m1"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("symlink");
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test("--force regenerates the .md in place", () => {
    const pdf = writePdf("deck.pdf", LONG);
    expect(run([pdf, "--topic", "m1"]).code).toBe(0);
    const md = path.join(work, "raw/m1/deck.md");
    // A stale extraction of THIS pdf keeps its header, so --force may regenerate it.
    fs.writeFileSync(md, "# Deck\n\n> Source: raw/m1/deck.pdf\n\nstale body\n");
    expect(run([pdf, "--topic", "m1", "--force"]).code).toBe(0);
    expect(fs.readFileSync(md, "utf-8")).toContain("<!-- page 1 -->");
  });

  test("--force never writes through a symlinked .md", () => {
    const pdf = writePdf("deck.pdf", LONG);
    expect(run([pdf, "--topic", "m1"]).code).toBe(0);
    const victim = path.join(outside, "victim.md");
    fs.writeFileSync(victim, "SECRET");
    const md = path.join(work, "raw/m1/deck.md");
    fs.unlinkSync(md);
    fs.symlinkSync(victim, md);
    const r = run([pdf, "--topic", "m1", "--force"]);
    expect(r.code).toBe(1);
    expect(fs.readFileSync(victim, "utf-8")).toBe("SECRET");
  });

  test("a dangling PDF symlink in directory mode is an error, not a silent skip", () => {
    const dir = path.join(work, "src/pdfs");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(outside, "missing.pdf"), path.join(dir, "ghost.pdf"));
    const r = run([dir, "--topic", "m1"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("symlink");
  });

  test("a directory sitting at the .md path is an error, not 'already extracted'", () => {
    const pdf = writePdf("deck.pdf", LONG);
    fs.mkdirSync(path.join(work, "raw/m1/deck.md"), { recursive: true });
    const r = run([pdf, "--topic", "m1"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not a regular file");
  });

  test("a path that reaches raw/ through a symlink is extracted in place, not copied into a new topic", () => {
    fs.mkdirSync(path.join(work, "raw/m1"), { recursive: true });
    fs.writeFileSync(path.join(work, "raw/m1/deck.pdf"), makePdf(LONG));
    const alias = path.join(outside, "alias");
    fs.symlinkSync(work, alias);
    const r = run([path.join(alias, "raw/m1/deck.pdf")]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(work, "raw/m1/deck.md"))).toBe(true);
    expect(fs.existsSync(path.join(work, "raw/sources"))).toBe(false);
  });

  test("an unrelated .md under the same slug is a collision, and --force never replaces it", () => {
    fs.mkdirSync(path.join(work, "raw/m1"), { recursive: true });
    const unrelated = path.join(work, "raw/m1/report.md");
    fs.writeFileSync(unrelated, "# Hand-written source\n\n> Source: https://example.org/notes\n\nNot from a PDF.\n");
    const pdf = writePdf("Report.pdf", LONG);
    for (const extra of [[], ["--force"]]) {
      const r = run([pdf, "--topic", "m1", ...extra]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("slug collision");
    }
    expect(fs.readFileSync(unrelated, "utf-8")).toContain("Hand-written source");
    expect(fs.existsSync(path.join(work, "raw/m1/report.pdf"))).toBe(false);
  });

  test("a clone that has the .md but not the gitignored PDF re-runs as a skip, not a collision", () => {
    const pdf = writePdf("deck.pdf", LONG);
    expect(run([pdf, "--topic", "m1"]).code).toBe(0);
    fs.unlinkSync(path.join(work, "raw/m1/deck.pdf")); // PDFs are gitignored, so a fresh clone lacks them
    const r = run([pdf, "--topic", "m1"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("skip (already extracted)");
  });

  test("a symlink planted at the PDF destination is refused, never read through", () => {
    fs.mkdirSync(path.join(work, "raw/m1"), { recursive: true });
    const secret = path.join(outside, "secret.pdf");
    fs.writeFileSync(secret, makePdf(LONG));
    fs.symlinkSync(secret, path.join(work, "raw/m1/deck.pdf"));
    const r = run([writePdf("deck.pdf", LONG + "other"), "--topic", "m1"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("symlink");
    expect(r.err).not.toContain("slug collision");
  });

  test.skipIf(Bun.which("mkfifo") === null)("a FIFO at the PDF destination is refused without hanging", () => {
    fs.mkdirSync(path.join(work, "raw/m1"), { recursive: true });
    expect(Bun.spawnSync(["mkfifo", path.join(work, "raw/m1/deck.pdf")]).success).toBe(true);
    const r = run([writePdf("deck.pdf", LONG), "--topic", "m1"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not a regular file");
  });

  test("a hand-written .md beside a PDF dropped into raw/ is a collision, with or without --force", () => {
    fs.mkdirSync(path.join(work, "raw/m1"), { recursive: true });
    fs.writeFileSync(path.join(work, "raw/m1/keynote.pdf"), makePdf(LONG));
    const handWritten = path.join(work, "raw/m1/keynote.md");
    fs.writeFileSync(handWritten, "# Keynote\n\n> Source: https://example.org/keynote-video\n\nHand-written notes.\n");
    for (const extra of [[], ["--force"]]) {
      const r = run([path.join(work, "raw/m1/keynote.pdf"), ...extra]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("slug collision");
    }
    expect(fs.readFileSync(handWritten, "utf-8")).toContain("Hand-written notes.");
  });

  test("a '> Source:' line in the body does not make an .md look PDF-derived", () => {
    fs.mkdirSync(path.join(work, "raw/m1"), { recursive: true });
    const md = path.join(work, "raw/m1/deck.md");
    fs.writeFileSync(md, "# Notes\n\n> Sources: https://example.org/x\n\n> Source: raw/m1/deck.pdf\n\nBody.\n");
    const r = run([writePdf("deck.pdf", LONG), "--topic", "m1", "--force"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("slug collision");
    expect(fs.readFileSync(md, "utf-8")).toContain("Body.");
  });

  test("a CRLF Source line still matches, so a clone re-runs as a skip", () => {
    const pdf = writePdf("deck.pdf", LONG);
    expect(run([pdf, "--topic", "m1"]).code).toBe(0);
    const md = path.join(work, "raw/m1/deck.md");
    fs.writeFileSync(md, fs.readFileSync(md, "utf-8").replace(/\n/g, "\r\n"));
    fs.unlinkSync(path.join(work, "raw/m1/deck.pdf"));
    const r = run([pdf, "--topic", "m1"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("skip (already extracted)");
  });

  test("a symlinked topic directory is refused on the skip path too, not read through", () => {
    fs.mkdirSync(path.join(work, "raw"), { recursive: true });
    fs.writeFileSync(path.join(outside, "deck.md"), "# Deck\n\n> Source: raw/linked/deck.pdf\n\noutside\n");
    fs.symlinkSync(outside, path.join(work, "raw/linked"));
    const r = run([writePdf("deck.pdf", LONG), "--topic", "linked"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("outside raw/");
    expect(r.out).not.toContain("skip");
  });
});
