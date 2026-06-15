import fs from "node:fs/promises";
import path from "node:path";

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "?";
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

export class ProgressReporter {
  constructor({
    domain,
    websiteId,
    totalVisitors,
    initialCompleted = 0,
    initialRows = 0,
    progressFile = null,
    logEveryVisitors = 25,
    logEveryMs = 15_000,
  }) {
    this.domain = domain;
    this.websiteId = websiteId;
    this.totalVisitors = totalVisitors;
    this.completed = initialCompleted;
    this.rows = initialRows;
    this.pageviews = 0;
    this.goals = 0;
    this.failed = 0;
    this.phase = "starting";
    this.progressFile = progressFile;
    this.logEveryVisitors = logEveryVisitors;
    this.logEveryMs = logEveryMs;
    this.startedAt = Date.now();
    this.lastLogAt = 0;
    this.lastLogCompleted = initialCompleted;
    this.sessionProcessed = 0;
  }

  setPhase(phase, detail = "") {
    this.phase = detail ? `${phase}: ${detail}` : phase;
  }

  recordSuccess({ rows = 0, pageviews = 0, goals = 0 } = {}) {
    this.completed += 1;
    this.sessionProcessed += 1;
    this.rows += rows;
    this.pageviews += pageviews;
    this.goals += goals;
  }

  recordFailure() {
    this.failed += 1;
  }

  getRateLimitLine(getRateLimitStats) {
    const stats = getRateLimitStats?.();
    if (!stats) {
      return "";
    }

    const resetIn =
      stats.resetAt > Date.now() ? Math.max(0, Math.round((stats.resetAt - Date.now()) / 1000)) : null;
    const resetSuffix = resetIn !== null && stats.remaining === 0 ? `, reset ${resetIn}s` : "";
    const sourceSuffix = stats.source ? ` (${stats.source})` : "";
    return ` | API ${stats.remaining}/${stats.limit}${resetSuffix}${sourceSuffix}`;
  }

  getSnapshot(getRateLimitStats) {
    const elapsedSec = Math.max((Date.now() - this.startedAt) / 1000, 1);
    const pending = Math.max(this.totalVisitors - this.completed, 0);
    const ratePerMin = (this.sessionProcessed / elapsedSec) * 60;
    const etaSec = ratePerMin > 0 ? (pending / ratePerMin) * 60 : null;
    const percent =
      this.totalVisitors > 0 ? Math.round((this.completed / this.totalVisitors) * 100) : 0;

    return {
      domain: this.domain,
      websiteId: this.websiteId,
      phase: this.phase,
      completed: this.completed,
      totalVisitors: this.totalVisitors,
      pending,
      percent,
      rows: this.rows,
      pageviews: this.pageviews,
      goals: this.goals,
      failed: this.failed,
      ratePerMin: Math.round(ratePerMin * 10) / 10,
      eta: etaSec !== null ? formatDuration(etaSec) : "?",
      updatedAt: new Date().toISOString(),
      rateLimit: getRateLimitStats?.() ?? null,
    };
  }

  shouldLog(force = false) {
    if (force) {
      return true;
    }

    const elapsedSinceLog = Date.now() - this.lastLogAt;
    const visitorsSinceLog = this.completed - this.lastLogCompleted;
    return (
      this.lastLogAt === 0 ||
      elapsedSinceLog >= this.logEveryMs ||
      visitorsSinceLog >= this.logEveryVisitors
    );
  }

  async writeSnapshot(getRateLimitStats) {
    if (!this.progressFile) {
      return;
    }

    const snapshot = this.getSnapshot(getRateLimitStats);
    await fs.writeFile(this.progressFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  }

  logLine(getRateLimitStats) {
    const snapshot = this.getSnapshot(getRateLimitStats);
    const rateLimit = this.getRateLimitLine(getRateLimitStats);
    console.log(
      `  [${snapshot.domain}] ${snapshot.completed}/${snapshot.totalVisitors} visitors (${snapshot.percent}%) | ${snapshot.rows} rows | ${snapshot.ratePerMin}/min | ETA ${snapshot.eta}${rateLimit} | ${snapshot.phase}`,
    );
  }

  async tick(getRateLimitStats, force = false) {
    if (!this.shouldLog(force)) {
      return;
    }

    this.lastLogAt = Date.now();
    this.lastLogCompleted = this.completed;
    await this.writeSnapshot(getRateLimitStats);
    this.logLine(getRateLimitStats);
  }
}

export function progressFilePath(outputDir) {
  return path.join(path.dirname(outputDir), "progress.json");
}
