#!/usr/bin/env bun
/**
 * CaptureWeb.ts — Capture a web page into raw/<topic>/ for the karpathy-llm-wiki
 * grounding invariant (every wiki claim must be greppable in a raw/ markdown file).
 *
 * Each capture gets two files under raw/<topic>/, named by CAPTURE date:
 *   <YYYY-MM-DD>-<slug>.html — the original bytes as fetched (or as supplied), gitignored sidecar
 *   <YYYY-MM-DD>-<slug>.md   — readable text with the raw-template metadata header (the verified layer)
 *
 * Usage:
 *   bun scripts/CaptureWeb.ts <url> [--slug <s>] [--from-html <file>] [--topic web] [--force]
 *
 * Flags:
 *   --slug <s>         Slug for the file name (default: kebab-cased <title>). The date prefix and slug
 *                      together never exceed 60 characters.
 *   --from-html <file> Read the HTML from a saved file instead of fetching. For JS-rendered pages fetched by
 *                      another tool. <url> is still required: it is recorded as the Source.
 *   --topic <topic>    Topic subdirectory under raw/ (default: web).
 *   --force            Re-capture even if the target .md already exists (never past a collision).
 *
 * The URL is fetched exactly once: no retry loop, no crawling. Zero dependencies.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const RAW_ROOT = path.join(REPO_ROOT, "raw");
const DEFAULT_TOPIC = "web";
const MAX_BASENAME = 60; // date prefix + slug
const DATE_PREFIX_LEN = "YYYY-MM-DD-".length;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_BYTES = 20 * 1024 * 1024;
const MIN_TEXT_LENGTH = 40;
const USER_AGENT = "CaptureWeb/1.0 (personal wiki capture script; single fetch)";

// ---------------------------------------------------------------------------------------------
// Pure functions (exported for tests)
// ---------------------------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", sbquo: "‚", bdquo: "„", laquo: "«", raquo: "»",
  lsaquo: "‹", rsaquo: "›", uarr: "↑", darr: "↓", harr: "↔", rArr: "⇒",
  minus: "−", le: "≤", ge: "≥", ne: "≠", asymp: "≈", infin: "∞", frasl: "⁄",
  iexcl: "¡", iquest: "¿", Eacute: "É", Agrave: "À", Ccedil: "Ç", Ntilde: "Ñ",
  scaron: "š", Scaron: "Š", ccaron: "č", Ccaron: "Č", zcaron: "ž", Zcaron: "Ž",
  copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", times: "×",
  divide: "÷", middot: "·", bull: "•", micro: "µ", para: "¶", sect: "§",
  frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³",
  euro: "€", pound: "£", yen: "¥", cent: "¢", prime: "′", Prime: "″",
  omega: "ω", Omega: "Ω", mu: "μ", ohm: "Ω", rarr: "→", larr: "←",
  eacute: "é", egrave: "è", ecirc: "ê", aacute: "á", agrave: "à", acirc: "â",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü",
  szlig: "ß", ntilde: "ñ", ccedil: "ç", oacute: "ó", iacute: "í", uacute: "ú",
  aring: "å", oslash: "ø", aelig: "æ", zwj: "‍", zwnj: "‌", shy: "­",
  thinsp: " ", ensp: " ", emsp: " ",
};

// HTML maps numeric references 128-159 to Windows-1252 characters (e.g. &#146; is a right single quote).
const CP1252: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡",
  0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž",
  0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};

function codePointToString(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
  return CP1252[cp] ?? String.fromCodePoint(cp);
}

/** Decode HTML entities in ONE pass, so "&amp;lt;" becomes "&lt;" and never "<". Unknown names stay as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (whole, dec, hex, name) => {
    if (dec !== undefined) return codePointToString(parseInt(dec, 10));
    if (hex !== undefined) return codePointToString(parseInt(hex, 16));
    return NAMED_ENTITIES[name] ?? whole;
  });
}

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

/** Parse the attributes of a tag's attribute string. Names are lowercased; values are entity-decoded. */
export function parseAttrs(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=\/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrString))) {
    const name = m[1].toLowerCase();
    if (name in attrs) continue; // first occurrence wins, as in HTML
    attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function* tagsOf(html: string, tagName: string): Generator<Record<string, string>> {
  const re = new RegExp(`<${tagName}\\b((?:"[^"]*"|'[^']*'|[^>"'])*)>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) yield parseAttrs(m[1]);
}

function isoDatePrefix(value: string | undefined): string | null {
  const m = value?.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/);
  return m ? m[1] : null;
}

function jsonLdPublished(html: string): string | null {
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    const found = findDatePublished(data);
    if (found) return found;
  }
  return null;
}

function findDatePublished(node: unknown, depth = 0): string | null {
  if (depth > 6 || node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const f = findDatePublished(item, depth + 1);
      if (f) return f;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const direct = isoDatePrefix(typeof obj.datePublished === "string" ? obj.datePublished : undefined);
  if (direct) return direct;
  return findDatePublished(obj["@graph"], depth + 1);
}

/**
 * The page's own publication date as YYYY-MM-DD, or null. Order: meta article:published_time,
 * itemprop=datePublished (meta content or time datetime), JSON-LD datePublished, first <time datetime>.
 * Only ISO-style dates are read: a human-written date ("March 3") is never guessed into a number.
 */
export function extractPublished(html: string): string | null {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const a of tagsOf(noComments, "meta")) {
    const key = (a.property ?? a.name ?? "").toLowerCase();
    if (key === "article:published_time" || key === "og:article:published_time") {
      const d = isoDatePrefix(a.content);
      if (d) return d;
    }
  }
  for (const tag of ["meta", "time", "span", "div", "p"]) {
    for (const a of tagsOf(noComments, tag)) {
      if ((a.itemprop ?? "").toLowerCase() === "datepublished") {
        const d = isoDatePrefix(tag === "meta" ? a.content : a.datetime ?? a.content);
        if (d) return d;
      }
    }
  }
  const ld = jsonLdPublished(noComments);
  if (ld) return ld;
  for (const a of tagsOf(noComments, "time")) {
    const d = isoDatePrefix(a.datetime);
    if (d) return d;
  }
  return null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

/** Page title: <title>, else og:title, else the first <h1>. Entity-decoded, whitespace-collapsed. */
export function extractTitle(html: string): string | null {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const clean = (s: string) => decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();
  const t = noComments.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (t && clean(t[1])) return clean(t[1]);
  for (const a of tagsOf(noComments, "meta")) {
    if ((a.property ?? "").toLowerCase() === "og:title" && a.content?.trim()) return a.content.replace(/\s+/g, " ").trim();
  }
  const h = noComments.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i);
  if (h && clean(h[1])) return clean(h[1]);
  return null;
}

const MAX_AUTHORS = 10;

function cleanName(s: string): string {
  return decodeEntities(stripTags(s)).replace(/\s+/g, " ").replace(/^\s*by\s+/i, "").trim();
}

function authorNamesFromJsonLd(node: unknown, out: string[], depth = 0): void {
  if (depth > 6 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) authorNamesFromJsonLd(item, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const add = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === "object" && typeof (v as Record<string, unknown>).name === "string") out.push((v as Record<string, string>).name);
  };
  add(obj.author);
  authorNamesFromJsonLd(obj["@graph"], out, depth + 1);
}

/**
 * The article's author names, or null. First source that yields any wins (sources are never merged): meta author /
 * citation_author / dc.creator / a non-URL article:author, JSON-LD `author`, itemprop=author, then rel=author links and
 * byline elements inside the page's first <article> (else the whole page, since a related-posts card is its own
 * <article> that comes later). Names are decoded, de-duplicated, at most 10, and never URLs or e-mail addresses.
 */
export function extractAuthors(html: string): string | null {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const unique = (names: string[]): string | null => {
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const raw of names) {
      const n = cleanName(raw);
      if (!n || n.length > 100 || /^(?:https?:|mailto:|www\.)/i.test(n) || n.includes("@") || /^[\W\d_]+$/.test(n)) continue;
      if (seen.has(n.toLowerCase())) continue;
      seen.add(n.toLowerCase());
      kept.push(n);
      if (kept.length >= MAX_AUTHORS) break;
    }
    return kept.length ? kept.join(", ") : null;
  };

  const metas: string[] = [];
  for (const a of tagsOf(noComments, "meta")) {
    const key = (a.name ?? a.property ?? "").toLowerCase();
    if (["author", "citation_author", "dc.creator", "dcterms.creator", "article:author"].includes(key) && a.content) metas.push(a.content);
  }
  const fromMeta = unique(metas);
  if (fromMeta) return fromMeta;

  const ld: string[] = [];
  const ldRe = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = ldRe.exec(noComments))) {
    try {
      authorNamesFromJsonLd(JSON.parse(lm[1]), ld);
    } catch {
      /* not JSON: ignore */
    }
  }
  const fromLd = unique(ld);
  if (fromLd) return fromLd;

  // itemprop=author: a content attribute, else the text up to the first closing tag of the same name (a nested
  // <span itemprop="name"> inside the author span is read through).
  const item: string[] = [];
  const lower = noComments.toLowerCase();
  const openRe = /<([a-z][a-z0-9]*)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
  let om: RegExpExecArray | null;
  while ((om = openRe.exec(noComments))) {
    const a = parseAttrs(om[2]);
    if (!(a.itemprop ?? "").toLowerCase().split(/\s+/).includes("author")) continue;
    if (a.content) {
      item.push(a.content);
      continue;
    }
    const close = lower.indexOf(`</${om[1].toLowerCase()}`, openRe.lastIndex);
    if (close >= 0) item.push(noComments.slice(openRe.lastIndex, close));
  }
  const fromItem = unique(item);
  if (fromItem) return fromItem;

  const start = noComments.search(/<article\b/i);
  let scope = noComments;
  if (start >= 0) {
    const end = noComments.search(/<\/article\s*>/i);
    scope = noComments.slice(start, end > start ? end : undefined);
  }
  const linked: string[] = [];
  const aRe = /<a\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/a\s*>/gi;
  let am: RegExpExecArray | null;
  while ((am = aRe.exec(scope))) {
    if ((parseAttrs(am[1]).rel ?? "").toLowerCase().split(/\s+/).includes("author")) linked.push(am[2]);
  }
  return unique(linked);
}

const SKIP_CONTENT = new Set(["nav", "header", "footer", "head", "template"]);

// A page-level <header>/<footer> is chrome, but an article's own <header> and <footer> hold its byline, reference list,
// footnotes and author box (some article pages keep all of them in <header class="article-header"> and
// <footer class="article-footer">). Inside a dropped header or footer, an element that names itself as one of these
// is rescued and its content kept, but only when that header or footer sits inside an <article> or <main> (a page-level
// footer is never rescued); everything else in the header or footer, and any nested nav, is still dropped.
const RESCUE_HOSTS = new Set(["header", "footer"]);
const RESCUE_TOKEN_RE = /(?:^|[-_])(?:byline|authors?|authorinfo|references?|footnotes?|endnotes?|bibliography)(?:$|[-_])/i;

/** True when an element's class or id names a byline, author box, reference list or footnote list, or it is rel/itemprop author. */
export function isRescuedElement(attrString: string): boolean {
  const a = parseAttrs(attrString);
  if ((a.itemprop ?? "").toLowerCase().split(/\s+/).includes("author")) return true;
  if ((a.rel ?? "").toLowerCase().split(/\s+/).includes("author")) return true;
  return [...(a.class ?? "").split(/\s+/), a.id ?? ""].some((t) => t && RESCUE_TOKEN_RE.test(t));
}
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const BLOCKS = new Set([
  "p", "div", "section", "article", "main", "aside", "blockquote", "ul", "ol", "dl", "dt", "dd", "table",
  "thead", "tbody", "tfoot", "pre", "figure", "figcaption", "form", "fieldset", "details", "summary",
  "address", "hr", "caption", "body", "html",
]);

/**
 * HTML to readable text. Drops script/style/nav/header/footer/noscript/svg (and head, template); headings become
 * markdown "#"; list items, paragraphs and table rows each get their own line, table cells joined with " | ";
 * entities are decoded; whitespace is collapsed. Quote and apostrophe characters are never normalized.
 */
export function htmlToText(html: string): string {
  let src = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!\s*doctype[^>]*>/gi, "")
    .replace(/<\?[\s\S]*?\?>/g, "");

  const out: string[] = [];
  // Skipped regions, innermost last. A "keep" frame is a rescued element inside a skipped header or footer.
  // inArticle: the skipped element sits inside an <article> or <main>, i.e. it is that article's own header or footer.
  const frames: { keep: boolean; name: string; depth: number; inArticle?: boolean }[] = [];
  let sectioning = 0; // open <article>/<main> elements outside any skipped region
  const skipping = () => frames.length > 0 && !frames[frames.length - 1].keep;
  let inPre = 0;
  let flat = 0; // inside a heading or table cell: line breaks become spaces
  let cells = 0; // cells already emitted in the current row
  let listDepth = 0; // inside a list, paragraph breaks collapse to single line breaks so a bullet stays one block

  // Structural breaks are private marker characters, collapsed at the end: a run holding a paragraph break
  // (\u0002) becomes a blank line, any other run a single newline. That keeps list items and table rows adjacent
  // while still separating paragraphs, whatever whitespace the source put between the tags.
  const brk = (n: 1 | 2) => out.push(flat > 0 ? " " : n === 2 && listDepth === 0 ? "\u0002" : "\u0001");

  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const emitText = (raw: string) => {
    if (skipping() || !raw) return;
    const decoded = decodeEntities(raw).replace(/[\u0001\u0002]/g, ""); // never let source text forge a break marker
    out.push(inPre > 0 ? decoded : decoded.replace(/\s+/g, " "));
  };

  while ((m = tagRe.exec(src))) {
    emitText(src.slice(last, m.index));
    last = tagRe.lastIndex;
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    const selfClosing = m[3].trimEnd().endsWith("/");

    const top = frames[frames.length - 1];
    let rescuedHere = false;
    if (top && !top.keep) {
      if (name === top.name && !selfClosing) {
        top.depth += closing ? -1 : 1;
        if (top.depth === 0) frames.pop();
        continue;
      }
      if (!closing && !selfClosing && RESCUE_HOSTS.has(top.name) && top.inArticle && isRescuedElement(m[3])) {
        frames.push({ keep: true, name, depth: 1 });
        rescuedHere = true; // processed below as an ordinary tag, even if it is itself a <header> or <footer>
      } else continue;
    } else if (top && top.keep && !rescuedHere) {
      const below = frames[frames.length - 2];
      if (closing && below && name === below.name && name !== top.name) {
        // the host closes while a rescued element is still open (unbalanced markup): leave both
        frames.pop();
        if (--below.depth === 0) frames.pop();
        continue;
      }
      if (name === top.name && !selfClosing) {
        top.depth += closing ? -1 : 1;
        if (top.depth === 0) frames.pop();
      }
    }
    if (SKIP_CONTENT.has(name) && !rescuedHere) {
      if (!closing && !selfClosing) frames.push({ keep: false, name, depth: 1, inArticle: sectioning > 0 });
      continue;
    }
    if (name === "article" || name === "main") sectioning = closing ? Math.max(0, sectioning - 1) : sectioning + 1;

    if (HEADINGS.has(name)) {
      if (!closing) {
        brk(2);
        out.push("#".repeat(Number(name[1])) + " ");
        flat++;
      } else {
        flat = Math.max(0, flat - 1);
        brk(2);
      }
    } else if (name === "li") {
      if (!closing) {
        if (flat > 0) out.push(" ");
        else out.push("\u0001- ");
      }
    } else if (name === "tr") {
      if (!closing) cells = 0;
      brk(1);
    } else if (name === "td" || name === "th") {
      if (!closing) {
        if (cells > 0) out.push(" | ");
        cells++;
        flat++;
      } else flat = Math.max(0, flat - 1);
    } else if (name === "br") {
      brk(1);
    } else if (name === "pre") {
      inPre = closing ? Math.max(0, inPre - 1) : inPre + 1;
      brk(2);
    } else if (name === "ul" || name === "ol") {
      if (!closing) {
        brk(2);
        listDepth++;
      } else {
        listDepth = Math.max(0, listDepth - 1);
        brk(2);
      }
    } else if (name === "table") {
      brk(2);
    } else if (BLOCKS.has(name)) {
      brk(closing || name === "p" ? 2 : 1);
    }
  }
  emitText(src.slice(last));

  const lines = out
    .join("")
    .replace(/\r/g, "")
    .replace(/[ \t]*[\u0001\u0002](?:[ \t]*[\u0001\u0002])*[ \t]*/g, (run) => (run.includes("\u0002") ? "\n\n" : "\n"))
    .split("\n")
    .map((l) => l.replace(/[ \t  -   　]+/g, " ").trim());
  return lines
    .join("\n")
    .replace(/^-\n+(?!- )(?=[^\n])/gm, "- ") // <li><p>text</p></li> would otherwise leave an empty bullet
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Decode fetched or saved HTML bytes: charset from the Content-Type header, else a <meta> sniff, else UTF-8. */
export function decodeHtmlBytes(bytes: Uint8Array, contentType?: string | null): string {
  let charset = contentType?.match(/charset\s*=\s*["']?([\w.:-]+)/i)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
    charset =
      head.match(/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i)?.[1] ??
      head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset=([\w.:-]+)/i)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function buildMarkdown(opts: {
  title: string;
  url: string;
  collected: string;
  published: string;
  author?: string | null;
  text: string;
  fromHtml: boolean;
}): string {
  const { title, url, collected, published, author, text, fromHtml } = opts;
  const note = fromHtml
    ? "Text extracted from a saved HTML file via CaptureWeb HTML-to-text; formatting is approximate. Images, scripts and navigation are not captured."
    : "Text extracted from the fetched HTML via CaptureWeb HTML-to-text; formatting is approximate. Images, scripts and navigation are not captured.";
  return (
    `# ${title}\n\n` +
    `> Source: ${url}\n` +
    `> Collected: ${collected}\n` +
    `> Published: ${published}\n` +
    (author ? `> Author: ${author}\n` : "") +
    `\n> ${note}\n\n` +
    `${text}\n`
  );
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

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

interface Args {
  url: string;
  slug?: string;
  fromHtml?: string;
  topic: string;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  let url: string | undefined;
  let slug: string | undefined;
  let fromHtml: string | undefined;
  let topic = DEFAULT_TOPIC;
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
    } else if (arg === "--slug") {
      const value = argv[++i];
      if (!value) throw new Error("--slug requires a value");
      if (!slugify(value, 200)) throw new Error(`--slug has no letters or digits to build a name from: ${value}`);
      slug = value;
    } else if (arg === "--from-html") {
      const value = argv[++i];
      if (!value) throw new Error("--from-html requires a file path");
      fromHtml = value;
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
  return { url, slug, fromHtml, topic, force };
}

function printUsage(): void {
  console.error("Usage: bun scripts/CaptureWeb.ts <url> [--slug <s>] [--from-html <file>] [--topic web] [--force]");
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

/** Refuse anything at p that is not a plain regular file (symlink, FIFO, directory). Never reads it. */
function assertRegularIfPresent(p: string): void {
  if (!existsNoFollow(p)) return;
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${p}`);
  if (!st.isFile()) throw new Error(`${p} exists and is not a regular file`);
}

/**
 * Decide skip vs write for a target pair. Throws on a collision. An existing .md whose Source line names a
 * different URL is another source under the same name: never skipped past silently, never replaced, not even
 * by --force. `htmlBytes` is null before the fetch, when only the .md can be judged.
 */
function plan(
  mdDest: string,
  htmlDest: string,
  url: string,
  force: boolean,
  htmlBytes: Uint8Array | null,
): "skip" | "write" {
  if (existsNoFollow(path.dirname(mdDest))) {
    assertInsideRaw(mdDest);
    assertInsideRaw(htmlDest);
  }
  assertRegularIfPresent(mdDest);
  assertRegularIfPresent(htmlDest);

  if (existsNoFollow(mdDest)) {
    const recorded = headerSourceOf(fs.readFileSync(mdDest, "utf-8"));
    if (recorded !== url) {
      throw new Error(
        `slug collision: ${rel(mdDest)} already exists but its Source is ${recorded ?? "missing"}, not ${url}, so ` +
          `this URL was NOT captured and nothing was changed. Pass a different --slug.`,
      );
    }
    return force ? "write" : "skip";
  }
  // No .md. A lone .html is an orphan of a half-finished run or another source: identical bytes may resume,
  // different bytes are a collision (the sidecar is never overwritten without a matching .md to vouch for it).
  if (htmlBytes && existsNoFollow(htmlDest) && !fs.readFileSync(htmlDest).equals(htmlBytes)) {
    throw new Error(
      `slug collision: ${rel(htmlDest)} already exists with different content and no matching .md, so this ` +
        `URL was NOT captured. Pass a different --slug, or remove the orphan .html.`,
    );
  }
  return "write";
}

async function fetchOnce(url: string): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
    });
  } catch (err) {
    throw new Error(`fetch failed for ${url}: ${(err as Error).message}. Nothing was written (no retry was made).`);
  }
  if (!res.ok) {
    throw new Error(`fetch failed for ${url}: HTTP ${res.status} ${res.statusText}. Nothing was written.`);
  }
  const contentType = res.headers.get("content-type");
  if (contentType && !/html|xml/i.test(contentType)) {
    throw new Error(`${url} is ${contentType}, not HTML. Nothing was written (use ExtractPdf.ts for PDFs).`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error(`${url} is larger than ${MAX_BYTES} bytes. Nothing was written.`);
  return { bytes, contentType };
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    printUsage();
    process.exit(1);
  }

  try {
    assertRawRootSafe();
    const today = toIsoDate(new Date());
    const dir = path.join(RAW_ROOT, args.topic);
    const baseFor = (slug: string) => `${today}-${slugify(slug, MAX_BASENAME - DATE_PREFIX_LEN)}`;
    const dests = (base: string) => ({ md: path.join(dir, `${base}.md`), html: path.join(dir, `${base}.html`) });

    // With an explicit --slug the target is known before the network, so a re-run skips (or collides) without a fetch.
    if (args.slug) {
      const d = dests(baseFor(args.slug));
      if (plan(d.md, d.html, args.url, args.force, null) === "skip") {
        console.log(`skip (already captured): ${rel(d.md)}`);
        return;
      }
    }

    let bytes: Uint8Array;
    let contentType: string | null = null;
    if (args.fromHtml) {
      const st = fs.statSync(args.fromHtml, { throwIfNoEntry: false });
      if (!st || !st.isFile()) throw new Error(`--from-html is not a readable file: ${args.fromHtml}`);
      bytes = new Uint8Array(fs.readFileSync(args.fromHtml));
    } else {
      ({ bytes, contentType } = await fetchOnce(args.url));
    }

    const html = decodeHtmlBytes(bytes, contentType);
    const title = extractTitle(html);
    const slugSource = args.slug ?? title ?? (() => {
      const u = new URL(args.url);
      return `${u.hostname}${u.pathname}`;
    })();
    const base = baseFor(slugSource);
    if (base.length <= DATE_PREFIX_LEN) throw new Error(`could not build a slug from: ${slugSource}. Pass --slug.`);
    const d = dests(base);

    if (plan(d.md, d.html, args.url, args.force, bytes) === "skip") {
      console.log(`skip (already captured): ${rel(d.md)}`);
      return;
    }

    const text = htmlToText(html);
    if (text.length < MIN_TEXT_LENGTH) {
      throw new Error(
        `extraction yielded only ${text.length} characters of text (a JS-rendered page, or a block page?). ` +
          `Fetch the rendered HTML with another tool and pass it with --from-html. Nothing was written.`,
      );
    }

    const markdown = buildMarkdown({
      title: title ?? slugSource,
      url: args.url,
      collected: today,
      published: extractPublished(html) ?? "Unknown",
      author: extractAuthors(html),
      text,
      fromHtml: Boolean(args.fromHtml),
    });

    assertRawRootSafe();
    fs.mkdirSync(dir, { recursive: true });
    assertInsideRaw(d.html);
    assertInsideRaw(d.md);
    // "wx" never follows or replaces an existing file; --force removes the old regular files first.
    if (existsNoFollow(d.html) && !fs.readFileSync(d.html).equals(bytes)) fs.unlinkSync(d.html);
    if (!existsNoFollow(d.html)) fs.writeFileSync(d.html, bytes, { flag: "wx" });
    if (existsNoFollow(d.md)) fs.unlinkSync(d.md); // only reachable with --force and a matching Source
    fs.writeFileSync(d.md, markdown, { encoding: "utf-8", flag: "wx" });
    console.log(`captured: ${rel(d.md)}`);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
