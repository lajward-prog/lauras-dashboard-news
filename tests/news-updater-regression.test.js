#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const {
  parsePinalCentral,
  parseRss,
  publicScript,
  selectNews,
} = require("../scripts/update-news.js");

const now = new Date("2026-08-11T15:00:00.000Z");
const rss = `<?xml version="1.0"?><rss><channel>
  <item><title>Federal Reserve changes interest rate guidance</title><link>https://example.com/national-1</link><pubDate>Tue, 11 Aug 2026 13:00:00 GMT</pubDate><description>Economy update.</description></item>
  <item><title>Major public health recall announced</title><link>https://example.com/national-2</link><pubDate>Tue, 11 Aug 2026 12:00:00 GMT</pubDate></item>
  <item><title>Sports scores for Tuesday</title><link>https://example.com/sports</link><pubDate>Tue, 11 Aug 2026 14:00:00 GMT</pubDate></item>
</channel></rss>`;
const pinalHtml = `<script type="application/ld+json">{"@type":"NewsArticle","headline":"Casa Grande council approves water project","url":"https://www.pinalcentral.com/casa_grande_dispatch/water/article_123.html","datePublished":"2026-08-11T10:00:00Z","description":"A local utility project."}</script>`;

const national = parseRss(rss, { section: "national", sourceName: "NPR" });
const local = parsePinalCentral(pinalHtml);
assert.equal(national.length, 3);
assert.equal(local.length, 1);
assert.equal(local[0].locality, "Casa Grande");

const encodedMarkupRss = `<?xml version="1.0"?><rss><channel><item>
  <title>Casa Grande public meeting update</title>
  <link>https://example.com/local-markup</link>
  <pubDate>Tue, 11 Aug 2026 13:00:00 GMT</pubDate>
  <description>&lt;a href=&quot;https://example.com&quot;&gt;Source&lt;/a&gt; Clean summary text.</description>
</item></channel></rss>`;
const encodedMarkup = parseRss(encodedMarkupRss, { section: "local", sourceName: "PinalCentral" });
assert.equal(encodedMarkup[0].summary, "Source Clean summary text.", "Encoded HTML must not leak into public summaries.");

const world = Array.from({ length: 5 }, (_, index) => ({
  section: "world",
  headline: `International peace agreement update ${index}`,
  url: `https://example.com/world-${index}`,
  sourceName: "BBC News",
  publishedAt: new Date(now.getTime() - index * 3600000).toISOString(),
  sourceOrder: index,
}));
const previousPayload = {
  items: [{
    id: "stable-local-id", section: "local", headline: local[0].headline, sourceName: "PinalCentral",
    status: "active", priority: "normal", addedAt: "2026-08-10T12:00:00Z", url: local[0].url,
  }],
};
const payload = selectNews([...local, ...national, ...world], previousPayload, now);

assert.equal(payload.items.find((item) => item.url === local[0].url).id, "stable-local-id", "IDs must remain stable across refreshes.");
assert.ok(payload.items.some((item) => item.url.endsWith("national-1")));
assert.ok(payload.items.some((item) => item.url.endsWith("national-2")));
assert.ok(payload.items.findIndex((item) => item.url.endsWith("sports")) > payload.items.findIndex((item) => item.url.endsWith("national-1")), "Low-value topics must rank below significant news.");
assert.equal(payload.items.filter((item) => item.section === "world").length, 5, "Reserve candidates must remain available.");

const oldPayload = selectNews([{
  section: "world", headline: "Old story", url: "https://example.com/old", sourceName: "BBC News",
  publishedAt: "2026-08-07T00:00:00Z",
}], { items: [] }, now);
assert.equal(oldPayload.items.length, 0, "Items older than 72 hours must be excluded.");

assert.doesNotMatch(publicScript(payload), /<script/i, "Public wrapper must escape markup-bearing payload text.");
console.log("News updater regression tests passed.");
