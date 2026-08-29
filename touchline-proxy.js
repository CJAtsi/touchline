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
 *   4. Serves betting-odds-implied outcome probabilities from The Odds
 *      API (free tier, real bookmaker consensus — not scraped). Needs a
 *      free API key set as a Worker secret: wrangler secret put
 *      ODDS_API_KEY. Route: /odds
 *   5. Serves real historical match results (scorelines, shots, corners,
 *      cards — several past seasons) from football-data.co.uk's public,
 *      no-auth CSV files. Powers H2H's "past form / last meetings" panel
 *      AND the "does this club actually do worse against a low-block/
 *      compact opponent" read — both built from the same real results,
 *      no API key needed, no rate limit (static file hosting). Route:
 *      /pastform
 *   6. (Round 47, NEW) Serves real shot/chance-creation volume data from
 *      the FPL-Core-Insights GitHub project (olbauday/FPL-Core-Insights) —
 *      a free, actively-maintained (refreshed ~twice daily) public dataset
 *      distributed as plain CSV files on raw.githubusercontent.com. Unlike
 *      /deeperstats (Understat/FBref scraping, see that route's Round 46
 *      note — Understat's markers moved, FBref hard-403s) this is a static
 *      file host with no auth, no rate limit, and no bot-blocking risk —
 *      same reliability category as /pastform's football-data.co.uk CSVs
 *      below, which have never had scrape-breakage problems. Crucially,
 *      its players.csv carries FPL's OWN official player `code` field
 *      (bootstrap-static's element.code) directly, so index.html can join
 *      on that stable numeric id instead of fuzzy name-matching two
 *      independent naming conventions the way attachDeeperStats() has to.
 *      Route: /coreinsights
 *   7. (Round 42, NEW — not yet consumed by index.html by default, see
 *      that file's fetchShotMap/fetchShotData for the graceful-fallback
 *      wiring) Serves shot-level data — x/y location, distance, angle,
 *      xG per shot, situation (open play / corner / free kick / penalty),
 *      shot type (foot/head), result, and assisting player — scraped from
 *      Understat, which is the only one of this project's existing
 *      sources (Understat/FBref/football-data.co.uk) that exposes
 *      individual-shot detail rather than season aggregates. Two routes:
 *        /shotmap — the league's player-name -> Understat numeric player
 *          ID lookup (needed once per session; Understat's shot data is
 *          keyed by ITS OWN id, not FPL's), reusing the same playersData
 *          blob /clubstats already scrapes, with `id` now also captured.
 *        /shotdata/:understatId — one specific player's full shot list
 *          for the current season. Deliberately ONE PLAYER PER CALL (not
 *          a bulk "every player" route like /deeperstats) — Understat has
 *          no bulk shot-level endpoint, so getting everyone's shots means
 *          one fetch per player; doing that for ~600 players in a single
 *          request would blow past a Cloudflare Worker's per-request
 *          subrequest limit and hammer Understat. The app is expected to
 *          call this lazily, per player, when a user actually opens that
 *          player's detail view — see index.html's shot-quality section
 *          there for the graceful fallback when this route isn't deployed
 *          or a specific player's fetch fails.
 *
 * HOW TO DEPLOY
 * This project needs THREE files kept in sync on your repo's main branch:
 * index.html (the app), touchline-proxy.js (this file), and wrangler.toml
 * (the Worker's config — tells it to serve index.html as a static site AND
 * run this script for the API routes). Push all three to GitHub main and
 * the Worker rebuilds automatically. If you're pasting code directly into
 * the Cloudflare dashboard instead of using Git, you'll need to paste this
 * file's contents over the Worker's script AND make sure wrangler.toml's
 * [assets] block is applied too — without it, the site itself won't load
 * (you'll see a bare "Not Found" at the root URL).
 */

const FPL_BASE = "https://fantasy.premierleague.com/api";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Round 46 note: /clubstats currently reports BOTH Understat ("playersData"/
// "teamsData" not found, zero other JSON.parse vars on the page either - not
// a layout tweak, more likely the fetched page itself isn't real league-page
// content anymore) AND FBref (explicit HTTP 403 "Just a moment..." Cloudflare
// JS-challenge page) failing. The extra headers below (Accept-Language,
// Referer, sec-ch-ua/-platform - a fuller "real browser" fingerprint than
// just User-Agent+Accept) are a genuine improvement and may help Understat if
// its block is a simpler bot-signature check. They will NOT fix FBref's
// 403 - a Cloudflare JS challenge requires actually executing JavaScript in
// a browser to solve, which a Workers fetch() fundamentally cannot do
// regardless of headers. That one needs an actual decision (a paid scraping/
// challenge-solving API, a different defensive-stats source, or accepting
// FBref-derived columns as unavailable) rather than a header tweak - see
// this session's chat for the options laid out.
const SCRAPE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-platform": '"Windows"',
};

// Paths that are genuinely FPL API calls — everything else (the root "/",
// or any other path) is the static site and should be served from the
// assets binding, not proxied to FPL (which 404s on anything that isn't
// one of these exact endpoints).
const FPL_API_PREFIXES = ["/bootstrap-static", "/fixtures", "/event/", "/element-summary/", "/entry/", "/leagues-classic/"];
function isFplApiPath(pathname) {
  return FPL_API_PREFIXES.some(p => pathname.startsWith(p));
}

export default {
  async fetch(request, env) {
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
    if (url.pathname.startsWith("/odds")) {
      return handleOdds(url, request, env);
    }
    if (url.pathname.startsWith("/pastform")) {
      return handlePastForm(url, request);
    }
    if (url.pathname.startsWith("/coreinsights")) {
      return handleCoreInsights(url, request);
    }
    if (url.pathname === "/shotmap" || url.pathname === "/shotmap/") {
      return handleShotMap(url, request);
    }
    if (url.pathname.startsWith("/shotdata/")) {
      return handleShotData(url, request);
    }
    if (isFplApiPath(url.pathname)) {
      return handleFplProxy(url);
    }

    // Everything else — "/" for the app itself, or any other static path —
    // is served from the assets binding (see wrangler.toml's [assets]
    // block). If that binding isn't configured, this 404s, which is what
    // was happening before wrangler.toml had an [assets] section at all.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Static assets aren't configured for this Worker — check wrangler.toml has an [assets] block.", { status: 500 });
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
    // Round 42: `id` is Understat's OWN numeric player id (distinct from
    // FPL's element id) — was already present in the raw playersData blob
    // this function scrapes but previously discarded; now captured since
    // /shotmap needs it as the join key for /shotdata/:understatId.
    id: p.id != null ? Number(p.id) : null,
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

// ---------- 4. Betting odds (The Odds API) — real market-implied probabilities ----------
// Free tier: 500 credits/month, 1 credit per (market x region) call. A
// single call for uk region + h2h market = 1 credit; cached for 6h below,
// so even hourly polling stays far under the monthly cap. Requires a free
// key from https://the-odds-api.com set as a Worker secret:
//   wrangler secret put ODDS_API_KEY
// (or paste it into the Cloudflare dashboard under Settings > Variables).
// If the secret isn't set, this route returns an empty list with a
// warning rather than failing the whole app — same fail-quiet pattern as
// /deeperstats and /clubstats.
async function handleOdds(url, request, env) {
  if (!env.ODDS_API_KEY) {
    return new Response(JSON.stringify({ odds: [], warnings: ["ODDS_API_KEY not set — run: wrangler secret put ODDS_API_KEY (free key from the-odds-api.com)"], syncedAt: new Date().toISOString() }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const warnings = [];
  let odds = [];
  try {
    const target = `https://api.the-odds-api.com/v4/sports/soccer_epl/odds?regions=uk&markets=h2h&oddsFormat=decimal&apiKey=${env.ODDS_API_KEY}`;
    const res = await fetch(target);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status} — ${body.slice(0, 200)}`);
    }
    const raw = await res.json();
    // Collapse each match's multiple bookmakers down to the average
    // decimal price per outcome (a simple consensus), then also convert to
    // an implied (vig-adjusted) probability so the app doesn't have to
    // redo that math per fixture. Team names are the-odds-api's own
    // strings, not FPL's — matched fuzzily on the app side.
    odds = raw.map(m => {
      const priceSum = { home: 0, draw: 0, away: 0 };
      const priceN = { home: 0, draw: 0, away: 0 };
      for (const bk of m.bookmakers || []) {
        const h2h = (bk.markets || []).find(mk => mk.key === "h2h");
        if (!h2h) continue;
        for (const o of h2h.outcomes || []) {
          if (o.name === m.home_team) { priceSum.home += o.price; priceN.home++; }
          else if (o.name === m.away_team) { priceSum.away += o.price; priceN.away++; }
          else { priceSum.draw += o.price; priceN.draw++; } // "Draw"
        }
      }
      const avg = (k) => priceN[k] ? priceSum[k] / priceN[k] : null;
      const homePrice = avg("home"), drawPrice = avg("draw"), awayPrice = avg("away");
      let impliedHome = null, impliedDraw = null, impliedAway = null;
      if (homePrice && drawPrice && awayPrice) {
        const rawH = 1 / homePrice, rawD = 1 / drawPrice, rawA = 1 / awayPrice;
        const overround = rawH + rawD + rawA; // >1 due to bookmaker margin
        impliedHome = rawH / overround; impliedDraw = rawD / overround; impliedAway = rawA / overround;
      }
      return {
        homeTeam: m.home_team, awayTeam: m.away_team, commenceTime: m.commence_time,
        homePrice, drawPrice, awayPrice, impliedHome, impliedDraw, impliedAway,
        bookmakerCount: Math.max(priceN.home, priceN.draw, priceN.away),
      };
    });
    if (!odds.length) warnings.push("The Odds API returned 0 upcoming EPL matches — may just mean nothing's currently listed.");
  } catch (e) {
    warnings.push("Odds fetch failed: " + e.message);
  }

  const body = JSON.stringify({ odds, warnings, syncedAt: new Date().toISOString() });
  const response = new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      "Cache-Control": warnings.length ? "no-store" : "public, max-age=21600", // 6h
    },
  });
  if (!warnings.length) await cache.put(cacheKey, response.clone());
  return response;
}

// ---------- 5. Past form / results history (football-data.co.uk) ----------
// Plain static CSV, no auth, no rate limit — a genuinely different access
// method from the sites already confirmed blocked for this project
// (Sofascore/FotMob/Transfermarkt-live/FBref-live/Understat all 403 or
// need a real browser). One file per season at a fixed, predictable URL —
// https://www.football-data.co.uk/mmz4281/<YYYY><YY>/E0.csv — e.g. 2526
// for 2025/26. Pulls the current season plus the 3 before it (enough
// history for a "does this club do worse against a low-block/defensive
// opponent" read without re-fetching decades of stale form) and returns
// plain match rows; team-name matching against this app's own club list
// happens client-side (see matchClubByName/loadPastFormData in index.html)
// since football-data.co.uk's own club-name spelling ("Man City", "Nott'm
// Forest", "Spurs") doesn't always match FPL's.
function seasonCode(startYear) {
  const yy = String(startYear).slice(-2);
  const yy2 = String(startYear + 1).slice(-2);
  return yy + yy2;
}
function currentSeasonStartYear() {
  // Season "starts" in the summer (Aug) and runs into the following May —
  // before August, we're still in the season that started the PREVIOUS
  // calendar year.
  const now = new Date();
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? y : y - 1; // getUTCMonth() is 0-indexed; 6 = July, a safe early cutoff
}
// Minimal CSV parser — football-data.co.uk's files are a simple flat
// comma-separated grid with a header row, no quoted/embedded commas in the
// columns this route actually reads, so a naive split is genuinely
// sufficient (no need for a full CSV grammar here).
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];
  const header = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const cells = line.split(",");
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] !== undefined ? cells[i].trim() : ""; });
    return row;
  });
}
async function fetchSeasonCsv(startYear) {
  const code = seasonCode(startYear);
  const target = `https://www.football-data.co.uk/mmz4281/${code}/E0.csv`;
  const res = await fetch(target, { headers: { "Accept": "text/csv,*/*" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from football-data.co.uk (${code}) — snippet: ${text.slice(0, 150).replace(/\s+/g, " ")}`);
  const rows = parseCsv(text);
  return rows
    .filter(r => r.HomeTeam && r.AwayTeam && r.FTHG !== "" && r.FTAG !== "")
    .map(r => ({
      season: `${startYear}/${String(startYear + 1).slice(-2)}`,
      date: r.Date || "",
      homeTeam: r.HomeTeam, awayTeam: r.AwayTeam,
      fthg: Number(r.FTHG) || 0, ftag: Number(r.FTAG) || 0, ftr: r.FTR || "",
      hthg: r.HTHG !== undefined && r.HTHG !== "" ? Number(r.HTHG) : null,
      htag: r.HTAG !== undefined && r.HTAG !== "" ? Number(r.HTAG) : null,
      hs: r.HS !== undefined && r.HS !== "" ? Number(r.HS) : null, as: r.AS !== undefined && r.AS !== "" ? Number(r.AS) : null,
      hst: r.HST !== undefined && r.HST !== "" ? Number(r.HST) : null, ast: r.AST !== undefined && r.AST !== "" ? Number(r.AST) : null,
      hc: r.HC !== undefined && r.HC !== "" ? Number(r.HC) : null, ac: r.AC !== undefined && r.AC !== "" ? Number(r.AC) : null,
    }));
}
async function handlePastForm(url, request) {
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const startYear = currentSeasonStartYear();
  const seasons = [startYear, startYear - 1, startYear - 2, startYear - 3];
  const warnings = [];
  const results = await Promise.all(seasons.map(async (y) => {
    try { return await fetchSeasonCsv(y); } catch (e) { warnings.push(`Season ${seasonCode(y)}: ${e.message}`); return []; }
  }));
  const matches = results.flat();

  const body = JSON.stringify({ matches, seasons: seasons.map(seasonCode), warnings, syncedAt: new Date().toISOString() });
  const response = new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      // The current season's file grows every matchday; cache for a few
      // hours rather than a full day like the fully-static deeper-stats
      // scrapes, so a finished gameweek's results show up reasonably soon.
      "Cache-Control": (!matches.length) ? "no-store" : "public, max-age=10800",
    },
  });
  if (matches.length) await cache.put(cacheKey, response.clone());
  return response;
}

// ---------- 6. Core Insights: real shot/chance-creation volume (Round 47, NEW) ----------
// Data source: olbauday/FPL-Core-Insights on GitHub — a free, actively
// maintained (refreshed ~twice daily per the repo's own README) fusion of
// the official FPL API with detailed match stats, distributed as plain CSV
// files fetched raw from GitHub (no auth, no rate limit — a static file
// host, not a scraped page). Two files matter here:
//   - data/<season>/players.csv — one row per player, columns
//     player_code,player_id,first_name,second_name,web_name,team_code,position.
//     player_code IS FPL's own official element.code — confirmed by
//     cross-referencing a known player during this round's research. This
//     repo's OWN player_id (different, dataset-internal) is what the
//     per-gameweek files below key off, so players.csv is the bridge:
//     this repo's player_id -> FPL's player_code.
//   - data/<season>/By Gameweek/GW<N>/playermatchstats.csv — one row PER
//     PLAYER PER MATCH for gameweek N. Columns include player_id,
//     minutes_played, total_shots, shots_on_target, chances_created, xg,
//     xa, big_chances_missed, plus (Round 48, NEW — read here since this
//     round) real defensive/physical columns this project previously had
//     no working source for at all: tackles_won, interceptions,
//     recoveries, blocks, clearances, headed_clearances, duels_won,
//     duels_lost, aerial_duels_won, aerial_duels_won_percent,
//     defensive_contributions (FPL's own real DefCon metric), and for
//     keepers: saves, goals_conceded, goals_prevented (post-shot xG minus
//     actual goals conceded — a real shot-stopping quality read FPL's own
//     API doesn't expose at all).
const CORE_INSIGHTS_SEASON = "2025-2026"; // verified live during this round, August 2026 — matches this project's current season
const CORE_INSIGHTS_BASE = `https://raw.githubusercontent.com/olbauday/FPL-Core-Insights/main/data/${CORE_INSIGHTS_SEASON}`;
// How many trailing gameweeks of playermatchstats.csv to fetch and sum, per
// request. This is deliberately a WINDOW, not the whole season — fetching
// every gameweek back to GW1 every request would mean up to ~38 subrequests
// on top of the players.csv fetch, which is wasteful (this data barely
// shifts a per-90 rate once a player has a reasonable sample) and risks
// Cloudflare Workers' per-request subrequest ceiling as the season goes on.
// 8 gameweeks is enough matches for a stable shots/chances-created per-90
// read (most outfield rotation players will have 5+ actual appearances in
// an 8-GW window) while staying well inside the subrequest budget (8
// gameweek files + 1 players.csv = 9 subrequests, worst case one retry
// each).
const CORE_INSIGHTS_WINDOW = 8;
async function fetchCoreInsightsCsv(path) {
  const res = await fetch(`${CORE_INSIGHTS_BASE}/${path}`, { headers: { "Accept": "text/csv,*/*" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from FPL-Core-Insights (${path})`);
  return parseCsv(text);
}
async function handleCoreInsights(url, request) {
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  // ?gw=<N> — the app already knows the current gameweek from its own
  // bootstrap-static call (state.events' is_current/is_next), which is far
  // simpler than having this Worker fetch bootstrap-static itself just to
  // work that out. Falls back to a generously-high guess (38, i.e. "try the
  // whole season back to GW1 within the window size") when the caller
  // doesn't pass one, so the route still returns something useful rather
  // than erroring — the per-gameweek 404-skip logic below makes an
  // over-guess harmless.
  const gwParam = parseInt(url.searchParams.get("gw"), 10);
  const currentGw = Number.isFinite(gwParam) && gwParam > 0 ? gwParam : 38;
  const gwList = [];
  for (let gw = currentGw; gw > 0 && gwList.length < CORE_INSIGHTS_WINDOW; gw--) gwList.push(gw);

  const warnings = [];
  let playersCsv = [];
  try {
    playersCsv = await fetchCoreInsightsCsv("players.csv");
  } catch (e) {
    warnings.push("players.csv: " + e.message);
  }
  // Bridge: this repo's own player_id -> FPL's real element.code.
  const codeByPlayerId = {};
  for (const r of playersCsv) {
    const pid = parseInt(r.player_id, 10);
    const code = parseInt(r.player_code, 10);
    if (Number.isFinite(pid) && Number.isFinite(code)) codeByPlayerId[pid] = code;
  }

  const gwResults = await Promise.all(gwList.map(async (gw) => {
    try {
      const rows = await fetchCoreInsightsCsv(`By%20Gameweek/GW${gw}/playermatchstats.csv`);
      return { gw, rows };
    } catch (e) {
      // A missing gameweek (season hasn't reached it yet, or a numbering
      // gap) is expected and should not fail the whole route — same
      // resilience philosophy as handlePastForm's per-season try/catch.
      warnings.push(`GW${gw}: ${e.message}`);
      return { gw, rows: [] };
    }
  }));
  const gameweeksCovered = gwResults.filter(r => r.rows.length).map(r => r.gw);

  // Aggregate playermatchstats rows by this repo's player_id across every
  // gameweek actually fetched.
  const agg = {};
  for (const { rows } of gwResults) {
    for (const r of rows) {
      const pid = parseInt(r.player_id, 10);
      if (!Number.isFinite(pid)) continue;
      if (!agg[pid]) agg[pid] = {
        totalShots: 0, shotsOnTarget: 0, chancesCreated: 0, xg: 0, xa: 0, bigChancesMissed: 0, minutes: 0, matchesCounted: 0,
        // Round 48: defensive actions (replaces the FBref-403 gap) + GK shot-stopping.
        tackles: 0, interceptions: 0, recoveries: 0, blocks: 0, clearances: 0, headedClearances: 0,
        duelsWon: 0, duelsLost: 0, aerialDuelsWon: 0, aerialDuelsWonSampleMinutes: 0, defensiveContributions: 0,
        saves: 0, goalsConceded: 0, goalsPrevented: 0,
      };
      const a = agg[pid];
      a.totalShots += num(r.total_shots);
      a.shotsOnTarget += num(r.shots_on_target);
      a.chancesCreated += num(r.chances_created);
      a.xg += num(r.xg);
      a.xa += num(r.xa);
      a.bigChancesMissed += num(r.big_chances_missed);
      a.minutes += num(r.minutes_played);
      a.matchesCounted += 1;
      a.tackles += num(r.tackles_won);
      a.interceptions += num(r.interceptions);
      a.recoveries += num(r.recoveries);
      a.blocks += num(r.blocks);
      a.clearances += num(r.clearances);
      a.headedClearances += num(r.headed_clearances);
      a.duelsWon += num(r.duels_won);
      a.duelsLost += num(r.duels_lost);
      a.aerialDuelsWon += num(r.aerial_duels_won);
      // aerial_duels_won_percent is per-match; weight-average it by minutes
      // played that match rather than summing a percentage across matches.
      if (r.aerial_duels_won_percent !== "" && r.aerial_duels_won_percent != null) {
        a.aerialDuelsWonSampleMinutes += num(r.minutes_played);
        a._aerialPctWeighted = (a._aerialPctWeighted || 0) + num(r.aerial_duels_won_percent) * num(r.minutes_played);
      }
      a.defensiveContributions += num(r.defensive_contributions);
      a.saves += num(r.saves);
      a.goalsConceded += num(r.goals_conceded);
      a.goalsPrevented += num(r.goals_prevented);
    }
  }

  // Join to FPL's player_code so the response is keyed by a stable id the
  // client can match directly against p.code — no name normalization
  // needed on either side.
  const players = [];
  for (const [pidStr, a] of Object.entries(agg)) {
    const playerCode = codeByPlayerId[Number(pidStr)];
    if (playerCode == null) continue; // no players.csv row for this id — can't join, so can't return it usefully
    // Collapse the internal weighted-sum accumulator into a real average
    // percentage before shipping the row — _aerialPctWeighted is scratch
    // state, not something the client should see.
    const aerialDuelsWonPercent = a.aerialDuelsWonSampleMinutes > 0
      ? (a._aerialPctWeighted || 0) / a.aerialDuelsWonSampleMinutes
      : null;
    const { _aerialPctWeighted, aerialDuelsWonSampleMinutes, ...rest } = a;
    players.push({ playerCode, ...rest, aerialDuelsWonPercent });
  }
  if (playersCsv.length && !players.length) warnings.push("players.csv loaded but no playermatchstats rows joined to a player_code — check column names haven't changed upstream.");

  const body = JSON.stringify({ players, gameweeksCovered, syncedAt: new Date().toISOString(), warnings });
  const response = new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      // The source refreshes ~twice daily (per its own README) — much more
      // often than /deeperstats' fully-static day-old scrapes, but it's
      // still not live/per-minute data, so a few hours strikes a reasonable
      // balance between freshness and not re-fetching 9 CSV files on every
      // page load. 4 hours means a finished gameweek's stats are reflected
      // well within the same day without needing an aggressive cache-bust.
      "Cache-Control": players.length ? "public, max-age=14400" : "no-store",
    },
  });
  if (players.length) await cache.put(cacheKey, response.clone());
  return response;
}

// ---------- 7. Shot-level data (Round 42, NEW) ----------
// Understat is the only one of this project's three scrape sources that
// exposes per-shot detail (x/y location, xG, situation, shot type, result,
// assisting player) rather than season aggregates — confirmed via the
// `understat` Python package's documented schema and the actively
// maintained `worldfootballR` R package's real scraper source (both
// independently name the embedded page variable `shotsData` and the same
// field set: id, minute, result, X, Y, xG, player, h_a, situation,
// shotType, match_id, player_assisted, lastAction). This mirrors that
// exact convention — same hex-decode-then-JSON.parse approach
// scrapeUnderstat/scrapeUnderstatTeams already use on the league page, just
// pointed at a player page instead. NOT independently verified against a
// live fetch from this environment (Understat blocks this sandbox's own
// fetch tooling via robots.txt / bot detection — the existing /clubstats
// and /deeperstats routes already work around that by running from a real
// Cloudflare Worker IP with a real browser User-Agent, which this route
// reuses via SCRAPE_HEADERS) - deploy and check /shotdata/<id> for one
// known player before trusting this in the live app.
//
// Angle/distance are NOT raw Understat fields (confirmed absent from both
// reference sources above) - both are simple geometry derived from X/Y
// here server-side, so the app never needs to reimplement the goal-mouth
// math client-side. Understat's pitch is normalized 0-1 with the away
// goal at x=1, y=0.5 (standard Understat convention, attacking left-to-
// right regardless of home/away) - shotDistanceYards/shotAngleDegrees
// below assume a 105m x 68m pitch (the standard/most common professional
// pitch dimensions; Understat doesn't publish the exact one it normalizes
// against, so this is a reasonable, clearly-labelled approximation, not a
// precise reverse-engineering of Understat's own unit scale).
const PITCH_LENGTH_M = 105, PITCH_WIDTH_M = 68, GOAL_WIDTH_M = 7.32;
function shotGeometry(xNorm, yNorm) {
  const x = xNorm * PITCH_LENGTH_M, y = yNorm * PITCH_WIDTH_M;
  const goalX = PITCH_LENGTH_M, goalCenterY = PITCH_WIDTH_M / 2;
  const dx = goalX - x, dy = y - goalCenterY;
  const distanceM = Math.sqrt(dx * dx + dy * dy);
  // Angle subtended by the goal mouth from the shot location (the standard
  // "shot angle" xG feature) — via the two goalpost positions, not just a
  // straight-line bearing to the centre spot, since a shot from a tight
  // angle right next to the byline is a very different chance than one
  // from the same distance straight in front of goal even though both can
  // have a similar bearing-to-centre.
  const postA = { x: goalX, y: goalCenterY - GOAL_WIDTH_M / 2 };
  const postB = { x: goalX, y: goalCenterY + GOAL_WIDTH_M / 2 };
  const angToA = Math.atan2(postA.y - y, postA.x - x);
  const angToB = Math.atan2(postB.y - y, postB.x - x);
  let angleDeg = Math.abs((angToA - angToB) * (180 / Math.PI));
  if (angleDeg > 180) angleDeg = 360 - angleDeg;
  return {
    distanceYards: Math.round(distanceM * 1.09361 * 10) / 10,
    angleDegrees: Math.round(angleDeg * 10) / 10,
  };
}
// /shotmap — the league's Understat-player-id lookup. Deliberately its own
// tiny route (not folded into /clubstats' existing response) so the app
// can fetch just this small id-lookup table once per session/cache window
// without pulling the rest of /clubstats' payload along with it, and so a
// future per-player /shotdata call always has a fresh id to key off even
// if /clubstats' own cache is stale.
async function handleShotMap(url, request) {
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const warnings = [];
  let players = [];
  try {
    const all = await scrapeUnderstat();
    players = all.filter(p => p.id != null).map(p => ({ id: p.id, name: p.name, team: p.team }));
    if (!players.length) warnings.push("Understat returned 0 players with a usable id — page structure may have changed.");
  } catch (e) {
    warnings.push("Understat player-id lookup failed: " + e.message);
  }

  const body = JSON.stringify({ players, warnings, syncedAt: new Date().toISOString() });
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
// /shotdata/:understatId — one player's full shot list for the current
// season, scraped from https://understat.com/player/:id (the shotsData
// blob embedded there, same hex-decode-then-JSON.parse pattern as
// playersData/teamsData on the league page). Deliberately single-player
// per call — see the file-header comment for why this isn't a bulk route.
async function scrapeUnderstatPlayerShots(understatId) {
  const res = await fetch(`https://understat.com/player/${understatId}`, { headers: SCRAPE_HEADERS });
  const html = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from Understat player ${understatId} — snippet: ${html.slice(0, 200).replace(/\s+/g, " ")}`);
  const match = html.match(/var\s+shotsData\s*=\s*JSON\.parse\('(.+?)'\);/);
  if (!match) {
    const idx = html.indexOf("shotsData");
    if (idx !== -1) {
      throw new Error(`"shotsData" found at index ${idx} but didn't match the expected pattern — context: ${html.slice(idx - 40, idx + 200).replace(/\s+/g, " ")}`);
    }
    throw new Error(`"shotsData" not found on Understat player ${understatId}'s page — id may be wrong, or the page layout changed.`);
  }
  const jsonStr = match[1].replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const raw = JSON.parse(jsonStr);
  return raw.map(s => {
    const xNorm = Number(s.X), yNorm = Number(s.Y);
    const geo = (Number.isFinite(xNorm) && Number.isFinite(yNorm)) ? shotGeometry(xNorm, yNorm) : { distanceYards: null, angleDegrees: null };
    return {
      id: s.id, minute: Number(s.minute) || 0, result: s.result || "",
      x: xNorm, y: yNorm, xG: Number(s.xG) || 0,
      distanceYards: geo.distanceYards, angleDegrees: geo.angleDegrees,
      situation: s.situation || "", shotType: s.shotType || "",
      lastAction: s.lastAction || "", player: s.player || "",
      playerAssisted: s.player_assisted || null,
      isHome: s.h_a === "h", season: s.season || null, date: s.date || null,
      matchId: s.match_id != null ? Number(s.match_id) : null,
    };
  });
}
async function handleShotData(url, request) {
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const parts = url.pathname.split("/").filter(Boolean); // ["shotdata", "1250"]
  const understatId = parts[1];
  if (!understatId || !/^\d+$/.test(understatId)) {
    return new Response(JSON.stringify({ shots: [], warnings: ["No valid Understat player id given — expected /shotdata/<numeric id>, get ids from /shotmap first."], syncedAt: new Date().toISOString() }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const warnings = [];
  let shots = [];
  try {
    shots = await scrapeUnderstatPlayerShots(understatId);
  } catch (e) {
    warnings.push(e.message);
  }

  const body = JSON.stringify({ understatId: Number(understatId), shots, warnings, syncedAt: new Date().toISOString() });
  const response = new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json",
      // A day is the same cadence /deeperstats and /clubstats already use
      // for season-aggregate scrapes — a player's shot history only grows
      // after a real match, so daily is plenty fresh without hammering
      // Understat on every player-detail-panel open.
      "Cache-Control": warnings.length ? "no-store" : "public, max-age=86400",
    },
  });
  if (!warnings.length) await cache.put(cacheKey, response.clone());
  return response;
}
