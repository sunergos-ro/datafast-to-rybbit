import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RateLimiter } from "./rate-limiter.js";

const API_BASE = "https://datafa.st/api/v1";
const DEFAULT_RETRIES = 8;
const BASE_DELAY_MS = 1000;

const rateLimiter = new RateLimiter({ limit: 60, safetyMargin: 2 });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function loadToken() {
  if (process.env.DATAFAST_TOKEN?.trim()) {
    return process.env.DATAFAST_TOKEN.trim();
  }

  const configPath = path.join(os.homedir(), ".config/datafast/config.json");

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const token = config.token || config.accessToken;
    if (token) {
      return token;
    }
  } catch {
    // fall through
  }

  throw new Error(
    "No DataFast token found. Run `datafast login` or set DATAFAST_TOKEN.",
  );
}

export function periodToRange(period) {
  const end = new Date();
  const start = new Date(end);

  switch (period) {
    case "last12m":
      start.setUTCMonth(start.getUTCMonth() - 12);
      break;
    case "last30d":
      start.setUTCDate(start.getUTCDate() - 30);
      break;
    case "all":
      return {};
    default:
      throw new Error(`Unsupported period: ${period}. Use last12m, last30d, or all.`);
  }

  return {
    startAt: start.toISOString().slice(0, 10),
    endAt: end.toISOString().slice(0, 10),
  };
}

function buildUrl(pathname, params = {}) {
  const url = new URL(`${API_BASE}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function unwrapPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === "object" && "data" in payload) {
    if (Array.isArray(payload.data)) {
      return {
        data: payload.data,
        pagination: payload.pagination,
      };
    }

    return payload.data;
  }

  return payload;
}

async function request(pathname, params = {}, { retries = DEFAULT_RETRIES, token } = {}) {
  const authToken = token ?? loadToken();
  const url = buildUrl(pathname, params);
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await rateLimiter.acquire();

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          Accept: "application/json",
        },
      });

      const bodyText = await response.text();
      rateLimiter.recordResponse(response.headers, response.status, bodyText);

      if (response.status === 429) {
        lastError = new Error(bodyText || "Rate limit exceeded");
        lastError.code = 429;

        const waitMs = Math.max(rateLimiter.resetAt - Date.now() + 100, BASE_DELAY_MS);
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        throw new Error(`DataFast API ${response.status}: ${bodyText}`);
      }

      return unwrapPayload(JSON.parse(bodyText));
    } catch (error) {
      lastError = error;
      const retryable =
        error.code === 429 ||
        /rate limit|too many requests/i.test(error.message) ||
        /ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(error.message);

      if (!retryable || attempt === retries) {
        throw error;
      }

      await sleep(BASE_DELAY_MS * 2 ** attempt);
    }
  }

  throw lastError;
}

export function getRateLimitStats() {
  return rateLimiter.getStats();
}

export async function listWebsites(options = {}) {
  const result = await request("/admin/websites", {}, options);
  if (Array.isArray(result)) {
    return result;
  }

  return result.data ?? result;
}

export async function listVisitors(
  websiteId,
  { period = "last12m", limit = 250, offset = 0, token } = {},
) {
  const range = periodToRange(period);
  return request(
    "/visitors",
    {
      websiteId,
      limit,
      offset,
      ...range,
    },
    { token },
  );
}

export async function getVisitor(websiteId, visitorId, { token } = {}) {
  return request(`/visitors/${visitorId}`, { websiteId }, { token });
}

export async function getOverview(websiteId, { period = "last12m", token } = {}) {
  const range = periodToRange(period);
  return request(
    "/analytics/overview",
    {
      websiteId,
      ...range,
    },
    { token },
  );
}
