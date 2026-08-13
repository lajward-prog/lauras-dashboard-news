#!/usr/bin/env node

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const artifactDirectory = process.argv[2];
assert.ok(artifactDirectory, "Usage: node tests/public-news-artifact-regression.test.js <artifact-directory>");

const names = fs.readdirSync(artifactDirectory).sort();
assert.deepEqual(names, ["news-items.js", "news-items.json"], "Public artifact must contain only the two news payload files.");

const jsonPath = path.join(artifactDirectory, "news-items.json");
const scriptPath = path.join(artifactDirectory, "news-items.js");
const payload = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const script = fs.readFileSync(scriptPath, "utf8");

assert.equal(payload.schemaVersion, 1);
assert.ok(Array.isArray(payload.items));
assert.match(script, /^window\.DASHBOARD_REMOTE_NEWS_ITEMS_DATA = /);

const allowedTopLevel = new Set(["schemaVersion", "updatedAt", "items", "sources"]);
const allowedItemFields = new Set([
  "id", "section", "headline", "sourceName", "status", "priority", "publishedAt", "addedAt",
  "retrievedAt", "url", "summary", "locality", "category",
]);
Object.keys(payload).forEach((field) => assert.ok(allowedTopLevel.has(field), `Unexpected public top-level field: ${field}`));
payload.items.forEach((item) => {
  Object.keys(item).forEach((field) => assert.ok(allowedItemFields.has(field), `Unexpected public news field: ${field}`));
  assert.ok(["local", "national", "world"].includes(item.section));
  assert.match(item.url, /^https?:\/\//);
});

const serialized = `${JSON.stringify(payload)}\n${script}`.toLowerCase();
[
  "appointment", "dashboard-items", "case-health", "case-ace", "laura only", "cg va clinic",
].forEach((privateMarker) => assert.equal(serialized.includes(privateMarker), false, `Private marker leaked: ${privateMarker}`));

console.log(`Public news artifact verified: ${payload.items.length} sanitized records, no private dashboard fields.`);
