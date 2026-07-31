// Web tools — DuckDuckGo search with no API key + page fetch/read.

import { num, obj, registerTool, str } from "./index.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
/** Without this a slow host hangs the whole agent turn indefinitely. */
const FETCH_TIMEOUT_MS = 20_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeDdgUrl(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
  } catch {}
  return href;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function ddgSearch(query: string, maxResults = 8): Promise<SearchResult[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
  const html = await res.text();
  const results: SearchResult[] = [];
  const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/g;
  const links: { href: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && links.length < maxResults) {
    links.push({ href: decodeDdgUrl(m[1]), title: stripTags(m[2]) });
  }
  const snippets: string[] = [];
  while ((m = snipRe.exec(html)) && snippets.length < maxResults) {
    snippets.push(stripTags(m[1] ?? m[2] ?? ""));
  }
  for (let i = 0; i < links.length; i++) {
    results.push({ title: links[i].title, url: links[i].href, snippet: snippets[i] ?? "" });
  }
  return results;
}

export function htmlToText(html: string, maxChars: number): string {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ");
  t = stripTags(t);
  t = t.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
  return t.length > maxChars ? t.slice(0, maxChars) + `\n… (truncated at ${maxChars} chars)` : t;
}

registerTool({
  subagentOk: true,
  schema: {
    name: "web_search",
    description: "Search the web via DuckDuckGo — no API key needed. Returns titles, URLs, snippets.",
    parameters: obj({
      query: str("Search query"),
      max_results: num("Max results (default 8)"),
    }, ["query"]),
  },
  async run(args) {
    const results = await ddgSearch(String(args.query), Math.min(20, Number(args.max_results ?? 8)));
    if (!results.length) return "No results found.";
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
  },
});

registerTool({
  subagentOk: true,
  schema: {
    name: "web_open",
    description: "Fetch a URL and return readable text (scripts/styles stripped).",
    parameters: obj({
      url: str("URL to fetch"),
      max_chars: num("Max characters to return (default 8000)"),
    }, ["url"]),
  },
  async run(args, rt) {
    const url = String(args.url);
    const maxChars = Math.min(50_000, Number(args.max_chars ?? 8000));
    const ok = await rt.permissions.check({ kind: "fetch", label: `Fetch ${url.slice(0, 80)}` });
    if (!ok) return "Denied by user.";
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return `Error: HTTP ${res.status}`;
    const ct = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (ct.includes("html")) return htmlToText(text, maxChars);
    return text.length > maxChars ? text.slice(0, maxChars) + `\n… (truncated)` : text;
  },
});
