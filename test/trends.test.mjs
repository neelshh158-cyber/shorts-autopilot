import test from "node:test";
import assert from "node:assert/strict";
import { parseTrendsRss, filterTrends, trendsAsSeeds } from "../src/trends.mjs";

const xml = `<rss><channel>
<item><title>IND vs AUS</title><ht:approx_traffic>500,000+</ht:approx_traffic><ht:news_item_title>India beat Australia &amp; take series</ht:news_item_title></item>
<item><title><![CDATA[Diwali 2026]]></title><ht:approx_traffic>200,000+</ht:approx_traffic></item>
<item><title>Highway accident</title><ht:approx_traffic>100,000+</ht:approx_traffic><ht:news_item_title>Five killed in crash</ht:news_item_title></item>
</channel></rss>`;

test("parseTrendsRss reads titles, traffic and news", () => {
  const items = parseTrendsRss(xml);
  assert.equal(items.length, 3);
  assert.equal(items[0].title, "IND vs AUS");
  assert.equal(items[0].news[0], "India beat Australia & take series");
  assert.equal(items[1].title, "Diwali 2026");
});

test("filterTrends drops tragedies", () => {
  const ok = filterTrends(parseTrendsRss(xml));
  assert.deepEqual(ok.map((t) => t.title), ["IND vs AUS", "Diwali 2026"]);
  assert.ok(trendsAsSeeds(ok)[0].includes("500,000+"));
});
