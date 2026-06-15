export const UMAMI_HEADERS = [
  "session_id",
  "hostname",
  "browser",
  "os",
  "device",
  "screen",
  "language",
  "country",
  "region",
  "city",
  "url_path",
  "url_query",
  "referrer_path",
  "referrer_domain",
  "page_title",
  "event_type",
  "event_name",
  "distinct_id",
  "created_at",
];

export function escapeCsv(value) {
  if (value === null || value === undefined) {
    return '""';
  }

  const stringValue = String(value);
  return `"${stringValue.replace(/"/g, '""')}"`;
}

export function formatUmamiRow(row) {
  return UMAMI_HEADERS.map((header) => {
    if (header === "event_type") {
      return row[header] ?? "";
    }
    return escapeCsv(row[header] ?? "");
  }).join(",");
}

export function formatCreatedAt(isoTimestamp) {
  if (!isoTimestamp) {
    return "";
  }

  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function parsePageUrl(rawUrl) {
  if (!rawUrl) {
    return { hostname: "", url_path: "/", url_query: "" };
  }

  const trimmed = rawUrl.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withScheme);
    return {
      hostname: url.hostname,
      url_path: url.pathname || "/",
      url_query: url.search || "",
    };
  } catch {
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex === -1) {
      return { hostname: trimmed, url_path: "/", url_query: "" };
    }

    const hostname = trimmed.slice(0, slashIndex);
    const rest = trimmed.slice(slashIndex);
    const queryIndex = rest.indexOf("?");
    if (queryIndex === -1) {
      return { hostname, url_path: rest || "/", url_query: "" };
    }

    return {
      hostname,
      url_path: rest.slice(0, queryIndex) || "/",
      url_query: rest.slice(queryIndex),
    };
  }
}

export function parseReferrer(rawReferrer) {
  if (!rawReferrer) {
    return { referrer_path: "", referrer_domain: "" };
  }

  const trimmed = rawReferrer.trim();
  if (!trimmed) {
    return { referrer_path: "", referrer_domain: "" };
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withScheme);
    return {
      referrer_domain: url.hostname,
      referrer_path: url.pathname || "/",
    };
  } catch {
    return { referrer_path: "", referrer_domain: trimmed };
  }
}

function normalizeLower(value) {
  return value ? String(value).toLowerCase() : "";
}

function buildScreen(viewport) {
  if (!viewport?.width || !viewport?.height) {
    return "";
  }

  return `${viewport.width}x${viewport.height}`;
}

function buildIdentityFields(identity) {
  return {
    browser: normalizeLower(identity?.browser?.name),
    os: normalizeLower(identity?.os?.name),
    device: normalizeLower(identity?.device?.type),
    screen: buildScreen(identity?.viewport),
    language: "",
    country: identity?.countryCode || "",
    region: identity?.region || "",
    city: identity?.city || "",
  };
}

function findPageForGoal(visitedPages, goalTimestamp) {
  if (!visitedPages?.length) {
    return null;
  }

  const goalTime = new Date(goalTimestamp).getTime();
  let best = visitedPages[0];

  for (const page of visitedPages) {
    const pageTime = new Date(page.timestamp).getTime();
    if (Number.isNaN(pageTime)) {
      continue;
    }

    if (pageTime <= goalTime) {
      best = page;
    }
  }

  return best;
}

function buildBaseRow({ visitorId, identity, referrer }) {
  return {
    session_id: visitorId,
    distinct_id: visitorId,
    ...buildIdentityFields(identity),
    referrer_path: referrer.referrer_path,
    referrer_domain: referrer.referrer_domain,
    page_title: "",
  };
}

export function mapVisitorToUmamiRows({ visitorId, listRow, detail }) {
  const identity = detail?.identity ?? {};
  const activity = detail?.activity ?? {};
  const referrer = parseReferrer(listRow?.acquisition?.referrer);
  const base = buildBaseRow({ visitorId, identity, referrer });
  const rows = [];

  for (const page of activity.visitedPages ?? []) {
    const pageUrl = parsePageUrl(page.url);
    rows.push({
      ...base,
      ...pageUrl,
      event_type: "1",
      event_name: "",
      created_at: formatCreatedAt(page.timestamp),
    });
  }

  for (const goal of activity.completedGoals ?? []) {
    const matchedPage = findPageForGoal(activity.visitedPages ?? [], goal.timestamp);
    const pageUrl = matchedPage
      ? parsePageUrl(matchedPage.url)
      : parsePageUrl(activity.currentUrl || "/");

    rows.push({
      ...base,
      ...pageUrl,
      event_type: "2",
      event_name: goal.name || "",
      created_at: formatCreatedAt(goal.timestamp),
    });
  }

  return rows.filter((row) => row.created_at);
}
