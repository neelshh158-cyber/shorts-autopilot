// Today's trending searches in India from Google Trends' public RSS feed.
// No key needed. Returns [] on any failure so a run never dies on this.
import { log } from "./log.mjs";

const FEED = "https://trends.google.com/trending/rss?geo=IN";

// Trends we never build a video around: tragedies, crime, and topics that
// get Shorts age-restricted or demonetised.
const BLOCKED = /\b(death|dies|died|dead|killed|murder|rape|suicide|accident|crash|terror|bomb|blast|shooting|riot|war|porn|sex|nude|leak(ed)?|mms|viral video|molest|assault|funeral|rip)\b|मौत|निधन|हत्या|बलात्कार|आत्महत्या|हादसा|दुर्घटना/i;

const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();

/** Parses the RSS text into [{ title, traffic, news }] in feed order. Pure, for tests. */
export function parseTrendsRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const title = decode(/<title>([\s\S]*?)<\/title>/.exec(block)?.[1] || "");
    if (!title) continue;
    const traffic = decode(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/.exec(block)?.[1] || "");
    const news = [...block.matchAll(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/g)].map((x) => decode(x[1])).slice(0, 2);
    items.push({ title, traffic, news });
  }
  return items;
}

export function filterTrends(items) {
  return items.filter((t) => !BLOCKED.test(`${t.title} ${t.news.join(" ")}`));
}

export async function fetchTrendingIndia({ limit = 15 } = {}) {
  try {
    const res = await fetch(FEED, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const all = parseTrendsRss(await res.text());
    const ok = filterTrends(all).slice(0, limit);
    log(`trends: ${all.length} trending in India, ${ok.length} usable`);
    return ok;
  } catch (e) {
    log(`trends unavailable: ${e.message}`);
    return [];
  }
}

/** Formats trends as seed lines for the script prompt. */
export function trendsAsSeeds(trends) {
  return trends.map((t) => `${t.title}${t.traffic ? ` (${t.traffic} searches)` : ""}${t.news.length ? ` — in the news: ${t.news.join(" / ")}` : ""}`);
}
