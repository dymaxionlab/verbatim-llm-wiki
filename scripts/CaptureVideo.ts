#!/usr/bin/env bun
/**
 * CaptureVideo.ts — Capture a video's captions into raw/<topic>/ for the karpathy-llm-wiki grounding invariant
 * (every wiki claim must be greppable in a raw/ markdown file). Uses yt-dlp for metadata and subtitles.
 *
 * Each capture gets two files under raw/<topic>/, named by CAPTURE date:
 *   <YYYY-MM-DD>-<slug>.md  — transcript text with the raw-template header plus Captions and Channel lines
 *   <YYYY-MM-DD>-<slug>.vtt — the original caption file, gitignored sidecar
 *
 * Usage:
 *   bun scripts/CaptureVideo.ts <url> [--topic video] [--lang en] [--force]
 *
 * Flags:
 *   --topic <topic>  Topic subdirectory under raw/ (default: video).
 *   --lang <code>    Caption language to capture (default: en).
 *   --force          Re-capture even if the target .md already exists (never past a collision).
 *
 * Manual captions are preferred over auto-generated ones when both exist. A video with no captions in the
 * requested language is refused: there is no fallback to speech recognition or anything else. Zero dependencies
 * beyond yt-dlp on PATH.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const RAW_ROOT = path.join(REPO_ROOT, "raw");
const DEFAULT_TOPIC = "video";
const DEFAULT_LANG = "en";
const MAX_BASENAME = 60; // date prefix + slug
const DATE_PREFIX_LEN = "YYYY-MM-DD-".length;
const MARKER_INTERVAL_SECONDS = 30;
const YTDLP_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------------------------
// Pure functions (exported for tests)
// ---------------------------------------------------------------------------------------------

/** kebab-case ASCII slug. Apostrophes are dropped (not turned into dashes), accents are folded. */
export function slugify(text: string, maxLen: number): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['‘’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, maxLen).replace(/-+$/g, "");
}

/** Local date (toISOString would roll evening timestamps to the next day). */
export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The `> Source:` value from the metadata header (the blockquote right after the first H1), or null. */
export function headerSourceOf(markdown: string): string | null {
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

function decodeCueEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "", rlm: "" };
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,6}));/g, (whole, dec, hex, name) => {
    if (dec !== undefined || hex !== undefined) {
      const cp = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "�";
    }
    return named[name] ?? whole;
  });
}

/** WebVTT timestamp ("HH:MM:SS.mmm" or "MM:SS.mmm", comma also accepted) to seconds, or null. */
export function parseTimestamp(ts: string): number | null {
  const m = ts.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
}

/** Marker text for a time: MM:SS below one hour, H:MM:SS from one hour up. Whole seconds, rounded down. */
export function formatMarker(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `<!-- t=${h}:${mm}:${ss} -->` : `<!-- t=${mm}:${ss} -->`;
}

interface Cue {
  start: number;
  lines: string[];
}

/** Cues with caption tags (<c>, <00:00:01.000>, <v Name>, <i>) removed, entities decoded, empty lines dropped. */
export function parseCues(vtt: string): Cue[] {
  const lines = vtt.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const cues: Cue[] = [];
  let current: Cue | null = null;
  let skipBlock = false; // inside a NOTE / STYLE / REGION block

  for (const line of lines) {
    // A truly empty line ends a cue. A line holding only a space is cue text: YouTube emits one inside rolling cues.
    if (line === "") {
      current = null;
      skipBlock = false;
      continue;
    }
    if (skipBlock) continue;
    const timing = line.match(/^(\S+)\s+-->\s+(\S+)/);
    if (timing) {
      const start = parseTimestamp(timing[1]);
      if (start === null) {
        current = null;
        continue;
      }
      current = { start, lines: [] };
      cues.push(current);
      continue;
    }
    if (current) {
      const cleaned = decodeCueEntities(line.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
      if (cleaned) current.lines.push(cleaned);
    } else if (/^(NOTE|STYLE|REGION)(\s|$)/.test(line)) {
      skipBlock = true;
    }
    // anything else outside a cue (WEBVTT header, Kind:/Language: lines, cue identifiers) is ignored
  }
  return cues;
}

/**
 * Caption text from a WebVTT file. Cue tags and timestamp tags are stripped. With `rolling` (the right setting
 * for YouTube auto-captions, which repeat each line across consecutive cues as the window rolls), a line that
 * was already in the previous cue is dropped. Manual captions should pass `rolling: false` so a genuinely
 * repeated line is kept. A `<!-- t=MM:SS -->` marker line (H:MM:SS from one hour) opens a new block at the first
 * cue that contributes text at or after each 30-second boundary; the marker shows that cue's own start time,
 * rounded down. Text within a block is one line. Returns "" when the file has no caption text.
 */
export function parseVtt(vtt: string, opts: { rolling?: boolean } = {}): string {
  const rolling = opts.rolling ?? true;
  const cues = parseCues(vtt);
  const blocks: { marker: string; words: string[] }[] = [];
  let nextBoundary = 0;
  let previous: string[] = [];

  for (const cue of cues) {
    const fresh = rolling ? cue.lines.filter((l) => !previous.includes(l)) : cue.lines;
    previous = cue.lines;
    if (fresh.length === 0) continue;
    if (blocks.length === 0 || cue.start >= nextBoundary) {
      blocks.push({ marker: formatMarker(cue.start), words: [] });
      nextBoundary = (Math.floor(cue.start / MARKER_INTERVAL_SECONDS) + 1) * MARKER_INTERVAL_SECONDS;
    }
    blocks[blocks.length - 1].words.push(...fresh);
  }
  return blocks.map((b) => `${b.marker}\n${b.words.join(" ")}`).join("\n\n");
}

/**
 * Choose which downloaded caption file to keep. Manual beats auto; then the exact requested language beats a
 * variant; then the name decides. `files` are names like `cap.en.vtt`; `manualLangs` are the video's manual
 * caption language keys from yt-dlp's metadata. Returns the file, its language and whether it is manual.
 */
export function pickSubtitle(
  files: string[],
  manualLangs: string[],
  requested: string,
): { file: string; lang: string; manual: boolean } | null {
  const candidates = files
    .map((file) => ({ file, lang: file.replace(/^cap\./, "").replace(/\.vtt$/, "") }))
    .map((c) => ({ ...c, manual: manualLangs.includes(c.lang) }));
  candidates.sort(
    (a, b) =>
      Number(b.manual) - Number(a.manual) ||
      Number(b.lang === requested) - Number(a.lang === requested) ||
      a.file.localeCompare(b.file),
  );
  return candidates[0] ?? null;
}

export function buildMarkdown(opts: {
  title: string;
  url: string;
  collected: string;
  published: string;
  captions: "manual" | "auto";
  channel: string;
  body: string;
}): string {
  const { title, url, collected, published, captions, channel, body } = opts;
  const cleaned =
    captions === "auto"
      ? "caption tags and rolling duplicate lines removed"
      : "caption tags removed";
  return (
    `# ${title}\n\n` +
    `> Source: ${url}\n` +
    `> Collected: ${collected}\n` +
    `> Published: ${published}\n` +
    `> Captions: ${captions}\n` +
    `> Channel: ${channel}\n\n` +
    `> Transcript from the video's ${captions === "auto" ? "auto-generated" : "manual"} captions via yt-dlp, ${cleaned} by CaptureVideo. ` +
    `Each \`<!-- t=MM:SS -->\` marker is the start time of the text that follows it. Speaker names, on-screen text and anything not spoken are not captured.\n\n` +
    `${body}\n`
  );
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

interface Args {
  url: string;
  topic: string;
  lang: string;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  let url: string | undefined;
  let topic = DEFAULT_TOPIC;
  let lang = DEFAULT_LANG;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--topic") {
      const value = argv[++i];
      if (!value) throw new Error("--topic requires a value");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes("..")) {
        throw new Error(`--topic must be a single directory name (letters, digits, . _ -), got: ${value}`);
      }
      topic = value;
    } else if (arg === "--lang") {
      const value = argv[++i];
      if (!value) throw new Error("--lang requires a value");
      if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(value)) {
        throw new Error(`--lang must be one language code such as en or pt-BR, got: ${value}`);
      }
      lang = value;
    } else if (arg === "--force") {
      force = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    } else if (url === undefined) {
      url = arg;
    } else {
      throw new Error(`only one <url> is accepted (got a second: ${arg})`);
    }
  }

  if (!url) throw new Error("missing required <url> argument");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`only http and https URLs can be captured, got: ${parsed.protocol}`);
  }
  return { url, topic, lang, force };
}

function printUsage(): void {
  console.error("Usage: bun scripts/CaptureVideo.ts <url> [--topic video] [--lang en] [--force]");
}

function existsNoFollow(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** raw/ itself must be a real directory inside the repository. Call BEFORE any mkdir. */
function assertRawRootSafe(): void {
  if (!existsNoFollow(RAW_ROOT)) return;
  if (fs.lstatSync(RAW_ROOT).isSymbolicLink()) {
    throw new Error(`refusing to write: ${RAW_ROOT} is a symlink, not a directory inside the repository`);
  }
  const rawReal = fs.realpathSync(RAW_ROOT);
  const repoReal = fs.realpathSync(REPO_ROOT);
  if (!rawReal.startsWith(repoReal + path.sep)) {
    throw new Error(`refusing to write: raw/ resolves to ${rawReal}, outside the repository`);
  }
}

/** Refuse a destination whose real directory is outside raw/ or whose final component is a symlink. */
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

const rel = (p: string) => path.relative(REPO_ROOT, p).split(path.sep).join("/");

function assertRegularIfPresent(p: string): void {
  if (!existsNoFollow(p)) return;
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${p}`);
  if (!st.isFile()) throw new Error(`${p} exists and is not a regular file`);
}

/**
 * Decide skip vs write for a target pair. Throws on a collision. An existing .md whose Source line names a
 * different URL is another source under the same name: never skipped past silently, never replaced, not even
 * by --force. A lone .vtt with different bytes and no .md is a collision too.
 */
function plan(mdDest: string, vttDest: string, url: string, force: boolean, vttBytes: Uint8Array): "skip" | "write" {
  if (existsNoFollow(path.dirname(mdDest))) {
    assertInsideRaw(mdDest);
    assertInsideRaw(vttDest);
  }
  assertRegularIfPresent(mdDest);
  assertRegularIfPresent(vttDest);

  if (existsNoFollow(mdDest)) {
    const recorded = headerSourceOf(fs.readFileSync(mdDest, "utf-8"));
    if (recorded !== url) {
      throw new Error(
        `slug collision: ${rel(mdDest)} already exists but its Source is ${recorded ?? "missing"}, not ${url}, so ` +
          `this video was NOT captured and nothing was changed. Rename or move the existing capture.`,
      );
    }
    return force ? "write" : "skip";
  }
  if (existsNoFollow(vttDest) && !fs.readFileSync(vttDest).equals(vttBytes)) {
    throw new Error(
      `slug collision: ${rel(vttDest)} already exists with different content and no matching .md, so this ` +
        `video was NOT captured. Rename or remove the orphan .vtt.`,
    );
  }
  return "write";
}

interface VideoInfo {
  title?: string;
  uploader?: string;
  channel?: string;
  upload_date?: string;
  id?: string;
  subtitles?: Record<string, unknown>;
  automatic_captions?: Record<string, unknown>;
}

function parseInfoJson(stdout: string): VideoInfo {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) throw new Error("yt-dlp printed no metadata JSON.");
  try {
    return JSON.parse(line) as VideoInfo;
  } catch (err) {
    throw new Error(`yt-dlp metadata was not valid JSON: ${(err as Error).message}`);
  }
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

  const ytdlp = Bun.which("yt-dlp");
  if (!ytdlp) {
    console.error("error: yt-dlp not found on PATH. Install it (e.g. `uv tool install yt-dlp`).");
    process.exit(1);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "capturevideo-"));
  try {
    assertRawRootSafe();

    // One yt-dlp run: metadata JSON on stdout, caption files into tmp. No video is downloaded.
    const proc = Bun.spawnSync(
      [
        ytdlp, "--dump-single-json", "--no-simulate", "--skip-download", "--no-playlist",
        "--write-subs", "--write-auto-subs", "--sub-format", "vtt", "--sub-langs", args.lang,
        "-o", path.join(tmp, "cap.%(ext)s"), "--", args.url,
      ],
      { timeout: YTDLP_TIMEOUT_MS },
    );
    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    if (!proc.success) {
      const tail = stderr.split("\n").slice(-6).join("\n");
      throw new Error(`yt-dlp failed (exit ${proc.exitCode ?? "killed by timeout"}) for ${args.url}:\n${tail}\nNothing was written.`);
    }
    const info = parseInfoJson(stdout);

    if (!info.subtitles && !info.automatic_captions) {
      throw new Error("yt-dlp metadata lists no caption fields, so manual and auto captions cannot be told apart. Nothing was written.");
    }
    const manualLangs = Object.keys(info.subtitles ?? {});
    const autoLangs = Object.keys(info.automatic_captions ?? {});
    const files = fs.readdirSync(tmp).filter((f) => /^cap\..+\.vtt$/.test(f));
    const chosen = pickSubtitle(files, manualLangs, args.lang);
    if (!chosen) {
      const show = (langs: string[]) => (langs.length ? langs.slice(0, 12).join(", ") + (langs.length > 12 ? ", ..." : "") : "none");
      throw new Error(
        `no subtitles in language "${args.lang}" for ${args.url}. Manual caption languages: ${show(manualLangs)}. ` +
          `Auto-caption languages: ${show(autoLangs)}. Nothing was written; there is no fallback to transcription.`,
      );
    }

    const vttBytes = new Uint8Array(fs.readFileSync(path.join(tmp, chosen.file)));
    const captions = chosen.manual ? "manual" : "auto";
    const body = parseVtt(new TextDecoder().decode(vttBytes), { rolling: !chosen.manual });
    if (!body) throw new Error(`the ${captions} caption file for ${args.url} contained no text. Nothing was written.`);

    const title = (info.title ?? "").replace(/\s+/g, " ").trim() || info.id || "untitled-video";
    const slug = slugify(title, MAX_BASENAME - DATE_PREFIX_LEN) || slugify(info.id ?? "", MAX_BASENAME - DATE_PREFIX_LEN);
    if (!slug) throw new Error(`could not build a slug from the title "${title}". Nothing was written.`);
    const today = toIsoDate(new Date());
    const dir = path.join(RAW_ROOT, args.topic);
    const mdDest = path.join(dir, `${today}-${slug}.md`);
    const vttDest = path.join(dir, `${today}-${slug}.vtt`);

    if (plan(mdDest, vttDest, args.url, args.force, vttBytes) === "skip") {
      console.log(`skip (already captured): ${rel(mdDest)}`);
      return;
    }

    const upload = info.upload_date?.match(/^(\d{4})(\d{2})(\d{2})$/);
    const markdown = buildMarkdown({
      title,
      url: args.url,
      collected: today,
      published: upload ? `${upload[1]}-${upload[2]}-${upload[3]}` : "Unknown",
      captions,
      channel: (info.uploader ?? info.channel ?? "").replace(/\s+/g, " ").trim() || "Unknown",
      body,
    });

    assertRawRootSafe();
    fs.mkdirSync(dir, { recursive: true });
    assertInsideRaw(vttDest);
    assertInsideRaw(mdDest);
    // "wx" never follows or replaces an existing file; --force removes the old regular files first.
    if (existsNoFollow(vttDest) && !fs.readFileSync(vttDest).equals(vttBytes)) fs.unlinkSync(vttDest);
    if (!existsNoFollow(vttDest)) fs.writeFileSync(vttDest, vttBytes, { flag: "wx" });
    if (existsNoFollow(mdDest)) fs.unlinkSync(mdDest); // only reachable with --force and a matching Source
    fs.writeFileSync(mdDest, markdown, { encoding: "utf-8", flag: "wx" });
    console.log(`captured: ${rel(mdDest)} (${captions} captions, language ${chosen.lang})`);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
