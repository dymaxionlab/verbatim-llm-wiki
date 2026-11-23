// Tests for CaptureWeb.ts. The pure functions are imported directly. The CLI tests run the script inside a
// throwaway copy of the repo layout (scripts/ + raw/), against a local HTTP server, so nothing outside the temp
// directory is touched and no real site is contacted.
// Run: bun test scripts/
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decodeEntities, extractAuthors, extractPublished, extractTitle, headerSourceOf, htmlToText, slugify, toIsoDate } from "./CaptureWeb.ts";

const SCRIPT = path.join(import.meta.dir, "CaptureWeb.ts");
const FIXTURE = path.join(import.meta.dir, "fixtures", "ferrofluid-page.html");
const FIXTURE_HTML = fs.readFileSync(FIXTURE, "utf-8");
const TODAY = toIsoDate(new Date());

describe("htmlToText", () => {
  const text = htmlToText(FIXTURE_HTML);

  test("drops script, style, nav, header, footer, noscript, svg and head", () => {
    for (const gone of [
      "not content", "color: red", "Menu item", "Example Gallery", "Home", "Copyright footer", "Please enable JavaScript",
      "icon title", "Spike Wall &", "datePublished",
    ]) {
      expect(text).not.toContain(gone);
    }
  });

  test("keeps headings as markdown, list items, paragraphs and table rows with cells joined by ' | '", () => {
    expect(text).toContain("# Spike Wall\n");
    expect(text).toContain("## Bill of materials");
    expect(text).toContain("- Neodymium magnets, N52\n- Paragraph in a list item\n- Arduino Mega <2560>");
    expect(text).toContain("Part | Qty\nCoil | 48\nH-bridge driver | | 6");
  });

  test("decodes named, decimal and hex entities, once", () => {
    expect(text).toContain("48 coils & a “ferrofluid” reservoir");
    expect(text).toContain("12 V"); // &nbsp; collapses to a space
    expect(text).toContain("&lt; stays literal"); // &amp;lt; is decoded one level only
    expect(text).toContain("&bogus; stays too"); // an unknown name is left as written
    expect(decodeEntities("&#150; &#x1F9F2; &#0; &#99999999;")).toBe("– \u{1F9F2} � �");
    // Breadcrumb titles use single guillemets; a missing name leaks "rsaquo" into the file slug.
    expect(decodeEntities("A &rsaquo; B &lsaquo; C")).toBe("A › B ‹ C");
    expect(slugify(decodeEntities("KONTEJNER &rsaquo; Projects"), 60)).toBe("kontejner-projects");
  });

  test("preserves curly and straight quote and apostrophe characters exactly", () => {
    expect(text).toContain("It’s driven"); // from &rsquo;
    expect(text).toContain("we don’t hide the wiring"); // from &#x2019;
    expect(text).toContain("‘single’"); // from &#8216; and &#8217;
    expect(text).toContain("“kept as is” and it’s fine"); // literal curly characters in the source
    expect(text).toContain(`Straight: "plain" and it's fine.`); // literal straight characters stay straight
  });

  test("collapses source line wrapping inside a paragraph into one line", () => {
    expect(text).toContain("reservoir. It’s driven at 12 V; the artist said");
  });
});

describe("extractTitle / extractPublished / slugify", () => {
  test("title is decoded and keeps curly quotes", () => {
    expect(extractTitle(FIXTURE_HTML)).toBe(`Spike Wall & the Artist’s "Pulse" Series | Example Gallery`);
    expect(extractTitle("<html><body><h1> Only  H1 </h1></body></html>")).toBe("Only H1");
    expect(extractTitle("<p>no title</p>")).toBeNull();
  });

  test("published: meta article:published_time wins over JSON-LD", () => {
    expect(extractPublished(FIXTURE_HTML)).toBe("2021-03-14");
  });

  test("published: itemprop, JSON-LD and <time datetime> fallbacks, in that order", () => {
    expect(extractPublished(`<meta itemprop="datePublished" content="2019-07-01"><time datetime="2020-01-01">x</time>`)).toBe("2019-07-01");
    expect(extractPublished(`<time datetime="2020-01-01">x</time><script type="application/ld+json">{"datePublished":"2018-02-03T10:00:00Z"}</script>`)).toBe("2018-02-03");
    expect(extractPublished(`<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"datePublished":"2017-05-06"}]}</script>`)).toBe("2017-05-06");
    expect(extractPublished(`<p>x</p><time datetime="2020-01-01T08:00">x</time>`)).toBe("2020-01-01");
  });

  test("published: absent or human-written dates give null, never a guess", () => {
    expect(extractPublished("<p>nothing</p>")).toBeNull();
    expect(extractPublished(`<meta property="article:published_time" content="March 3, 2021">`)).toBeNull();
    expect(extractPublished(`<!-- <meta property="article:published_time" content="2021-03-03"> -->`)).toBeNull();
  });

  test("slugify folds accents, drops apostrophes and respects the length cap", () => {
    expect(slugify("Rosensweig’s Spike — Café Ünder", 49)).toBe("rosensweigs-spike-cafe-under");
    expect(slugify("a".repeat(80), 49)).toHaveLength(49);
    expect(slugify("word ".repeat(30), 49).endsWith("-")).toBe(false);
    expect(slugify("!!!", 49)).toBe("");
  });

  test("headerSourceOf reads only the header blockquote", () => {
    expect(headerSourceOf("# T\n\n> Source: https://a.example/x\n> Collected: 2026-01-01\n\nbody\n> Source: https://b.example\n")).toBe("https://a.example/x");
    expect(headerSourceOf("# T\n\nbody\n\n> Source: https://b.example\n")).toBeNull();
  });
});

describe("article byline, references, footnotes and author box inside header/footer", () => {
  const ARTICLE_HTML = fs.readFileSync(path.join(import.meta.dir, "fixtures", "article-byline-references.html"), "utf-8");
  const text = htmlToText(ARTICLE_HTML);

  test("keeps the byline from the article header", () => {
    expect(text).toContain("By Ada Lovelace and Ben Franklin");
  });

  test("keeps the reference list, footnotes and author box from the article footer", () => {
    expect(text).toContain("References");
    expect(text).toContain("1. Smith, J. The interfacial stability of a ferromagnetic fluid. J. Fluid Mech. (1967).");
    expect(text).toContain("2. Jones, K. Pulsating ferrofluid art. Nikkei Science (2007).");
    expect(text).toContain("Footnotes");
    expect(text).toContain('1With a researcher as the leader, some artists propose "device art".');
    expect(text).toContain("About the Author");
    expect(text).toContain("Ada Lovelace is a professor in Tokyo.");
    expect(text).toContain("The tower uses one electromagnet and an iron core [1].");
  });

  test("still drops everything else in headers and footers, page-level and article-level", () => {
    for (const gone of [
      "Site Masthead", "Site tagline", "Home", "Research and Advances", "Posted", "Share on Twitter", "Download PDF",
      "Share on Reddit", "Join the Discussion", "Subscribe to our newsletter", "Copyright colophon", "Authors directory link",
    ]) {
      expect(text).not.toContain(gone);
    }
  });

  test("a nav inside a rescued element is still dropped, and the host's own nav is not rescued", () => {
    const html = `<article><footer><div class="article-references"><nav>jump to top</nav><p>1. Ref one</p></div><div class="share"><p>share us</p></div></footer><p>body text stays</p></article>`;
    const t = htmlToText(html);
    expect(t).toContain("1. Ref one");
    expect(t).toContain("body text stays");
    expect(t).not.toContain("jump to top");
    expect(t).not.toContain("share us");
  });

  test("unbalanced markup inside a rescued element cannot leak the rest of the footer or page", () => {
    const html = `<article><footer><div class="references"><div><p>Ref kept<div>more ref</div></div></footer><p>after the footer</p><footer><p>second footer chrome</p></footer></article>`;
    const t = htmlToText(html);
    expect(t).toContain("Ref kept");
    expect(t).toContain("after the footer");
    expect(t).not.toContain("second footer chrome");
  });

  test("a footer with no rescuable element is dropped whole, as before", () => {
    expect(htmlToText(`<p>keep me please</p><footer><p>Authors directory</p><span class="share-authors-links">x</span></footer>`)).toBe("keep me please");
  });
});

describe("extractAuthors", () => {
  test("meta author wins, and several are listed in order without duplicates", () => {
    expect(extractAuthors(`<meta name="author" content="Ada Lovelace"><meta name="citation_author" content="Ben Franklin"><meta name="author" content="ada lovelace">`)).toBe("Ada Lovelace, Ben Franklin");
    expect(extractAuthors(`<meta property="article:author" content="https://example.org/ada">`)).toBeNull(); // a URL is not a name
  });

  test("JSON-LD author as a string, an object, a list, or inside @graph", () => {
    const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
    expect(extractAuthors(ld({ "@type": "Article", author: "Ada Lovelace" }))).toBe("Ada Lovelace");
    expect(extractAuthors(ld({ author: { "@type": "Person", name: "Ben Franklin", url: "x" } }))).toBe("Ben Franklin");
    expect(extractAuthors(ld({ "@graph": [{ "@type": "WebSite" }, { "@type": "Article", author: [{ name: "A One" }, { name: "B Two" }] }] }))).toBe("A One, B Two");
  });

  test("itemprop=author on a meta or an element", () => {
    expect(extractAuthors(`<meta itemprop="author" content="Ada Lovelace">`)).toBe("Ada Lovelace");
    expect(extractAuthors(`<p>By <span itemprop="author"><span itemprop="name">Ben Franklin</span></span></p>`)).toBe("Ben Franklin");
  });

  test("rel=author links count only inside the first <article>, so a related-posts card is never an author", () => {
    const html = fs.readFileSync(path.join(import.meta.dir, "fixtures", "article-byline-references.html"), "utf-8");
    expect(extractAuthors(html)).toBe("Ada Lovelace, Ben Franklin");
    expect(extractAuthors(`<a rel="author" href="/a">By Zed Zed</a>`)).toBe("Zed Zed"); // no <article>: whole page
  });

  test("returns null when there is no byline, and never a URL or an e-mail address", () => {
    expect(extractAuthors(FIXTURE_HTML)).toBeNull();
    expect(extractAuthors(`<meta name="author" content="mailto:x@example.org"><meta name="author" content="a@b.org"><meta name="author" content="123">`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const PAGE_FOR =(title: string, body = "The coil array is driven by a half-bridge at twelve volts and nothing else.") =>
  `<html><head><title>${title}</title><meta property="article:published_time" content="2022-08-09"></head>` +
  `<body><h1>${title}</h1><p>${body}</p></body></html>`;

let server: ReturnType<typeof Bun.serve>;
let requests: string[] = [];
let base: string;
let work: string;
let outside: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      requests.push(u.pathname);
      if (u.pathname === "/fixture") return new Response(FIXTURE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (u.pathname === "/a") return new Response(PAGE_FOR("Page A"), { headers: { "content-type": "text/html" } });
      if (u.pathname === "/a-changed") return new Response(PAGE_FOR("Page A", "A different body that still has plenty of readable text in it."), { headers: { "content-type": "text/html" } });
      if (u.pathname === "/b") return new Response(PAGE_FOR("Page A", "Another page with the same title but a different source address, text text."), { headers: { "content-type": "text/html" } });
      if (u.pathname === "/long") return new Response(PAGE_FOR("A very long title ".repeat(10)), { headers: { "content-type": "text/html" } });
      if (u.pathname === "/shell") return new Response(`<html><head><title>App</title></head><body><div id="root"></div><script>render()</script></body></html>`, { headers: { "content-type": "text/html" } });
      if (u.pathname === "/pdf") return new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } });
      return new Response("nope", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

beforeEach(() => {
  requests = [];
  work = fs.mkdtempSync(path.join(os.tmpdir(), "captureweb-work-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "captureweb-outside-"));
  fs.mkdirSync(path.join(work, "scripts"));
  fs.copyFileSync(SCRIPT, path.join(work, "scripts", "CaptureWeb.ts"));
});
afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

// Async spawn: the test process hosts the HTTP server, so a blocking spawnSync would deadlock the fetch.
async function run(args: string[]) {
  const proc = Bun.spawn(["bun", path.join(work, "scripts", "CaptureWeb.ts"), ...args], { cwd: work, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), 30_000);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { code, out, err };
}

const rawDir = (topic = "web") => path.join(work, "raw", topic);
const listRaw = (topic = "web") => (fs.existsSync(rawDir(topic)) ? fs.readdirSync(rawDir(topic)).sort() : []);

describe("CaptureWeb CLI", () => {
  test("fetches once and writes the .html original and the .md with the raw-template header", async () => {
    const r = await run([`${base}/fixture`]);
    expect(r.code).toBe(0);
    expect(requests).toEqual(["/fixture"]); // exactly one request: no retry, no crawl
    const name = `${TODAY}-spike-wall-the-artists-pulse-series-example-gallery`.slice(0, 60).replace(/-+$/, "");
    expect(listRaw()).toEqual([`${name}.html`, `${name}.md`]);
    expect(name.length).toBeLessThanOrEqual(60);
    expect(fs.readFileSync(path.join(rawDir(), `${name}.html`), "utf-8")).toBe(FIXTURE_HTML);
    const md = fs.readFileSync(path.join(rawDir(), `${name}.md`), "utf-8");
    expect(md.startsWith(`# Spike Wall & the Artist’s "Pulse" Series | Example Gallery\n\n> Source: ${base}/fixture\n> Collected: ${TODAY}\n> Published: 2021-03-14\n\n`)).toBe(true);
    expect(md).toContain("CaptureWeb HTML-to-text");
    expect(md).toContain("we don’t hide the wiring");
    expect(md).not.toContain("Copyright footer");
  });

  test("a page with a byline gets a `> Author:` header line and keeps its references; one without gets no Author line", async () => {
    const article = path.join(import.meta.dir, "fixtures", "article-byline-references.html");
    expect((await run([`${base}/article`, "--from-html", article, "--slug", "article"])).code).toBe(0);
    const md = fs.readFileSync(path.join(rawDir(), `${TODAY}-article.md`), "utf-8");
    expect(md.startsWith(`# Spike Tower: Notes on a Ferrofluid Sculpture\n\n> Source: ${base}/article\n> Collected: ${TODAY}\n> Published: 2008-06-01\n> Author: Ada Lovelace, Ben Franklin\n\n> Text extracted`)).toBe(true);
    expect(md).toContain("2. Jones, K. Pulsating ferrofluid art. Nikkei Science (2007).");
    expect(headerSourceOf(md)).toBe(`${base}/article`); // the extra header line does not disturb the Source reader
    expect((await run([`${base}/fixture`, "--slug", "plain"])).code).toBe(0);
    expect(fs.readFileSync(path.join(rawDir(), `${TODAY}-plain.md`), "utf-8")).not.toContain("> Author:");
  });

  test("a page with no date meta records Published: Unknown", async () => {
    const r = await run([`${base}/shell`, "--from-html", FIXTURE]);
    expect(r.code).toBe(0); // --from-html supplies the content; the URL is only the Source
    expect(requests).toEqual([]); // nothing fetched
    const md = fs.readFileSync(path.join(rawDir(), listRaw().find((f) => f.endsWith(".md"))!), "utf-8");
    expect(md).toContain(`> Source: ${base}/shell\n`);
    expect(md).toContain("> Published: 2021-03-14"); // the supplied HTML's own date
    expect(md).toContain("saved HTML file");
    const bare = path.join(work, "bare.html");
    fs.writeFileSync(bare, PAGE_FOR("Undated").replace(/<meta[^>]*>/, ""));
    expect((await run([`${base}/undated`, "--from-html", bare])).code).toBe(0);
    const undated = fs.readFileSync(path.join(rawDir(), `${TODAY}-undated.md`), "utf-8");
    expect(undated).toContain("> Published: Unknown");
  });

  test("--slug names the file and a re-run skips without any request", async () => {
    expect((await run([`${base}/a`, "--slug", "page-a"])).code).toBe(0);
    expect(requests).toEqual(["/a"]);
    expect(listRaw()).toEqual([`${TODAY}-page-a.html`, `${TODAY}-page-a.md`]);
    const again = await run([`${base}/a`, "--slug", "page-a"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("skip (already captured)");
    expect(requests).toEqual(["/a"]); // still one
  });

  test("without --slug a same-day re-run is also an idempotent skip", async () => {
    expect((await run([`${base}/a`])).code).toBe(0);
    const again = await run([`${base}/a`]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("skip (already captured)");
    expect(listRaw()).toHaveLength(2);
  });

  test("date prefix plus slug never exceeds 60 characters", async () => {
    expect((await run([`${base}/long`])).code).toBe(0);
    const names = listRaw();
    expect(names).toHaveLength(2);
    for (const n of names) expect(n.replace(/\.(md|html)$/, "").length).toBeLessThanOrEqual(60);
    expect((await run([`${base}/a`, "--slug", "x".repeat(100), "--topic", "t2"])).code).toBe(0);
    for (const n of listRaw("t2")) expect(n.replace(/\.(md|html)$/, "").length).toBeLessThanOrEqual(60);
  });

  test("a different URL under an existing slug is a collision: nothing changes, and --force does not override it", async () => {
    expect((await run([`${base}/a`, "--slug", "shared"])).code).toBe(0);
    const mdPath = path.join(rawDir(), `${TODAY}-shared.md`);
    const htmlPath = path.join(rawDir(), `${TODAY}-shared.html`);
    const mdBefore = fs.readFileSync(mdPath);
    const htmlBefore = fs.readFileSync(htmlPath);
    for (const extra of [[], ["--force"]]) {
      requests = [];
      const r = await run([`${base}/b`, "--slug", "shared", ...extra]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("slug collision");
      expect(requests).toEqual([]); // refused before the network
      expect(fs.readFileSync(mdPath).equals(mdBefore)).toBe(true);
      expect(fs.readFileSync(htmlPath).equals(htmlBefore)).toBe(true);
    }
  });

  test("a title-derived collision (same title, different URL) is also refused after the fetch", async () => {
    expect((await run([`${base}/a`])).code).toBe(0);
    const r = await run([`${base}/b`]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("slug collision");
    expect(listRaw()).toHaveLength(2);
  });

  test("--force re-captures the same URL and replaces both files", async () => {
    expect((await run([`${base}/a`, "--slug", "p"])).code).toBe(0);
    // Same Source URL, changed content: simulate by supplying different saved HTML for the same URL.
    const saved = path.join(work, "new.html");
    fs.writeFileSync(saved, PAGE_FOR("Page A", "Brand new body text that is certainly long enough to count here."));
    expect((await run([`${base}/a`, "--slug", "p", "--from-html", saved])).out).toContain("skip");
    const r = await run([`${base}/a`, "--slug", "p", "--from-html", saved, "--force"]);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(rawDir(), `${TODAY}-p.md`), "utf-8")).toContain("Brand new body text");
    expect(fs.readFileSync(path.join(rawDir(), `${TODAY}-p.html`), "utf-8")).toContain("Brand new body text");
  });

  test("an orphan .html with different bytes and no .md is a collision", async () => {
    fs.mkdirSync(rawDir(), { recursive: true });
    fs.writeFileSync(path.join(rawDir(), `${TODAY}-orphan.html`), "<html>someone else's file</html>");
    const r = await run([`${base}/a`, "--slug", "orphan"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("slug collision");
    expect(fs.existsSync(path.join(rawDir(), `${TODAY}-orphan.md`))).toBe(false);
    expect(fs.readFileSync(path.join(rawDir(), `${TODAY}-orphan.html`), "utf-8")).toBe("<html>someone else's file</html>");
  });

  test("HTTP errors, non-HTML and thin pages write nothing and exit non-zero with a clear message", async () => {
    const missing = await run([`${base}/missing`]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("HTTP 404");
    expect(requests).toEqual(["/missing"]); // one attempt only
    const pdf = await run([`${base}/pdf`]);
    expect(pdf.code).toBe(1);
    expect(pdf.err).toContain("not HTML");
    const shell = await run([`${base}/shell`]);
    expect(shell.code).toBe(1);
    expect(shell.err).toContain("--from-html");
    const dead = await run(["http://127.0.0.1:1/never"]);
    expect(dead.code).toBe(1);
    expect(dead.err).toContain("fetch failed");
    expect(listRaw()).toEqual([]);
  });

  test("argument errors: missing URL, bad scheme, bad topic, unknown flag, second URL, missing --from-html file", async () => {
    expect((await run([])).code).toBe(1);
    expect((await run(["file:///etc/passwd"])).err).toContain("http and https");
    expect((await run([`${base}/a`, "--topic", "../x"])).err).toContain("single directory name");
    expect((await run([`${base}/a`, "--bogus"])).err).toContain("unknown flag");
    expect((await run([`${base}/a`, `${base}/b`])).err).toContain("only one <url>");
    expect((await run([`${base}/a`, "--from-html", path.join(work, "nope.html")])).err).toContain("not a readable file");
    expect(requests).toEqual([]);
  });

  test("a dangling symlink at the .md destination is refused and nothing is written outside", async () => {
    fs.mkdirSync(rawDir(), { recursive: true });
    const target = path.join(outside, "stolen.md");
    fs.symlinkSync(target, path.join(rawDir(), `${TODAY}-evil.md`));
    const r = await run([`${base}/a`, "--slug", "evil"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("symlink");
    expect(fs.existsSync(target)).toBe(false);
  });

  test("a symlinked topic directory pointing outside raw/ is refused", async () => {
    fs.mkdirSync(path.join(work, "raw"));
    fs.symlinkSync(outside, path.join(work, "raw", "web"));
    const r = await run([`${base}/a`, "--slug", "p"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("outside raw/");
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
