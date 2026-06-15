function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseResetTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  // Live API uses ms in headers + 429 JSON; docs example uses seconds.
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

export function parseRateLimitPayload({ headers, status, bodyText }) {
  const fromHeaders = {
    limit: headers?.get("x-ratelimit-limit"),
    remaining: headers?.get("x-ratelimit-remaining"),
    reset: headers?.get("x-ratelimit-reset"),
  };

  let fromBody = {};
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      fromBody = {
        limit: parsed.limit,
        remaining: parsed.remaining,
        reset: parsed.reset,
      };
    } catch {
      // ignore non-JSON bodies
    }
  }

  const limit = Number(fromBody.limit ?? fromHeaders.limit ?? NaN);
  const remaining = Number(fromBody.remaining ?? fromHeaders.remaining ?? NaN);
  const reset = parseResetTimestamp(fromBody.reset ?? fromHeaders.reset ?? 0);

  if (!Number.isFinite(limit) && !Number.isFinite(remaining) && !reset) {
    return null;
  }

  return {
    limit: Number.isFinite(limit) ? limit : null,
    remaining: Number.isFinite(remaining) ? remaining : null,
    resetAt: reset,
    status,
  };
}

export class RateLimiter {
  constructor({ limit = 60, safetyMargin = 2, windowMs = 60_000 } = {}) {
    this.limit = limit;
    this.maxPerWindow = Math.max(limit - safetyMargin, 1);
    this.windowMs = windowMs;
    this.requestTimestamps = [];
    this.remaining = null;
    this.resetAt = 0;
    this.queue = Promise.resolve();
  }

  syncFromServer({ limit, remaining, resetAt }) {
    if (limit !== null) {
      this.limit = limit;
      this.maxPerWindow = Math.max(limit - 2, 1);
    }

    if (remaining !== null) {
      this.remaining = remaining;
    }

    if (resetAt) {
      this.resetAt = resetAt;
    }
  }

  recordResponse(headers, status, bodyText = "") {
    const parsed = parseRateLimitPayload({ headers, status, bodyText });
    if (!parsed) {
      return;
    }

    this.syncFromServer(parsed);

    if (status === 429) {
      this.remaining = 0;
    }
  }

  async acquire() {
    let release;
    const next = new Promise((resolve) => {
      release = resolve;
    });

    this.queue = this.queue.then(async () => {
      await this.waitForCapacity();
      release();
    });

    await next;
  }

  async waitForServerReset() {
    if (this.remaining !== 0 || this.resetAt <= 0) {
      return;
    }

    const waitMs = this.resetAt - Date.now() + 100;
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    this.remaining = null;
  }

  async waitForSlidingWindow() {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(
      (timestamp) => now - timestamp < this.windowMs,
    );

    if (this.requestTimestamps.length < this.maxPerWindow) {
      this.requestTimestamps.push(Date.now());
      return;
    }

    const oldest = this.requestTimestamps[0];
    const waitMs = this.windowMs - (now - oldest) + 50;
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const refreshedNow = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(
      (timestamp) => refreshedNow - timestamp < this.windowMs,
    );
    this.requestTimestamps.push(Date.now());
  }

  async waitForCapacity() {
    await this.waitForServerReset();
    await this.waitForSlidingWindow();
  }

  getStats() {
    const now = Date.now();
    const recent = this.requestTimestamps.filter((timestamp) => now - timestamp < this.windowMs);

    return {
      limit: this.limit,
      remaining:
        this.remaining !== null ? this.remaining : Math.max(this.maxPerWindow - recent.length, 0),
      resetAt: this.resetAt,
      recentRequests: recent.length,
      maxPerWindow: this.maxPerWindow,
      source: this.remaining !== null ? "server" : "sliding-window",
    };
  }
}
