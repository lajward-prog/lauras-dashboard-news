# Laura's Dashboard News

Public, news-only data service for Laura's private daily dashboard.

This repository contains:

- a scheduled headline collector;
- automated regression and privacy checks; and
- sanitized public headline files used by the dashboard.

It intentionally contains **no dashboard source, appointments, tasks, cases,
health information, personal reminders, or other private dashboard data**.

## Public feed

- `docs/news-items.js` — classic-script wrapper for dashboards opened from `file://`
- `docs/news-items.json` — equivalent JSON payload

The collector refreshes the feed every three hours. Headlines expire after 72
hours. PinalCentral supplies local discovery; NPR and BBC provide national and
world coverage.

## Privacy boundary

Every update must pass `tests/public-news-artifact-regression.test.js`. That
test limits the published fields and rejects known private-dashboard markers.
