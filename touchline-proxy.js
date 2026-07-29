/**
 * touchline-proxy.js — Touchline's Cloudflare Worker
 * ---------------------------------------------------
 * One job, two parts:
 *   1. Proxies the official FPL API (fantasy.premierleague.com/api) and adds
 *      CORS headers, since FPL doesn't send any and browsers block the
 *      request otherwise.
 *   2. Serves "deeper stats" — season aggregates scraped server-side from
 *      Understat (attacking) and FBref (defending), which FPL's own API
 *      doesn't expose at all.
 *
 * HOW TO DEPLOY
 * Paste this entire file over whatever's currently in your Worker (in the
 * Cloudflare dashboard: Workers & Pages → touchline → Edit code), then hit
 * Deploy. That's it — nothing else to configure.
 */

const FPL_BASE = "https://fantasy.premierleague.com/api";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const SCRAPE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname.startsWith("/deeperstats/")) {
      return handleDeeperStats(url, request);
    }

    return handleFplProxy(url);
  },
};

// ---------- 1. FPL passthrough ----------
async function handleFplProxy(url) {
  const target = FPL_BASE + url.pathname + url.search;
  try {
    const res = await fetch(target, { headers: { "Accept": "application/json" } });
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Upstream fetch failed", message: e.message }), {
      status: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
}

// ---------- 2. Deeper stats: Understat (attacking) + FBref (defending) ----------
async function handleDeeperStats(url, request) {
  const parts = url.pathname.split("/").filter(Boolean); // ["deeperstats", "all"]
  const kind = parts[1] || "all";

  // Cache for a day — season-aggregate stats don't need re-scraping often,
  // and it's polite to the two sites this reads from.
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const warnings = [];
  let understat = [], fbref = [];

  if (kind === "all" || kind === "understat") {
    try {
      understat = await scrapeUnderstat();
      if (!understat.length) warnings.push("Understat returned 0 players — page structure may have changed.");
    } catch (e) {
      warnings.push("Understat scrape failed: " + e.message);
    }
  }
  if (kind === "all" || kind === "fbref") {
    try {
      fbref = await scrapeFbref();
      if (!fbref.length) warnings.push("FBref returned 0 players — page structure may have changed.");
    } catch (e) {
      warnings.push("FBref scrape failed: " + e.message);
    }
  }

  const body = JSON.stringify({ understat, fbref, warnings, syncedAt: new Date().toISOString() });
  const response = new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": warnings.length ? "no-store" : "public, max-age=86400",
    },
  });
  if (!warnings.length) {
    await cache.put(cacheKey, response.clone());
  }
  return response;
}

// Understat embeds season stats as a hex-escaped JSON string inside a
// <script> tag: var playersData = JSON.parse('\x7B...\x7D');
async function scrapeUnderstat() {
  const res = await fetch("https://understat.com/league/EPL", { headers: SCRAPE_HEADERS });
  const html = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from Understat — snippet: ${html.slice(0, 200).replace(/\s+/g, " ")}`);
  const match = html.match(/var\s+playersData\s*=\s*JSON\.parse\('(.+?)'\);/);
  if (!match) {
    const idx = html.indexOf("playersData");
    if (idx !== -1) {
      throw new Error(`"playersData" found at index ${idx} but didn't match the expected pattern — context: ${html.slice(idx - 40, idx + 200).replace(/\s+/g, " ")}`);
    }
    const otherVars = [...html.matchAll(/var\s+(\w+)\s*=\s*JSON\.parse/g)].map(m => m[1]);
    throw new Error(`"playersData" not found anywhere on the page. Other JSON.parse variables found: ${otherVars.length ? otherVars.join(", ") : "none"}`);
  }
  const jsonStr = match[1].replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const raw = JSON.parse(jsonStr);
  return raw.map(p => ({
    name: p.player_name,
    team: p.team_title,
    games: Number(p.games),
    goals: Number(p.goals),
    npg: Number(p.npg),
    xG: Number(p.xG),
    npxG: Number(p.npxG),
    assists: Number(p.assists),
    xA: Number(p.xA),
    shots: Number(p.shots),
    keyPasses: Number(p.key_passes),
    xGChain: Number(p.xGChain),
    xGBuildup: Number(p.xGBuildup),
  }));
}

// FBref wraps some tables in HTML comments to deter naive scraping — strip
// comment markers first, then every stat cell carries a stable data-stat
// attribute regardless of visible column order, which is what we key off.
function stripComments(html) {
  return html.replace(/<!--/g, "").replace(/-->/g, "");
}
function extractTable(html, tableId) {
  const cleaned = stripComments(html);
  const tableMatch = cleaned.match(new RegExp(`<table[^>]*id="${tableId}"[\\s\\S]*?<\\/table>`));
  if (!tableMatch) return [];
  const rows = [...tableMatch[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
  const out = [];
  for (const [, rowHtml] of rows) {
    if (!rowHtml.includes('data-stat="player"')) continue; // skip header/spacer rows
    const cells = {};
    for (const [, stat, raw] of rowHtml.matchAll(/data-stat="([^"]+)"[^>]*>(.*?)<\/t[hd]>/g)) {
      cells[stat] = raw.replace(/<[^>]+>/g, "").trim();
    }
    if (cells.player) out.push(cells);
  }
  return out;
}
function num(v) {
  const n = parseFloat((v || "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function fetchFbrefPage(path, tableId) {
  const res = await fetch("https://fbref.com" + path, { headers: SCRAPE_HEADERS });
  const html = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from FBref ${path} — snippet: ${html.slice(0, 200).replace(/\s+/g, " ")}`);
  const rows = extractTable(html, tableId);
  if (!rows.length) throw new Error(`HTTP 200 from FBref ${path} but table #${tableId} not found — snippet: ${html.slice(0, 200).replace(/\s+/g, " ")}`);
  return rows;
}

async function scrapeFbref() {
  const [defenseRows, miscRows] = await Promise.all([
    fetchFbrefPage("/en/comps/9/defense/Premier-League-Stats", "stats_defense"),
    fetchFbrefPage("/en/comps/9/misc/Premier-League-Stats", "stats_misc"),
  ]);

  const miscByKey = {};
  for (const r of miscRows) miscByKey[r.player + "|" + r.team] = r;

  return defenseRows.map(r => {
    const misc = miscByKey[r.player + "|" + r.team] || {};
    return {
      name: r.player,
      team: r.team,
      tackles: num(r.tackles),
      tacklesWon: num(r.tackles_won),
      interceptions: num(r.interceptions),
      blocks: num(r.blocks),
      clearances: num(r.clearances),
      errors: num(r.errors),
      aerialsWon: num(misc.aerials_won),
      aerialsLost: num(misc.aerials_lost),
      aerialWinPct: num(misc.aerials_won_pct),
    };
  });
}
