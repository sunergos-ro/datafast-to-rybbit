import fs from "node:fs/promises";
import path from "node:path";
import {
  getOverview,
  getRateLimitStats,
  getVisitor,
  listVisitors,
  listWebsites,
} from "./datafast/client.js";
import {
  formatUmamiRow,
  mapVisitorToUmamiRows,
  UMAMI_HEADERS,
} from "./mappers/umami.js";
import { ProgressReporter, progressFilePath } from "./progress.js";

export const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "datafast-export/umami");
export const DEFAULT_PERIOD = "last12m";
export const DEFAULT_CONCURRENCY = 10;
export const PAGE_SIZE = 250;
export const DEFAULT_PROGRESS_INTERVAL_SEC = 15;
export const DEFAULT_PROGRESS_EVERY_VISITORS = 25;

export function parseExportArgs(argv) {
  const options = {
    website: null,
    outputDir: DEFAULT_OUTPUT_DIR,
    period: DEFAULT_PERIOD,
    concurrency: DEFAULT_CONCURRENCY,
    dryRun: false,
    resume: true,
    progressIntervalSec: DEFAULT_PROGRESS_INTERVAL_SEC,
    progressEveryVisitors: DEFAULT_PROGRESS_EVERY_VISITORS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--website") {
      options.website = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--output-dir") {
      options.outputDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--period") {
      options.period = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--concurrency") {
      options.concurrency = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--no-resume") {
      options.resume = false;
      continue;
    }

    if (arg === "--progress-interval") {
      options.progressIntervalSec = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--progress-every") {
      options.progressEveryVisitors = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function exportHelpText() {
  return `Usage: datafast-to-rybbit export [options]

Options:
  --website <domain>       Export a single website (e.g. example.com)
  --output-dir <path>      Output directory for CSV files (default: ./datafast-export/umami)
  --period <period>        DataFast period preset: last12m, last30d, all (default: last12m)
  --concurrency <n>        Parallel visitor fetches (default: 10)
  --dry-run                Fetch and count rows without writing CSV
  --no-resume              Ignore checkpoint files and re-export from scratch
  --progress-interval <s>  Log progress every N seconds (default: 15)
  --progress-every <n>     Log progress every N visitors (default: 25)
`;
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function checkpointPath(outputDir, domain) {
  return path.join(outputDir, `.checkpoint-${domain}.json`);
}

async function loadCheckpoint(outputDir, domain) {
  try {
    const raw = await fs.readFile(checkpointPath(outputDir, domain), "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      completedVisitorIds: [],
      rowCount: 0,
      pageviewCount: 0,
      goalCount: 0,
      errors: [],
    };
  }
}

async function saveCheckpoint(outputDir, domain, checkpoint) {
  await fs.writeFile(
    checkpointPath(outputDir, domain),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    "utf8",
  );
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function fetchAllVisitors(websiteId, period, progress) {
  const visitors = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    progress?.setPhase("listing visitors", `${visitors.length} fetched`);
    await progress?.tick(getRateLimitStats, true);

    const response = await listVisitors(websiteId, {
      period,
      limit: PAGE_SIZE,
      offset,
    });

    const batch = response.data ?? [];
    visitors.push(...batch);

    hasMore = Boolean(response.pagination?.hasMore);
    offset += PAGE_SIZE;

    if (hasMore) {
      progress?.setPhase(
        "listing visitors",
        `${visitors.length}/${response.pagination?.total ?? "?"} fetched`,
      );
      await progress?.tick(getRateLimitStats, false);
    }
  }

  return visitors;
}

async function exportWebsite(site, options) {
  const {
    outputDir,
    period,
    concurrency,
    dryRun,
    resume,
    progressIntervalSec,
    progressEveryVisitors,
  } = options;
  const domain = site.domain;
  const websiteId = site._id;

  console.log(`\nExporting ${domain} (${websiteId})...`);
  const rateLimit = getRateLimitStats();
  console.log(`  rate limit: ${rateLimit.remaining}/${rateLimit.limit} remaining until reset`);

  const progress = new ProgressReporter({
    domain,
    websiteId,
    totalVisitors: 0,
    progressFile: progressFilePath(outputDir),
    logEveryMs: progressIntervalSec * 1000,
    logEveryVisitors: progressEveryVisitors,
  });
  progress.setPhase("fetching overview");
  await progress.tick(getRateLimitStats, true);

  const overview = await getOverview(websiteId, { period });
  progress.setPhase("listing visitors");
  const visitors = await fetchAllVisitors(websiteId, period, progress);
  const checkpoint = resume
    ? await loadCheckpoint(outputDir, domain)
    : {
        completedVisitorIds: [],
        rowCount: 0,
        pageviewCount: 0,
        goalCount: 0,
        errors: [],
      };

  const completed = new Set(checkpoint.completedVisitorIds);
  const pendingVisitors = visitors.filter((visitor) => !completed.has(visitor.visitorId));
  const csvPath = path.join(outputDir, `${domain}.csv`);
  let rowCount = checkpoint.rowCount;
  let pageviewCount = checkpoint.pageviewCount;
  let goalCount = checkpoint.goalCount;
  const errors = [...checkpoint.errors];

  progress.totalVisitors = visitors.length;
  progress.completed = completed.size;
  progress.rows = rowCount;
  progress.pageviews = pageviewCount;
  progress.goals = goalCount;
  progress.setPhase("exporting visitors", `${pendingVisitors.length} pending`);
  await progress.tick(getRateLimitStats, true);

  console.log(
    `  visitors=${visitors.length}, pending=${pendingVisitors.length}, overview.pageviews=${overview.pageviews ?? 0}`,
  );

  if (!dryRun) {
    await ensureDir(outputDir);

    if (!resume || checkpoint.completedVisitorIds.length === 0) {
      await fs.writeFile(csvPath, `${UMAMI_HEADERS.join(",")}\n`, "utf8");
    }
  }

  const processVisitor = async (listRow) => {
    try {
      const detail = await getVisitor(websiteId, listRow.visitorId);
      const rows = mapVisitorToUmamiRows({
        visitorId: listRow.visitorId,
        listRow,
        detail,
      });

      if (!dryRun && rows.length > 0) {
        const chunk = `${rows.map((row) => formatUmamiRow(row)).join("\n")}\n`;
        await fs.appendFile(csvPath, chunk, "utf8");
      }

      const pageviews = rows.filter((row) => row.event_type === "1").length;
      const goals = rows.filter((row) => row.event_type === "2").length;

      rowCount += rows.length;
      pageviewCount += pageviews;
      goalCount += goals;
      completed.add(listRow.visitorId);

      if (!dryRun) {
        await saveCheckpoint(outputDir, domain, {
          completedVisitorIds: [...completed],
          rowCount,
          pageviewCount,
          goalCount,
          errors,
        });
      }

      progress.recordSuccess({ rows: rows.length, pageviews, goals });
      progress.setPhase("exporting visitors");
      await progress.tick(getRateLimitStats, false);

      return { rows: rows.length, pageviews, goals, error: null };
    } catch (error) {
      const message = `${listRow.visitorId}: ${error.message}`;
      errors.push(message);
      if (!dryRun) {
        await saveCheckpoint(outputDir, domain, {
          completedVisitorIds: [...completed],
          rowCount,
          pageviewCount,
          goalCount,
          errors,
        });
      }
      progress.recordFailure();
      progress.setPhase("exporting visitors", `${message.slice(0, 80)}`);
      await progress.tick(getRateLimitStats, true);
      return { rows: 0, pageviews: 0, goals: 0, error: message };
    }
  };

  const results = await mapWithConcurrency(pendingVisitors, concurrency, processVisitor);
  const failed = results.filter((result) => result.error).length;

  const summary = {
    domain,
    websiteId,
    period,
    visitorsListed: visitors.length,
    visitorsExported: completed.size,
    rows: rowCount,
    pageviews: pageviewCount,
    goals: goalCount,
    overviewPageviews: overview.pageviews ?? 0,
    overviewVisitors: overview.visitors ?? 0,
    csvPath: dryRun ? null : csvPath,
    errors,
    failed,
  };

  console.log(
    `  done rows=${summary.rows} pageviews=${summary.pageviews} goals=${summary.goals} failed=${failed}`,
  );

  progress.setPhase("complete");
  await progress.tick(getRateLimitStats, true);

  if (!dryRun && failed === 0) {
    await fs.unlink(checkpointPath(outputDir, domain)).catch(() => {});
  }

  return summary;
}

export async function writeManifest(outputDir, summaries, period) {
  const manifestPath = path.join(path.dirname(outputDir), "manifest.json");
  const manifest = {
    generatedAt: new Date().toISOString(),
    period,
    outputDir,
    sites: summaries,
    totals: summaries.reduce(
      (acc, site) => {
        acc.visitorsListed += site.visitorsListed ?? 0;
        acc.visitorsExported += site.visitorsExported ?? 0;
        acc.rows += site.rows ?? 0;
        acc.pageviews += site.pageviews ?? 0;
        acc.goals += site.goals ?? 0;
        acc.failed += site.failed ?? 0;
        return acc;
      },
      {
        visitorsListed: 0,
        visitorsExported: 0,
        rows: 0,
        pageviews: 0,
        goals: 0,
        failed: 0,
      },
    ),
  };

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

async function isWebsiteComplete(outputDir, domain) {
  const csvPath = path.join(outputDir, `${domain}.csv`);
  const checkpoint = checkpointPath(outputDir, domain);

  try {
    await fs.access(checkpoint);
    return false;
  } catch {
    try {
      await fs.access(csvPath);
      return true;
    } catch {
      return false;
    }
  }
}

async function loadCompletedSummary(outputDir, domain, period) {
  const csvPath = path.join(outputDir, `${domain}.csv`);
  const raw = await fs.readFile(csvPath, "utf8");
  const lines = raw.trim().split("\n");
  const rows = Math.max(lines.length - 1, 0);
  const pageviews = lines.slice(1).filter((line) => line.includes(",1,")).length;

  return {
    domain,
    skipped: true,
    period,
    visitorsListed: 0,
    visitorsExported: 0,
    rows,
    pageviews,
    goals: rows - pageviews,
    csvPath,
    failed: 0,
    errors: [],
  };
}

export async function runExport(argv) {
  const options = parseExportArgs(argv);
  await ensureDir(options.outputDir);

  const websites = await listWebsites();
  const selected = options.website
    ? websites.filter((site) => site.domain === options.website)
    : websites;

  if (selected.length === 0) {
    throw new Error(
      options.website
        ? `Website not found: ${options.website}`
        : "No websites returned by DataFast API",
    );
  }

  const summaries = [];
  for (const site of selected) {
    if (!options.website && (await isWebsiteComplete(options.outputDir, site.domain))) {
      console.log(`\nSkipping ${site.domain} (already exported, no checkpoint)`);
      summaries.push(await loadCompletedSummary(options.outputDir, site.domain, options.period));
      continue;
    }

    summaries.push(await exportWebsite(site, options));
  }

  if (!options.dryRun) {
    const manifestPath = await writeManifest(options.outputDir, summaries, options.period);
    console.log(`\nManifest written to ${manifestPath}`);
  }

  console.log("\nExport complete.");
}
