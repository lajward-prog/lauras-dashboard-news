#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RETENTION_MS = 72 * 60 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 20000;
const DEFAULT_OUTPUT = path.join(__dirname, "..", "data", "news-items.json");
const DEFAULT_SCRIPT_OUTPUT = path.join(__dirname, "..", "data", "remote-news-items.js");
const PINALCENTRAL_URL = "https://www.pinalcentral.com/";
const PINALCENTRAL_DISCOVERY_RSS = "https://news.google.com/rss/search?q=site%3Apinalcentral.com&hl=en-US&gl=US&ceid=US%3Aen";
const NPR_NATIONAL_RSS = "https://feeds.npr.org/1003/rss.xml";
const BBC_WORLD_RSS = "https://feeds.bbci.co.uk/news/world/rss.xml";
const SECTION_RESERVE_LIMITS = { local: 10, national: 8, world: 8 };
const EXCLUDED_TOPICS = /\b(sports?|football|basketball|baseball|soccer|golf|celebrity|entertainment|recipe|lottery|horoscope)\b/i;
const LOCAL_NON_NEWS = /^(printing services|classifieds|subscribe|contact us|e-editions?|advertising|obituaries)$/i;
const IMPORTANT_TOPICS = [
  /\b(breaking|emergency|warning|evacuat|wildfire|flood|storm|earthquake|heat)\b/i,
  /\b(congress|supreme court|white house|president|federal reserve|election|government)\b/i,
  /\b(war|ceasefire|invasion|missile|nuclear|sanction|hostage|peace agreement)\b/i,
  /\b(economy|inflation|jobs?|unemployment|interest rate|recession|tariff|market)\b/i,
  /\b(fda|cdc|outbreak|vaccine|public health|recall|cyber|security|privacy)\b/i,
];
const LOCAL_TOPICS = [
  /\b(casa grande|pinal|coolidge|florence|maricopa|stanfield|elo[y]?|arizona city)\b/i,
  /\b(city council|county|planning|development|road|school|police|fire|utility|water)\b/i,
];

function decodeEntities(value = "") {
  const decoded = String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)));

  return decoded
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeHttpUrl(value, baseUrl = null) {
  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
    return /^https?:$/.test(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function isoDate(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function stableId(section, url, headline) {
  const digest = crypto.createHash("sha256").update(`${section}|${url}|${headline}`).digest("hex").slice(0, 16);
  return `auto-${section}-${digest}`;
}

function firstTag(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return match ? decodeEntities(match[1]) : "";
}

function parseRss(xml, source) {
  const records = [];
  const items = String(xml || "").match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];

  items.forEach((itemXml, index) => {
    const headline = firstTag(itemXml, "title");
    const url = safeHttpUrl(firstTag(itemXml, "link"));
    if (!headline || !url) return;

    records.push({
      section: source.section,
      headline,
      url,
      sourceName: source.sourceName,
      summary: firstTag(itemXml, "description").slice(0, 280),
      publishedAt: isoDate(firstTag(itemXml, "pubDate") || firstTag(itemXml, "dc:date")),
      category: firstTag(itemXml, "category"),
      sourceOrder: index,
    });
  });

  return records;
}

function collectJsonLdArticles(value, results = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonLdArticles(item, results));
    return results;
  }
  if (!value || typeof value !== "object") return results;

  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  if (types.some((type) => /NewsArticle|Article/i.test(String(type || "")))) {
    results.push(value);
  }
  Object.values(value).forEach((item) => collectJsonLdArticles(item, results));
  return results;
}

function parsePinalCentral(html) {
  const records = [];
  const seenUrls = new Set();
  const scripts = String(html || "").match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];

  scripts.forEach((script) => {
    const jsonText = script.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    try {
      collectJsonLdArticles(JSON.parse(jsonText)).forEach((article) => {
        const headline = decodeEntities(article.headline || article.name || "");
        const url = safeHttpUrl(article.url || article.mainEntityOfPage?.["@id"] || article.mainEntityOfPage, PINALCENTRAL_URL);
        if (!headline || !url || seenUrls.has(url)) return;
        seenUrls.add(url);
        records.push({
          section: "local",
          headline,
          url,
          sourceName: "PinalCentral",
          summary: decodeEntities(article.description || "").slice(0, 280),
          publishedAt: isoDate(article.datePublished),
          locality: inferLocality(`${headline} ${url}`),
          category: "Local news",
          sourceOrder: records.length,
        });
      });
    } catch {
      // A malformed JSON-LD block should not suppress ordinary article-link parsing.
    }
  });

  const anchorPattern = /<a\b[^>]*href=["']([^"']*article_[^"']+\.html[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(String(html || "")))) {
    const url = safeHttpUrl(match[1], PINALCENTRAL_URL);
    const headline = decodeEntities(match[2]);
    if (!url || !headline || headline.length < 12 || seenUrls.has(url)) continue;
    seenUrls.add(url);
    records.push({
      section: "local",
      headline,
      url,
      sourceName: "PinalCentral",
      summary: "",
      publishedAt: "",
      locality: inferLocality(`${headline} ${url}`),
      category: "Local news",
      sourceOrder: records.length,
    });
  }

  return records;
}

function parsePinalCentralDiscoveryRss(xml) {
  return parseRss(xml, { section: "local", sourceName: "PinalCentral" })
    .map((item) => ({
      ...item,
      headline: item.headline.replace(/\s+-\s+PinalCentral(?:\.com)?$/i, "").trim(),
      locality: inferLocality(`${item.headline} ${item.url}`),
      category: "Local news",
    }))
    .filter((item) => !LOCAL_NON_NEWS.test(item.headline));
}

function inferLocality(value) {
  const text = String(value || "").toLowerCase();
  const places = [
    ["casa grande", "Casa Grande"], ["pinal", "Pinal County"], ["coolidge", "Coolidge"],
    ["florence", "Florence"], ["maricopa", "Maricopa"], ["stanfield", "Stanfield"],
    ["arizona city", "Arizona City"], ["eloy", "Eloy"],
  ];
  return places.find(([needle]) => text.includes(needle))?.[1] || "Pinal County";
}

function importanceScore(item, nowMs = Date.now()) {
  const text = `${item.headline} ${item.summary || ""} ${item.category || ""}`;
  let score = 100 - Math.min(Number(item.sourceOrder || 0), 50);
  if (EXCLUDED_TOPICS.test(text)) score -= 200;
  IMPORTANT_TOPICS.forEach((pattern) => { if (pattern.test(text)) score += 35; });
  if (item.section === "local") {
    LOCAL_TOPICS.forEach((pattern) => { if (pattern.test(text)) score += 30; });
  }
  const publishedMs = Date.parse(item.publishedAt || "");
  if (Number.isFinite(publishedMs)) score += Math.max(0, 36 - Math.floor((nowMs - publishedMs) / 3600000));
  return score;
}

function timestampForRetention(item) {
  return Date.parse(item.publishedAt || item.addedAt || item.retrievedAt || "");
}

function isWithinRetention(item, nowMs = Date.now()) {
  const timestamp = timestampForRetention(item);
  return Number.isFinite(timestamp) && timestamp <= nowMs + 5 * 60 * 1000 && nowMs - timestamp <= RETENTION_MS;
}

function sanitizeCandidate(candidate, previousByUrl, retrievedAt) {
  const previous = previousByUrl.get(candidate.url);
  const publishedAt = isoDate(candidate.publishedAt || previous?.publishedAt);
  const addedAt = isoDate(previous?.addedAt) || publishedAt || retrievedAt;
  return {
    id: previous?.id || stableId(candidate.section, candidate.url, candidate.headline),
    section: candidate.section,
    headline: decodeEntities(candidate.headline).slice(0, 240),
    sourceName: decodeEntities(candidate.sourceName).slice(0, 80),
    status: "active",
    priority: "normal",
    publishedAt: publishedAt || undefined,
    addedAt,
    retrievedAt,
    url: safeHttpUrl(candidate.url),
    summary: decodeEntities(candidate.summary || "").slice(0, 280) || undefined,
    locality: decodeEntities(candidate.locality || "").slice(0, 80) || undefined,
    category: decodeEntities(candidate.category || "").slice(0, 80) || undefined,
    _score: importanceScore(candidate, Date.parse(retrievedAt)),
  };
}

function selectNews(candidates, previousPayload, now = new Date()) {
  const retrievedAt = now.toISOString();
  const nowMs = now.getTime();
  const previousItems = Array.isArray(previousPayload?.items) ? previousPayload.items : [];
  const previousByUrl = new Map(previousItems.filter((item) => item?.url).map((item) => [item.url, item]));
  const byUrl = new Map();
  const seenHeadlines = new Set();

  candidates.forEach((candidate) => {
    if (!candidate?.url || !candidate?.headline || !["local", "national", "world"].includes(candidate.section)) return;
    const clean = sanitizeCandidate(candidate, previousByUrl, retrievedAt);
    const headlineKey = `${clean.section}|${clean.headline.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
    if (seenHeadlines.has(headlineKey)) return;
    if (clean.url && isWithinRetention(clean, nowMs)) {
      byUrl.set(clean.url, clean);
      seenHeadlines.add(headlineKey);
    }
  });

  previousItems.forEach((item) => {
    if (!item?.url || byUrl.has(item.url) || !isWithinRetention(item, nowMs)) return;
    const clean = sanitizeCandidate({ ...item, sourceOrder: 99 }, previousByUrl, retrievedAt);
    clean.retrievedAt = isoDate(item.retrievedAt) || retrievedAt;
    byUrl.set(clean.url, clean);
  });

  const items = [];
  Object.entries(SECTION_RESERVE_LIMITS).forEach(([section, limit]) => {
    const selected = [...byUrl.values()]
      .filter((item) => item.section === section)
      .sort((a, b) => b._score - a._score || timestampForRetention(b) - timestampForRetention(a))
      .slice(0, limit)
      .map(({ _score, ...item }) => Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined && value !== "")));
    items.push(...selected);
  });

  return { schemaVersion: 1, updatedAt: retrievedAt, items };
}

async function fetchText(url, fetchImpl = global.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": "LaurasDailyDashboardNews/1.0 (+https://github.com/lajward-prog/lauras-daily-dashboard)" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function loadPreviousPayload(filePath, previousUrl, fetchImpl = global.fetch) {
  if (previousUrl) {
    try {
      const text = await fetchText(`${previousUrl}${previousUrl.includes("?") ? "&" : "?"}v=${Date.now()}`, fetchImpl);
      const payload = JSON.parse(text);
      if (Array.isArray(payload.items)) return payload;
    } catch (error) {
      console.warn(`Previous public payload unavailable: ${error.message}`);
    }
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return { schemaVersion: 1, updatedAt: null, items: [] };
  }
}

async function collectNews(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const previous = options.previousPayload || await loadPreviousPayload(options.previousFile || DEFAULT_OUTPUT, options.previousUrl, fetchImpl);
  const candidates = [];
  const failures = [];
  const sources = [
    { name: "PinalCentral", url: PINALCENTRAL_URL, parse: parsePinalCentral },
    { name: "PinalCentral discovery RSS", url: PINALCENTRAL_DISCOVERY_RSS, parse: parsePinalCentralDiscoveryRss },
    { name: "NPR National", url: NPR_NATIONAL_RSS, parse: (text) => parseRss(text, { section: "national", sourceName: "NPR" }) },
    { name: "BBC World", url: BBC_WORLD_RSS, parse: (text) => parseRss(text, { section: "world", sourceName: "BBC News" }) },
  ];

  const sourceResults = await Promise.all(sources.map(async (source) => {
    try {
      return source.parse(await fetchText(source.url, fetchImpl));
    } catch (error) {
      failures.push(`${source.name}: ${error.message}`);
      return [];
    }
  }));
  sourceResults.forEach((items) => candidates.push(...items));

  const payload = selectNews(candidates, previous, options.now || new Date());
  payload.sources = {
    local: "PinalCentral",
    national: "NPR National RSS",
    world: "BBC News World RSS",
    failures,
  };
  return payload;
}

function publicScript(payload) {
  const serialized = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `window.DASHBOARD_REMOTE_NEWS_ITEMS_DATA = ${serialized};\n`;
}

function parseArgs(argv) {
  const result = { output: DEFAULT_OUTPUT, scriptOutput: DEFAULT_SCRIPT_OUTPUT, previousUrl: "" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--output") result.output = argv[++index];
    else if (argv[index] === "--script-output") result.scriptOutput = argv[++index];
    else if (argv[index] === "--previous-url") result.previousUrl = argv[++index];
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = await collectNews({ previousFile: args.output, previousUrl: args.previousUrl });
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.mkdirSync(path.dirname(args.scriptOutput), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(args.scriptOutput, publicScript(payload));
  const counts = ["local", "national", "world"].map((section) => `${section}=${payload.items.filter((item) => item.section === section).length}`);
  console.log(`Generated sanitized news payload (${counts.join(", ")}).`);
  if (payload.sources.failures.length) console.warn(payload.sources.failures.join("\n"));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  collectJsonLdArticles,
  decodeEntities,
  importanceScore,
  isWithinRetention,
  parsePinalCentral,
  parsePinalCentralDiscoveryRss,
  parseRss,
  publicScript,
  selectNews,
};
