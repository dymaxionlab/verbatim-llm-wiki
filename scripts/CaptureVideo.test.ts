// Tests for CaptureVideo.ts. The VTT parsing is a pure function, tested without any network. The CLI tests run the
// script inside a throwaway copy of the repo layout with a fake `yt-dlp` first on PATH (scripts/fixtures/fake-yt-dlp),
// so nothing outside the temp directory is touched and no site is contacted.
// Run: bun test scripts/
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatMarker, parseTimestamp, parseVtt, pickSubtitle, slugify, toIsoDate } from "./CaptureVideo.ts";

const SCRIPT = path.join(import.meta.dir, "CaptureVideo.ts");
const FIXTURES = path.join(import.meta.dir, "fixtures");
const AUTO_VTT = path.join(FIXTURES, "auto-captions.vtt");
const MANUAL_VTT = path.join(FIXTURES, "manual-captions.vtt");
const TODAY = toIsoDate(new Date());

describe("parseVtt", () => {
  test("removes YouTube rolling duplicates, strips <c> and timestamp tags, decodes entities", () => {
    const out = parseVtt(fs.readFileSync(AUTO_VTT, "utf-8"));
    expect(out).toBe(
      "<!-- t=00:26 -->\nthe ferrofluid spikes rise when the coil switches\n\n" +
        "<!-- t=00:30 -->\non and it's & done >> next part",
    );
    expect(out).not.toMatch(/<c|<\d\d:/);
  });

  test("each line of rolling text appears exactly once", () => {
    const out = parseVtt(fs.readFileSync(AUTO_VTT, "utf-8"));
    for (const phrase of ["the ferrofluid spikes rise", "when the coil switches", "on and it's & done"]) {
      expect(out.split(phrase).length - 1).toBe(1);
    }
  });

  test("a marker opens at the first text-bearing cue at or after each 30 s boundary, and shows that cue's own time", () => {
    const vtt = [
      "WEBVTT", "",
      "00:00:00.000 --> 00:00:02.000", "zero", "",
      "00:00:29.900 --> 00:00:31.000", "just before", "",
      "00:00:30.000 --> 00:00:31.000", "exactly on the boundary", "",
      "00:01:10.400 --> 00:01:12.000", "after a gap that skipped two boundaries", "",
      "00:01:11.000 --> 00:01:12.000", "same block", "",
    ].join("\n");
    expect(parseVtt(vtt, { rolling: false })).toBe(
      "<!-- t=00:00 -->\nzero just before\n\n" +
        "<!-- t=00:30 -->\nexactly on the boundary\n\n" +
        "<!-- t=01:10 -->\nafter a gap that skipped two boundaries same block",
    );
  });

  test("markers use H:MM:SS from one hour on, and hour-form timestamps parse", () => {
    expect(formatMarker(59.9)).toBe("<!-- t=00:59 -->");
    expect(formatMarker(3599)).toBe("<!-- t=59:59 -->");
    expect(formatMarker(3600)).toBe("<!-- t=1:00:00 -->");
    expect(formatMarker(3725.5)).toBe("<!-- t=1:02:05 -->");
    expect(formatMarker(36000)).toBe("<!-- t=10:00:00 -->");
    expect(parseTimestamp("01:02:05.250")).toBeCloseTo(3725.25);
    expect(parseTimestamp("02:05.250")).toBeCloseTo(125.25);
    expect(parseTimestamp("nonsense")).toBeNull();
    const vtt = "WEBVTT\n\n01:02:05.000 --> 01:02:07.000\nlate in the talk\n";
    expect(parseVtt(vtt)).toBe("<!-- t=1:02:05 -->\nlate in the talk");
  });

  test("a cue whose only lines were already shown contributes no text and no marker", () => {
    const vtt = [
      "WEBVTT", "",
      "00:00:10.000 --> 00:00:12.000", "alpha", "",
      "00:00:30.000 --> 00:00:30.010", "alpha", " ", "",
      "00:00:30.010 --> 00:00:33.000", "alpha", "beta", "",
    ].join("\n");
    expect(parseVtt(vtt)).toBe("<!-- t=00:10 -->\nalpha\n\n<!-- t=00:30 -->\nbeta");
  });

  test("manual captions keep a genuinely repeated line, skip NOTE/STYLE blocks, cue ids and <v> tags", () => {
    const out = parseVtt(fs.readFileSync(MANUAL_VTT, "utf-8"), { rolling: false });
    expect(out).toBe("<!-- t=00:01 -->\nDon’t touch the coil. No. No.\n\n<!-- t=00:41 -->\nIt “reaches” 80 °C.");
    expect(out).not.toContain("comment");
    expect(out).not.toContain("cue {");
    expect(out).not.toContain("intro");
    expect(out).not.toContain("Narrator");
  });

  test("curly quotes and apostrophes pass through untouched", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nShe said “it’s alive” and he said \"no\" and it's 5°\n";
    expect(parseVtt(vtt)).toBe(`<!-- t=00:01 -->\nShe said “it’s alive” and he said "no" and it's 5°`);
  });

  test("tolerates BOM, CRLF and comma decimals, and returns an empty string when there is no text", () => {
    expect(parseVtt("\uFEFFWEBVTT\r\n\r\n00:00:01,500 --> 00:00:02,000\r\nhello\r\n")).toBe("<!-- t=00:01 -->\nhello");
    expect(parseVtt("WEBVTT\n\n")).toBe("");
    expect(parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<c></c> \n")).toBe("");
  });
});

describe("pickSubtitle / slugify", () => {
  test("manual beats auto, exact language beats a variant", () => {
    expect(pickSubtitle(["cap.en.vtt", "cap.en-GB.vtt"], ["en-GB"], "en")).toEqual({ file: "cap.en-GB.vtt", lang: "en-GB", manual: true });
    expect(pickSubtitle(["cap.en-US.vtt", "cap.en.vtt"], [], "en")).toEqual({ file: "cap.en.vtt", lang: "en", manual: false });
    expect(pickSubtitle(["cap.en.vtt"], ["en"], "en")?.manual).toBe(true);
    expect(pickSubtitle([], ["en"], "en")).toBeNull();
  });

  test("slugify matches the sibling scripts", () => {
    expect(slugify("Ferrofluid: “Display” Build — Part 1!", 49)).toBe("ferrofluid-display-build-part-1");
  });
});

// ---------------------------------------------------------------------------------------------
// CLI, with a fake yt-dlp
// ---------------------------------------------------------------------------------------------

let work: string;
let binDir: string;
let outside: string;
let logFile: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "capturevideo-work-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "capturevideo-outside-"));
  binDir = path.join(work, "bin");
  logFile = path.join(work, "ytdlp-calls.log");
  fs.mkdirSync(path.join(work, "scripts"));
  fs.mkdirSync(binDir);
  fs.copyFileSync(SCRIPT, path.join(work, "scripts", "CaptureVideo.ts"));
  fs.copyFileSync(path.join(FIXTURES, "fake-yt-dlp"), path.join(binDir, "yt-dlp"));
  fs.chmodSync(path.join(binDir, "yt-dlp"), 0o755);
});
afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function info(extra: Record<string, unknown> = {}): string {
  const p = path.join(work, `info-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(
    p,
    JSON.stringify({
      id: "abc123", title: "Ferrofluid Speaker Build, Part 1", uploader: "Maker Channel", upload_date: "20230405",
      subtitles: {}, automatic_captions: { en: [{ ext: "vtt" }] }, ...extra,
    }),
  );
  return p;
}

function run(args: string[], env: Record<string, string> = {}, opts: { fakeOnPath?: boolean } = {}) {
  const proc = Bun.spawnSync([process.execPath, path.join(work, "scripts", "CaptureVideo.ts"), ...args], {
    cwd: work,
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: opts.fakeOnPath === false ? path.join(work, "empty-bin") : `${binDir}${path.delimiter}${process.env.PATH}`,
      FAKE_LOG: logFile,
      ...env,
    },
  });
  return { code: proc.exitCode, out: new TextDecoder().decode(proc.stdout), err: new TextDecoder().decode(proc.stderr) };
}

const URL1 = "https://video.example/watch?v=abc123";
const URL2 = "https://video.example/watch?v=zzz999";
const NAME = `${TODAY}-ferrofluid-speaker-build-part-1`;
const rawDir = (topic = "video") => path.join(work, "raw", topic);
const listRaw = (topic = "video") => (fs.existsSync(rawDir(topic)) ? fs.readdirSync(rawDir(topic)).sort() : []);
const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : []);

describe("CaptureVideo CLI", () => {
  test("auto captions: writes .md and a sibling .vtt with the full header, and passes the documented yt-dlp flags", () => {
    const r = run([URL1], { FAKE_INFO: info(), FAKE_VTT: AUTO_VTT });
    expect(r.code).toBe(0);
    expect(listRaw()).toEqual([`${NAME}.md`, `${NAME}.vtt`]);
    expect(fs.readFileSync(path.join(rawDir(), `${NAME}.vtt`), "utf-8")).toBe(fs.readFileSync(AUTO_VTT, "utf-8"));
    const md = fs.readFileSync(path.join(rawDir(), `${NAME}.md`), "utf-8");
    expect(
      md.startsWith(
        `# Ferrofluid Speaker Build, Part 1\n\n> Source: ${URL1}\n> Collected: ${TODAY}\n> Published: 2023-04-05\n> Captions: auto\n> Channel: Maker Channel\n\n`,
      ),
    ).toBe(true);
    expect(md).toContain("<!-- t=00:26 -->\nthe ferrofluid spikes rise when the coil switches");
    expect(md).toContain("<!-- t=00:30 -->\non and it's & done >> next part");
    expect(r.out).toContain("auto captions");

    expect(calls()).toHaveLength(1); // one yt-dlp run
    const argv = calls()[0];
    for (const flag of ["--skip-download", "--write-subs", "--write-auto-subs", "--no-simulate"]) expect(argv).toContain(flag);
    expect(argv[argv.indexOf("--sub-format") + 1]).toBe("vtt");
    expect(argv[argv.indexOf("--sub-langs") + 1]).toBe("en");
    expect(argv.slice(-2)).toEqual(["--", URL1]);
  });

  test("manual captions are labelled manual and kept verbatim, repeated lines included", () => {
    const r = run([URL1], { FAKE_INFO: info({ subtitles: { en: [{ ext: "vtt" }] } }), FAKE_VTT: MANUAL_VTT });
    expect(r.code).toBe(0);
    const md = fs.readFileSync(path.join(rawDir(), `${NAME}.md`), "utf-8");
    expect(md).toContain("> Captions: manual\n");
    expect(md).toContain("Don’t touch the coil. No. No.");
  });

  test("--lang and --topic are honoured", () => {
    const r = run([URL1, "--topic", "talks", "--lang", "de"], { FAKE_INFO: info({ automatic_captions: { de: [] } }), FAKE_VTT: AUTO_VTT, FAKE_VTT_LANG: "de" });
    expect(r.code).toBe(0);
    expect(listRaw("talks")).toEqual([`${NAME}.md`, `${NAME}.vtt`]);
    expect(calls()[0][calls()[0].indexOf("--sub-langs") + 1]).toBe("de");
  });

  test("a missing upload date records Published: Unknown, a missing uploader Channel: Unknown", () => {
    const r = run([URL1], { FAKE_INFO: info({ upload_date: undefined, uploader: undefined, channel: undefined }), FAKE_VTT: AUTO_VTT });
    expect(r.code).toBe(0);
    const md = fs.readFileSync(path.join(rawDir(), `${NAME}.md`), "utf-8");
    expect(md).toContain("> Published: Unknown\n");
    expect(md).toContain("> Channel: Unknown\n");
  });

  test("no subtitles in the language: refused with the available languages, nothing written, no fallback", () => {
    const r = run([URL1], { FAKE_INFO: info({ subtitles: { fr: [] }, automatic_captions: { es: [] } }) });
    expect(r.code).toBe(1);
    expect(r.err).toContain('no subtitles in language "en"');
    expect(r.err).toContain("fr");
    expect(r.err).toContain("es");
    expect(r.err).toContain("no fallback");
    expect(listRaw()).toEqual([]);
    expect(calls()).toHaveLength(1); // no second attempt of any kind
  });

  test("a caption file with no text is refused", () => {
    const empty = path.join(work, "empty.vtt");
    fs.writeFileSync(empty, "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<c></c>\n");
    const r = run([URL1], { FAKE_INFO: info(), FAKE_VTT: empty });
    expect(r.code).toBe(1);
    expect(r.err).toContain("contained no text");
    expect(listRaw()).toEqual([]);
  });

  test("re-running the same URL is an idempotent skip", () => {
    const env = { FAKE_INFO: info(), FAKE_VTT: AUTO_VTT };
    expect(run([URL1], env).code).toBe(0);
    const again = run([URL1], env);
    expect(again.code).toBe(0);
    expect(again.out).toContain("skip (already captured)");
    expect(listRaw()).toHaveLength(2);
  });

  test("a different video with the same title is a collision: nothing changes and --force does not override it", () => {
    const env = { FAKE_INFO: info(), FAKE_VTT: AUTO_VTT };
    expect(run([URL1], env).code).toBe(0);
    const mdBefore = fs.readFileSync(path.join(rawDir(), `${NAME}.md`));
    const vttBefore = fs.readFileSync(path.join(rawDir(), `${NAME}.vtt`));
    for (const extra of [[], ["--force"]]) {
      const r = run([URL2, ...extra], { ...env, FAKE_VTT: MANUAL_VTT });
      expect(r.code).toBe(1);
      expect(r.err).toContain("slug collision");
      expect(fs.readFileSync(path.join(rawDir(), `${NAME}.md`)).equals(mdBefore)).toBe(true);
      expect(fs.readFileSync(path.join(rawDir(), `${NAME}.vtt`)).equals(vttBefore)).toBe(true);
    }
  });

  test("--force re-captures the same URL, replacing both files", () => {
    expect(run([URL1], { FAKE_INFO: info(), FAKE_VTT: AUTO_VTT }).code).toBe(0);
    const env = { FAKE_INFO: info({ subtitles: { en: [] } }), FAKE_VTT: MANUAL_VTT };
    expect(run([URL1], env).out).toContain("skip");
    expect(run([URL1, "--force"], env).code).toBe(0);
    expect(fs.readFileSync(path.join(rawDir(), `${NAME}.md`), "utf-8")).toContain("> Captions: manual");
    expect(fs.readFileSync(path.join(rawDir(), `${NAME}.vtt`), "utf-8")).toBe(fs.readFileSync(MANUAL_VTT, "utf-8"));
  });

  test("an orphan .vtt with different bytes and no .md is a collision", () => {
    fs.mkdirSync(rawDir(), { recursive: true });
    fs.writeFileSync(path.join(rawDir(), `${NAME}.vtt`), "WEBVTT\n\nsomeone else's file\n");
    const r = run([URL1], { FAKE_INFO: info(), FAKE_VTT: AUTO_VTT });
    expect(r.code).toBe(1);
    expect(r.err).toContain("slug collision");
    expect(fs.existsSync(path.join(rawDir(), `${NAME}.md`))).toBe(false);
  });

  test("a yt-dlp failure surfaces its stderr and writes nothing", () => {
    const r = run([URL1], { FAKE_EXIT: "1", FAKE_STDERR: "ERROR: Video unavailable" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("yt-dlp failed");
    expect(r.err).toContain("Video unavailable");
    expect(listRaw()).toEqual([]);
  });

  test("yt-dlp missing from PATH is a clear error", () => {
    fs.mkdirSync(path.join(work, "empty-bin"));
    const r = run([URL1], {}, { fakeOnPath: false });
    expect(r.code).toBe(1);
    expect(r.err).toContain("yt-dlp not found on PATH");
  });

  test("argument errors: missing URL, bad scheme, bad topic, bad lang, unknown flag, second URL", () => {
    expect(run([]).code).toBe(1);
    expect(run(["ftp://x.example/v"]).err).toContain("http and https");
    expect(run([URL1, "--topic", "a/b"]).err).toContain("single directory name");
    expect(run([URL1, "--lang", "en,fr"]).err).toContain("one language code");
    expect(run([URL1, "--bogus"]).err).toContain("unknown flag");
    expect(run([URL1, URL2]).err).toContain("only one <url>");
    expect(calls()).toEqual([]); // yt-dlp was never invoked
  });

  test("a symlinked topic directory pointing outside raw/ is refused and nothing escapes", () => {
    fs.mkdirSync(path.join(work, "raw"));
    fs.symlinkSync(outside, path.join(work, "raw", "video"));
    const r = run([URL1], { FAKE_INFO: info(), FAKE_VTT: AUTO_VTT });
    expect(r.code).toBe(1);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test("a dangling symlink at the .md destination is refused", () => {
    fs.mkdirSync(rawDir(), { recursive: true });
    const target = path.join(outside, "stolen.md");
    fs.symlinkSync(target, path.join(rawDir(), `${NAME}.md`));
    const r = run([URL1], { FAKE_INFO: info(), FAKE_VTT: AUTO_VTT });
    expect(r.code).toBe(1);
    expect(r.err).toContain("symlink");
    expect(fs.existsSync(target)).toBe(false);
  });
});
