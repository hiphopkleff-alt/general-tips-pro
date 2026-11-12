"use strict";

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

const API_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const API_BASE = "https://api.football-data.org/v4";
const TIME_ZONE = "Africa/Lagos";

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.static(__dirname));

/* =====================================
   CACHE STORAGE
===================================== */

const fixtureCache = {
  data: null,
  expiresAt: 0,
  dateFrom: null,
  dateTo: null
};

const analysisCache = new Map();
const teamCache = new Map();
const matchCache = new Map();

const teamPending = new Map();
const analysisPending = new Map();

let pendingFixtures = null;

/* =====================================
   API REQUEST QUEUE
===================================== */

const API_REQUEST_INTERVAL = 6500;

const apiQueue = [];
const apiPendingRequests = new Map();

let apiQueueTimer = null;
let apiRequestRunning = false;
let lastApiRequestAt = 0;
let queueSequence = 0;

function priorityWeight(priority) {
  if (priority === "high") return 0;
  if (priority === "normal") return 1;
  return 2;
}

function normalizePriority(priority) {
  if (priority === "high") return "high";
  if (priority === "normal") return "normal";
  return "background";
}

function promoteFootballRequest(endpoint, priority) {
  const task = apiPendingRequests.get(endpoint);

  if (!task || task.state !== "queued") return;

  if (priorityWeight(priority) < priorityWeight(task.priority)) {
    task.priority = priority;

    if (apiQueueTimer) {
      clearTimeout(apiQueueTimer);
      apiQueueTimer = null;
    }

    processApiQueue();
  }
}

function processApiQueue() {
  if (
    apiRequestRunning ||
    apiQueueTimer ||
    !apiQueue.length
  ) {
    return;
  }

  const wait = Math.max(
    0,
    API_REQUEST_INTERVAL - (Date.now() - lastApiRequestAt)
  );

  apiQueueTimer = setTimeout(async () => {
    apiQueueTimer = null;

    if (apiRequestRunning || !apiQueue.length) {
      processApiQueue();
      return;
    }

    apiQueue.sort((a, b) => {
      const difference =
        priorityWeight(a.priority) -
        priorityWeight(b.priority);

      return difference || a.sequence - b.sequence;
    });

    const task = apiQueue.shift();

    if (!task) return;

    task.state = "running";
    apiRequestRunning = true;
    lastApiRequestAt = Date.now();

    try {
      console.log(
        "Football API:",
        task.endpoint,
        "| Priority:",
        task.priority
      );

      const response = await fetch(
        API_BASE + task.endpoint,
        {
          method: "GET",
          headers: {
            "X-Auth-Token": API_TOKEN,
            "Accept": "application/json"
          },
          signal: AbortSignal.timeout(25000)
        }
      );

      if (!response.ok) {
        const body = await response.text();

        const error = new Error(
          `Football API HTTP ${response.status}: ${body}`
        );

        error.status = response.status;
        throw error;
      }

      task.resolve(await response.json());

    } catch (error) {
      task.reject(error);

    } finally {
      if (apiPendingRequests.get(task.endpoint) === task) {
        apiPendingRequests.delete(task.endpoint);
      }

      apiRequestRunning = false;
      processApiQueue();
    }

  }, wait);
}

function footballRequest(endpoint, priority = "background") {
  priority = normalizePriority(priority);

  if (!API_TOKEN) {
    return Promise.reject(
      new Error("FOOTBALL_DATA_TOKEN is not configured.")
    );
  }

  const existing = apiPendingRequests.get(endpoint);

  if (existing) {
    promoteFootballRequest(endpoint, priority);
    return existing.promise;
  }

  let resolveRequest;
  let rejectRequest;

  const promise = new Promise((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });

  const task = {
    endpoint,
    priority,
    state: "queued",
    sequence: queueSequence++,
    promise,
    resolve: resolveRequest,
    reject: rejectRequest
  };

  apiPendingRequests.set(endpoint, task);
  apiQueue.push(task);

  processApiQueue();

  return promise;
}

/* =====================================
   NIGERIA DATE RANGE
===================================== */

function getNigeriaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00Z`);

  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

function getFixtureDateRange() {
  const dateFrom = getNigeriaDate();

  return {
    dateFrom,
    dateTo: addDays(dateFrom, 7)
  };
}

/* =====================================
   CACHE HELPERS
===================================== */

function cacheGet(cache, key) {
  const item = cache.get(key);

  if (!item || Date.now() > item.expiresAt) {
    cache.delete(key);
    return null;
  }

  return item.data;
}

function cacheSet(cache, key, data, minutes) {
  cache.set(key, {
    data,
    expiresAt: Date.now() + minutes * 60 * 1000
  });
}

/* =====================================
   MATCH INFORMATION
===================================== */

function saveFixtureMatches(matches) {
  for (const match of matches || []) {
    if (!match?.id) continue;

    cacheSet(
      matchCache,
      String(match.id),
      match,
      60
    );
  }
}

async function getMatchInformation(matchId, priorityState) {
  const key = String(matchId);

  const cached = cacheGet(matchCache, key);

  if (cached) return cached;

  const match = await footballRequest(
    `/matches/${encodeURIComponent(key)}`,
    priorityState.priority
  );

  cacheSet(matchCache, key, match, 60);

  return match;
}

/* =====================================
   POISSON MODEL
===================================== */

function poisson(lambda, goals) {
  if (!Number.isFinite(lambda) || lambda < 0) {
    return 0;
  }

  let probability = Math.exp(-lambda);

  for (let i = 1; i <= goals; i++) {
    probability *= lambda / i;
  }

  return probability;
}

function calculateProbabilities(homeXG, awayXG) {
  let home = 0;
  let draw = 0;
  let away = 0;

  let over05 = 0;
  let over15 = 0;
  let over25 = 0;
  let over35 = 0;

  let bttsYes = 0;

  const maxGoals = 12;

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const probability =
        poisson(homeXG, h) *
        poisson(awayXG, a);

      if (h > a) home += probability;
      else if (h === a) draw += probability;
      else away += probability;

      const total = h + a;

      if (total >= 1) over05 += probability;
      if (total >= 2) over15 += probability;
      if (total >= 3) over25 += probability;
      if (total >= 4) over35 += probability;

      if (h > 0 && a > 0) {
        bttsYes += probability;
      }
    }
  }

  return {
    homeWin: home * 100,
    draw: draw * 100,
    awayWin: away * 100,

    doubleChance1X: (home + draw) * 100,
    doubleChanceX2: (draw + away) * 100,
    doubleChance12: (home + away) * 100,

    over05: over05 * 100,
    under05: (1 - over05) * 100,

    over15: over15 * 100,
    under15: (1 - over15) * 100,

    over25: over25 * 100,
    under25: (1 - over25) * 100,

    over35: over35 * 100,
    under35: (1 - over35) * 100,

    bttsYes: bttsYes * 100,
    bttsNo: (1 - bttsYes) * 100
  };
}

/* =====================================
   TEAM STATISTICS
===================================== */

function getTeamStats(matches, teamId) {
  const finished = (matches || [])
    .filter(match => match.status === "FINISHED")
    .slice(0, 10);

  let played = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;

  let goalsFor = 0;
  let goalsAgainst = 0;

  const form = [];

  for (const match of finished) {
    const homeId = match.homeTeam?.id;
    const awayId = match.awayTeam?.id;

    const homeGoals = match.score?.fullTime?.home;
    const awayGoals = match.score?.fullTime?.away;

    if (
      homeGoals == null ||
      awayGoals == null
    ) {
      continue;
    }

    let scored;
    let conceded;

    if (homeId === teamId) {
      scored = homeGoals;
      conceded = awayGoals;
    } else if (awayId === teamId) {
      scored = awayGoals;
      conceded = homeGoals;
    } else {
      continue;
    }

    played++;

    goalsFor += scored;
    goalsAgainst += conceded;

    if (scored > conceded) {
      wins++;
      form.push("W");
    } else if (scored === conceded) {
      draws++;
      form.push("D");
    } else {
      losses++;
      form.push("L");
    }
  }

  return {
    played,
    wins,
    draws,
    losses,
    goalsFor,
    goalsAgainst,

    averageGoalsFor:
      played ? goalsFor / played : 0,

    averageGoalsAgainst:
      played ? goalsAgainst / played : 0,

    form
  };
}

/* =====================================
   TEAM HISTORY
===================================== */

async function getTeamHistory(teamId, priorityState) {
  const key = String(teamId);

  const cached = cacheGet(teamCache, key);

  if (cached) return cached;

  const existing = teamPending.get(key);

  if (existing) {
    promoteFootballRequest(
      existing.endpoint,
      priorityState.priority
    );

    return existing.promise;
  }

  const endpoint =
    `/teams/${encodeURIComponent(key)}/matches?status=FINISHED&limit=10`;

  const request = footballRequest(
    endpoint,
    priorityState.priority
  )
    .then(data => {
      const matches = data.matches || [];

      cacheSet(teamCache, key, matches, 60);

      return matches;
    })
    .finally(() => {
      teamPending.delete(key);
    });

  teamPending.set(key, {
    endpoint,
    promise: request
  });

  return request;
}

/* =====================================
   MARKET RECOMMENDATIONS
===================================== */

function makeRecommendations(probabilities) {
  const definitions = [
    ["Home Win", "homeWin"],
    ["Draw", "draw"],
    ["Away Win", "awayWin"],

    ["Double Chance 1X", "doubleChance1X"],
    ["Double Chance X2", "doubleChanceX2"],
    ["Double Chance 12", "doubleChance12"],

    ["Over 0.5 Goals", "over05"],
    ["Under 0.5 Goals", "under05"],

    ["Over 1.5 Goals", "over15"],
    ["Under 1.5 Goals", "under15"],

    ["Over 2.5 Goals", "over25"],
    ["Under 2.5 Goals", "under25"],

    ["Over 3.5 Goals", "over35"],
    ["Under 3.5 Goals", "under35"],

    ["BTTS Yes", "bttsYes"],
    ["BTTS No", "bttsNo"]
  ];

  return definitions
    .map(([market, key]) => ({
      market,
      key,
      probability: probabilities[key]
    }))
    .filter(item =>
      Number.isFinite(item.probability) &&
      item.probability > 0 &&
      item.probability <= 100
    )
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 3)
    .map((item, index) => ({
      rank: index + 1,
      market: item.market,
      key: item.key,
      probability: Number(item.probability.toFixed(1)),
      confidence:
        item.probability >= 75
          ? "HIGH"
          : item.probability >= 60
            ? "MODERATE"
            : "LOW"
    }));
}

/* =====================================
   BUILD MATCH ANALYSIS
===================================== */

async function buildMatchAnalysis(matchId, priorityState) {
  const match = await getMatchInformation(
    matchId,
    priorityState
  );

  if (
    !match.homeTeam?.id ||
    !match.awayTeam?.id
  ) {
    const error = new Error(
      "Team information is unavailable."
    );

    error.status = 422;
    throw error;
  }

  const homeId = match.homeTeam.id;
  const awayId = match.awayTeam.id;

  const [homeMatches, awayMatches] = await Promise.all([
    getTeamHistory(homeId, priorityState),
    getTeamHistory(awayId, priorityState)
  ]);

  const homeStats = getTeamStats(homeMatches, homeId);
  const awayStats = getTeamStats(awayMatches, awayId);

  if (!homeStats.played || !awayStats.played) {
    const error = new Error(
      "Not enough completed team matches for reliable analysis."
    );

    error.status = 422;
    error.homeMatchesAvailable = homeStats.played;
    error.awayMatchesAvailable = awayStats.played;

    throw error;
  }

  const homeXG = Math.max(
    0.2,
    Math.min(
      4,
      (
        homeStats.averageGoalsFor +
        awayStats.averageGoalsAgainst
      ) / 2
    )
  );

  const awayXG = Math.max(
    0.2,
    Math.min(
      4,
      (
        awayStats.averageGoalsFor +
        homeStats.averageGoalsAgainst
      ) / 2
    )
  );

  const probabilities = calculateProbabilities(
    homeXG,
    awayXG
  );

  const recommendations = makeRecommendations(probabilities);

  const roundedProbabilities = Object.fromEntries(
    Object.entries(probabilities).map(([key, value]) => [
      key,
      Number(value.toFixed(1))
    ])
  );

  return {
    match: {
      id: match.id,
      utcDate: match.utcDate,
      status: match.status,

      homeTeam: {
        id: match.homeTeam.id,
        name: match.homeTeam.name,
        crest: match.homeTeam.crest || ""
      },

      awayTeam: {
        id: match.awayTeam.id,
        name: match.awayTeam.name,
        crest: match.awayTeam.crest || ""
      },

      competition: {
        id: match.competition?.id || null,
        name: match.competition?.name || "Unknown"
      },

      score: match.score || {}
    },

    model: {
      name: "GENERAL TIPS Statistical Model",
      expectedHomeGoals: Number(homeXG.toFixed(2)),
      expectedAwayGoals: Number(awayXG.toFixed(2)),
      matchesPerTeam: 10,
      note: "Estimates based on available recent completed match results."
    },

    teamForm: {
      home: homeStats,
      away: awayStats
    },

    probabilities: roundedProbabilities,

    recommendations,

    limitations: [
      "Probabilities are model estimates, not guarantees.",
      "Recent results may include different competitions.",
      "Injuries, suspensions and confirmed line-ups are not included.",
      "The model does not use bookmaker odds."
    ],

    generatedAt: new Date().toISOString()
  };
}

/* =====================================
   HEALTH CHECK
===================================== */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "GENERAL FOOTBALL TIPS V1.0",
    apiKeyConfigured: Boolean(API_TOKEN),
    timezone: TIME_ZONE,
    queuedRequests: apiQueue.length,
    runningRequest: apiRequestRunning,
    cachedFixtures: Boolean(fixtureCache.data),
    cachedAnalyses: analysisCache.size,
    cachedTeams: teamCache.size,
    cachedMatches: matchCache.size,
    pendingAnalyses: analysisPending.size
  });
});

/* =====================================
   FIXTURES
===================================== */

app.get("/api/fixtures", async (req, res) => {
  if (!API_TOKEN) {
    return res.status(503).json({
      error: "Football API token is not configured."
    });
  }

  const forceRefresh = req.query.refresh === "1";

  const { dateFrom, dateTo } = getFixtureDateRange();

  if (
    !forceRefresh &&
    fixtureCache.data &&
    Date.now() < fixtureCache.expiresAt &&
    fixtureCache.dateFrom === dateFrom &&
    fixtureCache.dateTo === dateTo
  ) {
    return res.json(fixtureCache.data);
  }

  if (!pendingFixtures) {
    pendingFixtures = footballRequest(
      `/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`,
      "normal"
    )
      .then(data => {
        const matches = (data.matches || [])
          .sort((a, b) =>
            new Date(a.utcDate) - new Date(b.utcDate)
          );

        saveFixtureMatches(matches);

        const result = {
          count: matches.length,
          matches,
          dateFrom,
          dateTo,
          interval: "7 days",
          timezone: TIME_ZONE,
          updatedAt: new Date().toISOString()
        };

        fixtureCache.data = result;
        fixtureCache.dateFrom = dateFrom;
        fixtureCache.dateTo = dateTo;
        fixtureCache.expiresAt =
          Date.now() + 5 * 60 * 1000;

        return result;
      });
  }

  try {
    const result = await pendingFixtures;
    res.json(result);

  } catch (error) {
    console.error("Fixture error:", error.message);

    res.status(error.status || 500).json({
      error: "Unable to load football fixtures.",
      details: error.message
    });

  } finally {
    if (pendingFixtures) {
      pendingFixtures = null;
    }
  }
});

/* =====================================
   MATCH ANALYSIS
===================================== */

app.get("/api/match/:id/analysis", async (req, res) => {
  const matchId = req.params.id;

  if (!/^\d+$/.test(matchId)) {
    return res.status(400).json({
      error: "Invalid match ID."
    });
  }

  const priority = normalizePriority(req.query.priority);

  const cached = cacheGet(analysisCache, matchId);

  if (cached) {
    return res.json(cached);
  }

  try {
    let pending = analysisPending.get(matchId);

    if (pending) {
      if (
        priorityWeight(priority) <
        priorityWeight(pending.priorityState.priority)
      ) {
        pending.priorityState.priority = priority;
      }

      promoteFootballRequest(
        `/matches/${matchId}`,
        priority
      );

    } else {
      const priorityState = { priority };

      const promise = buildMatchAnalysis(
        matchId,
        priorityState
      )
        .then(result => {
          cacheSet(analysisCache, matchId, result, 60);
          return result;
        })
        .finally(() => {
          analysisPending.delete(matchId);
        });

      pending = {
        promise,
        priorityState
      };

      analysisPending.set(matchId, pending);
    }

    const result = await pending.promise;

    res.json(result);

  } catch (error) {
    console.error(
      "Analysis error:",
      matchId,
      error.message
    );

    res.status(error.status || 500).json({
      error: "Unable to analyse this match.",
      details: error.message,
      homeMatchesAvailable: error.homeMatchesAvailable,
      awayMatchesAvailable: error.awayMatchesAvailable
    });
  }
});

/* =====================================
   FRONTEND ROUTE
===================================== */

app.get("*", (req, res) => {
  res.sendFile(
    path.join(__dirname, "index.html")
  );
});

/* =====================================
   SERVER START
===================================== */

app.listen(PORT, () => {
  console.log(
    `GENERAL FOOTBALL TIPS V1.0 running on port ${PORT}`
  );
});
