#!/usr/bin/env bun
/**
 * ExtractPdf.ts — Extract text from PDF sources into raw/<topic>/<slug>.md
 * for the karpathy-llm-wiki grounding invariant (every wiki claim must be
 * greppable in a raw/ markdown file).
 *
 * Each PDF gets two files under raw/<topic>/:
 *   <slug>.pdf — the original binary, copied in, immutable, never overwritten
 *   <slug>.md  — extracted text, formatted per the wiki's raw-template.md
 *
 * Usage:
 *   bun scripts/ExtractPdf.ts <pdf-path-or-dir> [--topic <topic>] [--force]
 *
 * Flags:
 *   --topic <topic>   Topic subdirectory under raw/ (default: sources).
 *                      Ignored for PDFs already inside raw/<topic>/ — the
 *                      existing topic directory is used instead.
 *   --force            Re-extract even if the target .md already exists.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const RAW_ROOT = path.join(REPO_ROOT, "raw");
const DEFAULT_TOPIC = "sources";
const MIN_TEXT_LENGTH = 100;

interface Args {
  inputs: string[];
  topic: string;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const inputs: string[] = [];
  let topic = DEFAULT_TOPIC;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--topic") {
      const value = argv[++i];
      if (!value) throw new Error("--topic requires a value");
      // One plain directory name under raw/: no separators, no "..", so a topic can never escape raw/.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes("..")) {
        throw new Error(`--topic must be a single directory name (letters, digits, . _ -), got: ${value}`);
      }
      topic = value;
    } else if (arg === "--force") {
      force = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      inputs.push(arg);
    }
  }

  if (inputs.length === 0) {
    throw new Error("missing required <pdf-or-dir> argument");
  }
  return { inputs, topic, force };
}

function printUsage(): void {
  console.error(
    "Usage: bun scripts/ExtractPdf.ts <pdf-or-dir>... [--topic <topic>] [--force]",
  );
}

/** Recursively find *.pdf files under a directory, or return a single file path. */
function findPdfFiles(inputPath: string): string[] {
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) {
    if (!inputPath.toLowerCase().endsWith(".pdf")) {
      throw new Error(`not a PDF file: ${inputPath}`);
    }
    return [inputPath];
  }
  if (!stat.isDirectory()) {
    throw new Error(`not a file or directory: ${inputPath}`);
  }

  const results: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.toLowerCase().endsWith(".pdf")) {
        // A symlinked PDF is read, never written through; symlinked directories are not followed.
        const isFile = entry.isFile() || (entry.isSymbolicLink() && fs.statSync(full, { throwIfNoEntry: false })?.isFile());
        if (isFile) results.push(full);
        else if (entry.isSymbolicLink()) throw new Error(`dangling or non-file symlink named like a PDF: ${full}`);
      }
    }
  };
  walk(inputPath);
  return results.sort();
}

/** kebab-case a filename stem, max 60 chars, no leading/trailing dashes. */
function slugify(stem: string, maxLen = 60): string {
  const slug = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, maxLen).replace(/-+$/g, "") || "untitled";
}

function titleFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function toIsoDate(d: Date): string {
  // Local date, not UTC — toISOString() rolls evening timestamps to the next day.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Run a command and capture stdout as text. Throws with stderr on failure. */
function run(cmd: string[]): { stdout: string; ok: boolean; stderr: string } {
  // argv array, no shell; the timeout keeps a hostile PDF from hanging the tool.
  const proc = Bun.spawnSync(cmd, { timeout: 120_000 });
  return {
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
    ok: proc.success,
  };
}

/** Best-effort PDF title + creation date via pdfinfo. Never throws. */
function readPdfInfo(pdfPath: string): { title?: string; published?: string } {
  if (!Bun.which("pdfinfo")) return {};
  try {
    const { stdout, ok } = run(["pdfinfo", pdfPath]);
    if (!ok) return {};
    const titleMatch = stdout.match(/^Title:\s+(.+)$/m);
    const dateMatch = stdout.match(/^CreationDate:\s+(.+)$/m);
    const result: { title?: string; published?: string } = {};
    if (titleMatch && titleMatch[1].trim()) {
      result.title = titleMatch[1].trim();
    }
    if (dateMatch) {
      const parsed = new Date(dateMatch[1].trim());
      if (!Number.isNaN(parsed.getTime())) {
        result.published = toIsoDate(parsed);
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** Strip trailing whitespace per line and collapse 3+ blank lines to 2. */
function cleanPageText(text: string): string {
  const noTrailing = text
    .split("\n")
    .map((line) => line.trimEnd()) // linear time, unlike a trailing-whitespace regex on long space runs
    .join("\n");
  return noTrailing.replace(/\n{3,}/g, "\n\n").trim();
}

interface ExtractionResult {
  text: string;
  rawLength: number;
}

/** Run pdftotext -layout and format pages with citable page-break markers. */
function extractText(pdfPath: string): ExtractionResult {
  const { stdout, ok, stderr } = run(["pdftotext", "-layout", pdfPath, "-"]);
  if (!ok) {
    throw new Error(`pdftotext failed on ${pdfPath}: ${stderr.trim()}`);
  }

  const rawPages = stdout.split("\f");
  // pdftotext emits a trailing form feed after the last page; splitting on
  // it leaves a phantom empty final element that would render as a
  // content-free page marker. Drop it, but only when trailing and empty —
  // a genuinely blank page in the middle of the document still gets one.
  if (rawPages.length > 1 && rawPages[rawPages.length - 1].trim() === "") {
    rawPages.pop();
  }
  const rawLength = rawPages.join("").trim().length;

  const pageBlocks = rawPages.map((page, i) => {
    const cleaned = cleanPageText(page);
    return `---\n\n<!-- page ${i + 1} -->\n\n${cleaned}`;
  });

  return { text: pageBlocks.join("\n\n"), rawLength };
}

function buildMarkdown(opts: {
  title: string;
  sourceRelPath: string;
  collected: string;
  published: string;
  body: string;
}): string {
  const { title, sourceRelPath, collected, published, body } = opts;
  return (
    `# ${title}\n\n` +
    `> Source: ${sourceRelPath}\n` +
    `> Collected: ${collected}\n` +
    `> Published: ${published}\n\n` +
    `> Extracted from PDF via pdftotext; formatting is approximate. Figures and charts are not captured.\n\n` +
    `${body}\n`
  );
}

/** Determine the raw/<topic>/ destination for a PDF, and whether it's already there. */
function resolveDestination(
  inputPath: string,
  topicArg: string,
): { pdfDest: string; topic: string; alreadyInRaw: boolean } {
  const resolved = path.resolve(inputPath);
  // Decide "already inside raw/" by REAL path, so a path that reaches raw/ through a symlink is
  // recognised (and extracted in place) instead of being copied into raw/<topic>/ as a duplicate.
  let realInput = resolved;
  let rawReal = RAW_ROOT;
  try {
    realInput = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
    rawReal = fs.realpathSync(RAW_ROOT);
  } catch {
    // raw/ not created yet, or the directory is unreadable: fall back to the lexical comparison.
  }
  const rawRelative = path.relative(rawReal, realInput);
  const alreadyInRaw = !rawRelative.startsWith("..") && !path.isAbsolute(rawRelative);

  if (alreadyInRaw) {
    const segments = rawRelative.split(path.sep);
    const topic = segments.length >= 2 ? segments[0] : topicArg;
    return { pdfDest: path.join(RAW_ROOT, rawRelative), topic, alreadyInRaw: true };
  }

  const stem = path.basename(resolved, path.extname(resolved));
  const slug = slugify(stem);
  const pdfDest = path.join(RAW_ROOT, topicArg, `${slug}.pdf`);
  return { pdfDest, topic: topicArg, alreadyInRaw: false };
}

/** True when something exists at p, counting a dangling symlink (existsSync says false for one). */
function existsNoFollow(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Refuse any destination whose real directory is outside raw/ or whose final
 * component is a symlink, so a planted symlink can never redirect a write out
 * of the repository. Call after the destination directory exists.
 */
function assertRawRootSafe(): void {
  // raw/ itself must be a real directory inside the repository, not a symlink to somewhere else.
  // Call this BEFORE any mkdir, so a refused run creates nothing outside the repository.
  if (!existsNoFollow(RAW_ROOT)) return; // not created yet: mkdir below will create a real one
  if (fs.lstatSync(RAW_ROOT).isSymbolicLink()) {
    throw new Error(`refusing to write: ${RAW_ROOT} is a symlink, not a directory inside the repository`);
  }
  const rawReal = fs.realpathSync(RAW_ROOT);
  const repoReal = fs.realpathSync(REPO_ROOT);
  if (!rawReal.startsWith(repoReal + path.sep)) {
    throw new Error(`refusing to write: raw/ resolves to ${rawReal}, outside the repository`);
  }
}

function assertInsideRaw(dest: string): void {
  assertRawRootSafe();
  const rawReal = fs.realpathSync(RAW_ROOT);
  const dirReal = fs.realpathSync(path.dirname(dest));
  if (dirReal !== rawReal && !dirReal.startsWith(rawReal + path.sep)) {
    throw new Error(`refusing to write outside raw/: ${dest} resolves to ${dirReal}`);
  }
  if (existsNoFollow(dest) && fs.lstatSync(dest).isSymbolicLink()) {
    throw new Error(`refusing to write through a symlink: ${dest}`);
  }
}

/**
 * The `> Source:` value from the metadata header (the blockquote right after the first H1), or null.
 * Header only: a "> Source:" line further down the page is content, not the record of where it came from.
 */
function headerSourceOf(markdown: string): string | null {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = lines.findIndex((line) => line.startsWith("# "));
  if (i < 0) return null;
  for (i++; i < lines.length && lines[i].trim() === ""; i++);
  for (; i < lines.length && lines[i].trim().startsWith(">"); i++) {
    const m = lines[i].trim().match(/^>\s*Source:\s*(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

/** A raw .pdf already at pdfDest with different bytes is a slug collision: two sources, one name. */
function assertNoCollision(inputPath: string, pdfDest: string, alreadyInRaw: boolean): void {
  if (alreadyInRaw || !existsNoFollow(pdfDest)) return;
  // Look at what is there BEFORE reading it: a symlink, FIFO or directory planted at the destination
  // must be refused, never read (a FIFO would hang the run; a symlink would be read through).
  const destStat = fs.lstatSync(pdfDest);
  if (destStat.isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${pdfDest}`);
  if (!destStat.isFile()) throw new Error(`${pdfDest} exists and is not a regular file`);
  const resolvedInput = path.resolve(inputPath);
  if (resolvedInput !== pdfDest && !fs.readFileSync(resolvedInput).equals(fs.readFileSync(pdfDest))) {
    throw new Error(
      `slug collision: ${path.relative(REPO_ROOT, pdfDest)} already exists with different content, so ` +
        `${inputPath} was NOT added (a .pdf under raw/ is never overwritten). Rename one of the two files.`,
    );
  }
}

/** Copy the source PDF into raw/ if it isn't already there. Never overwrites. */
function ensurePdfInRaw(inputPath: string, pdfDest: string, alreadyInRaw: boolean): void {
  if (alreadyInRaw) return;
  assertRawRootSafe();
  fs.mkdirSync(path.dirname(pdfDest), { recursive: true });
  assertInsideRaw(pdfDest);
  if (existsNoFollow(pdfDest)) return; // already copied by a prior run — idempotent
  fs.copyFileSync(path.resolve(inputPath), pdfDest, fs.constants.COPYFILE_EXCL);
}

/** Process a single PDF end to end. Throws on hard failure; may also skip. */
function processOne(inputPath: string, topicArg: string, force: boolean): void {
  const { pdfDest, alreadyInRaw } = resolveDestination(inputPath, topicArg);
  const mdDest = pdfDest.replace(/\.pdf$/i, ".md");

  // Nothing under raw/ is read or statted before raw/ itself and the destination directory are proven to be
  // inside the repository: a symlinked raw/ or topic directory must not turn the skip path into a read oracle.
  assertRawRootSafe();
  if (existsNoFollow(path.dirname(pdfDest))) assertInsideRaw(pdfDest);

  // Collisions are checked before the skip, so a second source can never vanish silently.
  assertNoCollision(inputPath, pdfDest, alreadyInRaw);

  // A symlink at the .md path is never "already extracted", even a dangling one: refuse it loudly.
  if (existsNoFollow(mdDest) && fs.lstatSync(mdDest).isSymbolicLink()) {
    throw new Error(`refusing to write through a symlink: ${mdDest}`);
  }
  if (existsNoFollow(mdDest) && !fs.lstatSync(mdDest).isFile()) {
    throw new Error(`${mdDest} exists and is not a regular file`);
  }
  // An existing .md that was NOT produced from this PDF slug is a different source under the same name
  // (raw/ is immutable): never skip past it silently, never let --force replace it. A fresh clone of an
  // instance repo has the .md files but not the gitignored PDFs, so a matching "> Source:" line is fine.
  // Applies equally to a PDF dropped straight into raw/ (the documented flow): a hand-written .md beside it
  // is never skipped past and never replaced by --force.
  if (existsNoFollow(mdDest)) {
    const expected = path.relative(REPO_ROOT, pdfDest).split(path.sep).join("/");
    const recordedSource = headerSourceOf(fs.readFileSync(mdDest, "utf-8"));
    if (recordedSource !== expected) {
      throw new Error(
        `slug collision: ${path.relative(REPO_ROOT, mdDest)} already exists but was not extracted from ` +
          `${expected}, so ${inputPath} was NOT added and nothing was changed. Rename one of the two sources.`,
      );
    }
  }
  if (existsNoFollow(mdDest) && !force) {
    console.log(`skip (already extracted): ${path.relative(REPO_ROOT, mdDest)}`);
    return;
  }

  // Extract from the source first and copy into raw/ only after the OCR guard passes,
  // so a rejected image-only deck leaves nothing behind and its OCR'd replacement can reuse the name.
  const sourcePdf = path.resolve(inputPath);
  const { text, rawLength } = extractText(sourcePdf);
  if (rawLength < MIN_TEXT_LENGTH) {
    throw new Error(
      `extraction yielded only ${rawLength} characters of text (likely an image-only deck) — ` +
        `needs OCR before it can be added to raw/. Nothing was added for ${inputPath}.`,
    );
  }
  ensurePdfInRaw(inputPath, pdfDest, alreadyInRaw);

  const stem = path.basename(pdfDest, ".pdf");
  const info = readPdfInfo(sourcePdf);
  const title = info.title || titleFromSlug(stem);
  const sourceRelPath = path.relative(REPO_ROOT, pdfDest).split(path.sep).join("/");

  const markdown = buildMarkdown({
    title,
    sourceRelPath,
    collected: toIsoDate(new Date()),
    published: info.published || "Unknown",
    body: text,
  });

  assertRawRootSafe();
  fs.mkdirSync(path.dirname(mdDest), { recursive: true });
  assertInsideRaw(mdDest);
  // "wx" never follows or replaces an existing file; --force removes the old regular file first.
  if (force && existsNoFollow(mdDest)) fs.unlinkSync(mdDest);
  fs.writeFileSync(mdDest, markdown, { encoding: "utf-8", flag: "wx" });
  console.log(`extracted: ${path.relative(REPO_ROOT, mdDest)}`);
}

function main(): void {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    printUsage();
    process.exit(1);
  }

  if (!Bun.which("pdftotext")) {
    console.error(
      "error: pdftotext not found on PATH. Install poppler-utils (e.g. `apt install poppler-utils`).",
    );
    process.exit(1);
  }

  let pdfFiles: string[];
  try {
    pdfFiles = [...new Set(args.inputs.flatMap((input) => findPdfFiles(path.resolve(input))))];
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }

  if (pdfFiles.length === 0) {
    console.error(`no PDF files found under: ${args.inputs.join(", ")}`);
    process.exit(1);
  }

  let failures = 0;
  for (const pdfFile of pdfFiles) {
    try {
      processOne(pdfFile, args.topic, args.force);
    } catch (err) {
      failures++;
      console.error(`error: ${(err as Error).message}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} of ${pdfFiles.length} PDF(s) failed to extract.`);
    process.exit(1);
  }
}

main();
