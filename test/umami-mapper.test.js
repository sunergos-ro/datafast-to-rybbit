import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatCreatedAt,
  formatUmamiRow,
  mapVisitorToUmamiRows,
  parsePageUrl,
  parseReferrer,
  UMAMI_HEADERS,
} from "../src/mappers/umami.js";

describe("parsePageUrl", () => {
  it("parses absolute URLs", () => {
    assert.deepEqual(parsePageUrl("https://example.com/path?q=1"), {
      hostname: "example.com",
      url_path: "/path",
      url_query: "?q=1",
    });
  });

  it("parses host-only paths", () => {
    assert.deepEqual(parsePageUrl("example.com/about"), {
      hostname: "example.com",
      url_path: "/about",
      url_query: "",
    });
  });
});

describe("parseReferrer", () => {
  it("extracts domain and path", () => {
    assert.deepEqual(parseReferrer("https://google.com/search"), {
      referrer_domain: "google.com",
      referrer_path: "/search",
    });
  });
});

describe("formatCreatedAt", () => {
  it("formats UTC timestamps", () => {
    assert.equal(formatCreatedAt("2024-06-15T14:30:00.000Z"), "2024-06-15 14:30:00");
  });
});

describe("mapVisitorToUmamiRows", () => {
  it("maps pageviews and goals", () => {
    const rows = mapVisitorToUmamiRows({
      visitorId: "v1",
      listRow: { acquisition: { referrer: "https://google.com/" } },
      detail: {
        identity: {
          browser: { name: "Chrome" },
          os: { name: "macOS" },
          device: { type: "desktop" },
          viewport: { width: 1920, height: 1080 },
          countryCode: "RO",
        },
        activity: {
          visitedPages: [
            { url: "https://example.com/", timestamp: "2024-01-01T10:00:00.000Z" },
            { url: "https://example.com/pricing", timestamp: "2024-01-01T10:05:00.000Z" },
          ],
          completedGoals: [
            { name: "signup", timestamp: "2024-01-01T10:06:00.000Z" },
          ],
        },
      },
    });

    assert.equal(rows.length, 3);
    assert.equal(rows[0].event_type, "1");
    assert.equal(rows[2].event_type, "2");
    assert.equal(rows[2].event_name, "signup");
    assert.equal(rows[2].url_path, "/pricing");
    assert.equal(rows[0].session_id, "v1");
    assert.equal(rows[0].referrer_domain, "google.com");
  });
});

describe("formatUmamiRow", () => {
  it("keeps event_type unquoted", () => {
    const line = formatUmamiRow({
      session_id: "v1",
      hostname: "example.com",
      browser: "chrome",
      os: "macos",
      device: "desktop",
      screen: "1920x1080",
      language: "",
      country: "RO",
      region: "",
      city: "",
      url_path: "/",
      url_query: "",
      referrer_path: "/",
      referrer_domain: "google.com",
      page_title: "",
      event_type: "1",
      event_name: "",
      distinct_id: "v1",
      created_at: "2024-01-01 10:00:00",
    });

    assert.match(line, /,1,/);
    assert.equal(line.split(",").length, UMAMI_HEADERS.length);
  });
});
