/**
 * touchline-proxy.js — Touchline's Cloudflare Worker
 * ---------------------------------------------------
 * Three jobs:
 *   1. Proxies the official FPL API (fantasy.premierleague.com/api) and adds
 *      CORS headers, since FPL doesn't send any and browsers block the
 *      request otherwise.
 *   2. Serves "deeper stats" — per-player season aggregates scraped
 *      server-side from Understat (attacking) and FBref (defending), which
 *      FPL's own API doesn't expose at all. Route: /deeperstats/*
 *   3. Serves club-level stats — shots, xG, possession, PPDA (a pressing/
 *      high-line proxy), CBIT (clearances+blocks+interceptions+tackles)
 *      and more, aggregated per club from the same Understat/FBref sources.
 *      Route: /clubstats
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
    if (url.pathname.startsWith("/clubstats")) {
      return handleClubStats(url, request);
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
function extractTable(html, tableId, keyField) {
  keyField = keyField || "player";
  const cleaned = stripComments(html);
  const tableMatch = cleaned.match(new RegExp(`<table[^>]*id="${tableId}"[\\s\\S]*?<\\/table>`));
  if (!tableMatch) return [];
  const rows = [...tableMatch[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
  const out = [];
  for (const [, rowHtml] of rows) {
    if (!rowHtml.includes(`data-stat="${keyField}"`)) continue; // skip header/spacer rows
    const cells = {};
    for (const [, stat, raw] of rowHtml.matchAll(/data-stat="([^"]+)"[^>]*>(.*?)<\/t[hd]>/g)) {
      cells[stat] = raw.replace(/<[^>]+>/g, "").trim();
    }
    if (cells[keyField]) out.push(cells);
  }
  return out;
}
function num(v) {
  const n = parseFloat((v || "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

async function fetchFbrefPage(path, tableId, keyField) {
  const res = await fetch("https://fbref.com" + path, { headers: SCRAPE_HEADERS });
  const html = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from FBref ${path} — snippet: ${html.slice(0, 200).replace(/\s+/g, " ")}`);
  const rows = extractTable(html, tableId, keyField);
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

// ---------- 3. Club-level stats (shots, xG, possession, xGC/oppda, CBIT) ----------
// Understat's league page also embeds a second blob, teamsData, alongside
// playersData — season-aggregate numbers per club (goals/xG for and
// against, deep completions, PPDA — a standard proxy for pressing
// intensity / how high a team's press line sits). One extra regex on a
// page we're already fetching, no extra request.
async function scrapeUnderstatTeams() {
  const res = await fetch("https://understat.com/league/EPL", { headers: SCRAPE_HEADERS });
  const html = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from Understat — snippet: ${html.slice(0, 200).replace(/\s+/g, " ")}`);
  const match = html.match(/var\s+teamsData\s*=\s*JSON\.parse\('(.+?)'\);/);
  if (!match) throw new Error(`"teamsData" not found on the Understat league page — its layout may have changed.`);
  const jsonStr = match[1].replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const raw = JSON.parse(jsonStr);
  // raw is keyed by team id -> { title, history: [ {xG, xGA, deep, deep_allowed, ppda, ppda_allowed, scored, missed, ...}, ...one per match ] }
  return Object.values(raw).map(t => {
    const h = t.history || [];
    const sum = (key) => h.reduce((s, m) => s + (Number(m[key]) || 0), 0);
    const sumNested = (key, field) => h.reduce((s, m) => s + (m[key] && Number(m[key][field]) ? Number(m[key][field]) : 0), 0);
    const games = h.length || 1;
    return {
      name: t.title,
      xG: sum("xG"), xGA: sum("xGA"),
      goalsScored: sum("scored"), goalsConceded: sum("missed"),
      deep: sum("deep"), deepAllowed: sum("deep_allowed"),
      ppda: games ? sumNested("ppda", "att") / Math.max(1, sumNested("ppda", "def")) : null,
      ppdaAllowed: games ? sumNested("ppda_allowed", "att") / Math.max(1, sumNested("ppda_allowed", "def")) : null,
      games,
    };
  });
}
// FBref's team-level "possession" page has a squad-summary table (one row
// per club) alongside the usual per-player breakdown — data-stat="team" on
// those rows instead of "player", which is why extractTable takes a
// keyField now.
async function scrapeFbrefPossession() {
  return fetchFbrefPage("/en/comps/9/possession/Premier-League-Stats", "stats_squads_possession_for", "team").then(rows =>
    rows.map(r => ({ team: r.team, possession: num(r.possession), touchesAttPen: num(r.touches_att_pen_area) }))
  );
}
// Aggregates the already-scraped player-level Understat (shots/xG) and
// FBref (tackles/blocks/interceptions/clearances) rows up to club level —
// no extra fetches, just a group-by on data this Worker pulls anyway.
function aggregatePlayerStatsByClub(understatPlayers, fbrefPlayers) {
  const byClub = {};
  const bump = (team, field, val) => {
    if (!team) return;
    byClub[team] = byClub[team] || { team, shots: 0, xG: 0, tackles: 0, blocks: 0, interceptions: 0, clearances: 0 };
    byClub[team][field] += val;
  };
  for (const p of understatPlayers || []) { bump(p.team, "shots", p.shots || 0); bump(p.team, "xG", p.xG || 0); }
  for (const p of fbrefPlayers || []) {
    bump(p.team, "tackles", p.tackles || 0);
    bump(p.team, "blocks", p.blocks || 0);
    bump(p.team, "interceptions", p.interceptions || 0);
    bump(p.team, "clearances", p.clearances || 0);
  }
  return Object.values(byClub).map(c => ({ ...c, cbit: c.clearances + c.blocks + c.interceptions + c.tackles }));
}

async function handleClubStats(url, request) {
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const warnings = [];
  let understatPlayers = [], fbrefPlayers = [], understatTeams = [], possession = [];
  try { understatPlayers = await scrapeUnderstat(); } catch (e) { warnings.push("Understat players: " + e.message); }
  try { fbrefPlayers = await scrapeFbref(); } catch (e) { warnings.push("FBref defense/misc: " + e.message); }
  try { understatTeams = await scrapeUnderstatTeams(); } catch (e) { warnings.push("Understat teams: " + e.message); }
  try { possession = await scrapeFbrefPossession(); } catch (e) { warnings.push("FBref possession: " + e.message); }

  const clubAgg = aggregatePlayerStatsByClub(understatPlayers, fbrefPlayers);

  const body = JSON.stringify({ clubAgg, understatTeams, possession, warnings, syncedAt: new Date().toISOString() });
  const response = new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": warnings.length ? "no-store" : "public, max-age=86400",
    },
  });
  if (!warnings.length) await cache.put(cacheKey, response.clone());
  return response;
}
