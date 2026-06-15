import fs from "node:fs/promises";
import path from "node:path";
import { UMAMI_HEADERS } from "./mappers/umami.js";

export const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "datafast-export/umami");

export function parseValidateArgs(argv) {
  const options = {
    outputDir: DEFAULT_OUTPUT_DIR,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--output-dir") {
      options.outputDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function validateHelpText() {
  return `Usage: datafast-to-rybbit validate [options]

Options:
  --output-dir <path>  Directory containing CSV files (default: ./datafast-export/umami)
`;
}

async function validateCsvFile(csvPath) {
  const raw = await fs.readFile(csvPath, "utf8");
  const lines = raw.trim().split("\n");

  if (lines.length === 0) {
    throw new Error(`${csvPath}: empty file`);
  }

  const header = lines[0].split(",");
  if (header.join(",") !== UMAMI_HEADERS.join(",")) {
    throw new Error(`${csvPath}: invalid header`);
  }

  let pageviews = 0;
  let goals = 0;
  let invalidDates = 0;

  for (const line of lines.slice(1)) {
    if (!line.trim()) {
      continue;
    }

    const columns = line.split(",");
    const eventType = columns[15];
    const createdAt = columns[18]?.replace(/^"|"$/g, "");

    if (eventType === "1") {
      pageviews += 1;
    } else if (eventType === "2") {
      goals += 1;
    }

    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(createdAt)) {
      invalidDates += 1;
    }
  }

  return {
    file: csvPath,
    rows: Math.max(lines.length - 1, 0),
    pageviews,
    goals,
    invalidDates,
  };
}

export async function runValidate(argv) {
  const options = parseValidateArgs(argv);
  const manifestPath = path.join(path.dirname(options.outputDir), "manifest.json");

  const entries = await fs.readdir(options.outputDir);
  const csvFiles = entries.filter((name) => name.endsWith(".csv")).sort();

  if (csvFiles.length === 0) {
    throw new Error(`No CSV files found in ${options.outputDir}`);
  }

  const results = [];
  for (const file of csvFiles) {
    results.push(await validateCsvFile(path.join(options.outputDir, file)));
  }

  let manifest = null;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch {
    console.warn(`Warning: no manifest at ${manifestPath}`);
  }

  console.log(`Validated ${results.length} CSV file(s) in ${options.outputDir}\n`);

  for (const result of results) {
    const status = result.invalidDates === 0 ? "ok" : "warn";
    console.log(
      `  [${status}] ${path.basename(result.file)}: ${result.rows} rows (${result.pageviews} pageviews, ${result.goals} goals)`,
    );
    if (result.invalidDates > 0) {
      console.log(`        ${result.invalidDates} row(s) with invalid created_at`);
    }
  }

  if (manifest?.totals) {
    const csvTotals = results.reduce(
      (acc, result) => {
        acc.rows += result.rows;
        acc.pageviews += result.pageviews;
        acc.goals += result.goals;
        return acc;
      },
      { rows: 0, pageviews: 0, goals: 0 },
    );

    console.log("\nManifest totals:");
    console.log(`  rows: ${manifest.totals.rows} (csv: ${csvTotals.rows})`);
    console.log(`  pageviews: ${manifest.totals.pageviews} (csv: ${csvTotals.pageviews})`);
    console.log(`  goals: ${manifest.totals.goals} (csv: ${csvTotals.goals})`);
  }

  const invalid = results.some((result) => result.invalidDates > 0);
  if (invalid) {
    throw new Error("Validation failed: invalid date formats found");
  }

  console.log("\nValidation complete.");
}
