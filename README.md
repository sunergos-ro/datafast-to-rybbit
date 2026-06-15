# datafast-to-rybbit

**Migrate DataFast history into Rybbit** without a bulk export, without manual copy-paste, and without losing pageviews or custom goals.

[DataFast](https://datafa.st) is great at collecting analytics. [Rybbit](https://rybbit.com) (self-hosted or cloud) can import historical data via [Umami-format CSV](https://rybbit.com/docs/data-import). DataFast does not ship a one-click export. This tool fills that gap: it walks the Visitors API, reconstructs each visitor's timeline, and writes CSV files Rybbit accepts.

---

## Why this exists

Moving analytics stacks usually means starting from zero. Rybbit supports historical imports, but only if you can produce the right CSV shape. DataFast exposes visitor timelines through a paginated REST API (list visitors → fetch each visitor's pages and goals). There is no "download everything" button.

`datafast-to-rybbit` automates that loop: rate-limited, resumable, one CSV per site, with a manifest you can sanity-check before import.

---

## Reference numbers (real migration, no site names)

These come from a production run migrating **17 websites**, **last 12 months** of data. Domains and visitor IDs are omitted on purpose. The point is to set expectations, not showcase anyone's traffic.

| | |
| --- | --- |
| **Sites exported** | 17 |
| **Total events** | 36,021 |
| **Pageviews** | 26,966 |
| **Custom goals** | 9,055 |
| **Per-site range** | ~100 – ~12,000 rows |
| **Export duration** | ~70 minutes |
| **API failures** | 0 |
| **Rate limit** | 60 requests/minute (per token) |

Most of the runtime is waiting on DataFast's rate limit, not CPU. Expect roughly **2 API calls per visitor** (list + detail), so larger sites dominate wall-clock time.

After export, `datafast-to-rybbit validate` checks CSV headers and date formats against the manifest totals.

---

## Quick start

**Prerequisites:** Node.js 18+, and a DataFast token from [`datafast login`](https://datafa.st/docs/cli-introduction) or the `DATAFAST_TOKEN` env var.

```bash
npm link   # optional: installs the `datafast-to-rybbit` CLI globally

# Pilot one site first (recommended)
datafast-to-rybbit export --website example.com --dry-run

# Export everything
datafast-to-rybbit export

# Validate before importing into Rybbit
datafast-to-rybbit validate
```

Default output:

```
./datafast-export/umami/<domain>.csv   # one file per site
./datafast-export/manifest.json        # totals + per-site summary
./datafast-export/progress.json        # live snapshot while running
```

Or run without linking:

```bash
node bin/datafast-to-rybbit.js export --website example.com
```

---

## Import into Rybbit

For each CSV:

1. Open the matching site in Rybbit
2. **Site Settings → Import**
3. Platform: **Umami**
4. Upload `<domain>.csv`
5. Check Import History (imported / skipped / invalid)
6. Compare pageview totals with DataFast's overview for the same period

Start with your smallest site or a dry-run count before bulk import.

---

## What you get (and what you don't)

**Exported**

- Pageviews with path, query string, hostname
- Custom goals (`event_type: 2`) with goal name
- Browser, OS, device, screen, geo (country / region / city)
- Referrer domain and path (visitor-level; see limits below)
- UTC timestamps in Umami format (`YYYY-MM-DD HH:mm:ss`)

**Not exported** (limits of the DataFast Visitors API, not this tool):

| Gap | Detail |
| --- | --- |
| Referrer / UTM | Applied at visitor level to every row |
| Page titles | Not in the API |
| Session IDs | Uses `visitorId` (no session UUID) |
| Goal page URL | Inferred from nearest preceding pageview |
| Revenue / payments | Not available |

---

## How it works

```
DataFast API                    datafast-to-rybbit                 Rybbit
─────────────                   ──────────────────                 ──────
GET /admin/websites      ──►    discover sites
GET /visitors (paginated)──►    list visitor IDs
GET /visitors/{id}       ──►    map pages + goals ──►  Umami CSV  ──►  Import
```

1. List all websites on your account
2. Paginate visitors (250 per page) for the chosen period
3. Fetch each visitor's `visitedPages[]` and `completedGoals[]`
4. Write Umami rows + checkpoint after each visitor
5. Emit `manifest.json` when done

**Resume:** re-run the same command. Checkpoint files (`.checkpoint-<domain>.json`) skip completed visitors and retry failures.

**Rate limits:** the client uses a sliding window (~58 req/min) and backs off on `429` using `X-RateLimit-*` headers. Successful responses often omit those headers; live `reset` values are Unix timestamps in **milliseconds**.

---

## CLI reference

| Flag | Default | Description |
| --- | --- | --- |
| `--website <domain>` | all sites | Export a single domain |
| `--period <period>` | `last12m` | `last12m`, `last30d`, or `all` |
| `--output-dir <path>` | `./datafast-export/umami` | CSV output directory |
| `--concurrency <n>` | `10` | Parallel visitor fetches |
| `--dry-run` | off | Count rows without writing CSV |
| `--no-resume` | off | Ignore checkpoints, start fresh |
| `--progress-interval <s>` | `15` | Log every N seconds |
| `--progress-every <n>` | `25` | Log every N visitors |

While exporting, you'll see lines like:

```
[example.com] 1900/2472 visitors (77%) | 3456 rows | 52/min | ETA 11m | API 34/60 | exporting visitors
```

---

## CSV columns

`session_id, hostname, browser, os, device, screen, language, country, region, city, url_path, url_query, referrer_path, referrer_domain, page_title, event_type, event_name, distinct_id, created_at`

- `event_type`: `1` = pageview, `2` = custom goal (unquoted integer)
- `created_at`: UTC, `YYYY-MM-DD HH:mm:ss`

---

## Development

```bash
npm test
```

## License

MIT
