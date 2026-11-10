'use strict';

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const API_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const API_BASE = 'https://api.football-data.org/v4';
const API_REQUEST_INTERVAL = 6500;
const DEFAULT_COMPETITIONS = 'PL,ELC,CL,EC,FL1,BL1,SA,DED,PPL,CLI,PD,BSA,WC';
const COMPETITIONS = String(process.env.FOOTBALL_COMPETITIONS || DEFAULT_COMPETITIONS).split(',').map(x => x.trim()).filter(Boolean);

const FIXTURE_CACHE_TTL = 5 * 60 * 1000;
const ANALYSIS_CACHE_TTL = 60 * 60 * 1000;
const TEAM_CACHE_TTL = 60 * 60 * 1000;
const MATCH_CACHE_TTL = 60 * 1000;
const LIVE_MATCH_CACHE_TTL = 15 * 1000;

app.use(express.json());
app.use(express.static(__dirname));

const fixtureCache = { value: null, at: 0 };
const analysisCache = new Map();
const teamCache = new Map();
const matchCache = new Map();
const teamPending = new Map();
const analysisPending = new Map();
const matchPending = new Map();

let apiQueue = [];
let queueRunning = false;
let lastApiRequestAt = 0;
let queuedRequests = 0;
let runningRequest = false;

const LIVE_STATUSES = new Set([
  'IN_PLAY',
  'PAUSED',
  'EXTRA_TIME',
  'PENALTY_SHOOTOUT'
]);

const FINISHED_STATUSES = new Set([
  'FINISHED',
  'AWARDED'
]);

const UNAVAILABLE_STATUSES = new Set([
  'POSTPONED',
  'CANCELLED',
  'ABANDONED',
  'SUSPENDED',
  'DELAYED'
]);

function now() {
  return Date.now();
}

function isLiveStatus(status) {
  return LIVE_STATUSES.has(String(status || '').toUpperCase());
}

function cacheGet(map, key, ttl) {
  const item = map.get(String(key));

  if (!item || now() - item.at > ttl) {
    return null;
  }

  return item.value;
}

function cacheSet(map, key, value) {
  map.set(String(key), {
    value,
    at: now()
  });

  return value;
}

function priorityWeight(priority) {
  const p = String(priority || 'background').toLowerCase();

  if (p === 'high' || p === 'urgent') return 0;
  if (p === 'normal') return 1;

  return 2;
}

function normalizePriority(priority) {
  const weight = priorityWeight(priority);

  if (weight === 0) return 'high';
  if (weight === 1) return 'normal';

  return 'background';
}

function promoteFootballRequest(task, priority) {
  if (priorityWeight(priority) < task.weight && !task.started) {
    task.weight = priorityWeight(priority);

    apiQueue.sort((a, b) =>
      a.weight - b.weight ||
      a.createdAt - b.createdAt
    );
  }
}

async function processApiQueue() {
  if (queueRunning) return;

  queueRunning = true;

  try {
    while (apiQueue.length) {
      apiQueue.sort((a, b) =>
        a.weight - b.weight ||
        a.createdAt - b.createdAt
      );

      const task = apiQueue.shift();

      const wait = Math.max(
        0,
        API_REQUEST_INTERVAL - (now() - lastApiRequestAt)
      );

      if (wait) {
        await new Promise(resolve => setTimeout(resolve, wait));
      }

      task.started = true;
      runningRequest = true;

      try {
        task.resolve(await task.run());
      } catch (error) {
        task.reject(error);
      } finally {
        lastApiRequestAt = now();
        runningRequest = false;
        queuedRequests = apiQueue.length;
      }
    }
  } finally {
    queueRunning = false;
    queuedRequests = apiQueue.length;
  }
}

function footballRequest(endpoint, priority = 'background') {
  if (!API_TOKEN) {
    return Promise.reject(
      new Error('FOOTBALL_DATA_TOKEN is not configured.')
    );
  }

  return new Promise((resolve, reject) => {
    const task = {
      endpoint,
      weight: priorityWeight(priority),
      createdAt: now(),
      started: false,
      resolve,
      reject,

      run: async () => {
        const response = await fetch(API_BASE + endpoint, {
          headers: {
            'X-Auth-Token': API_TOKEN,
            Accept: 'application/json'
          }
        });

        const body = await response.json().catch(() => ({}));

        if (!response.ok) {
          const message =
            body.message ||
            `Football data API returned HTTP ${response.status}`;

          const error = new Error(message);
          error.status = response.status;

          throw error;
        }

        return body;
      }
    };

    apiQueue.push(task);
    queuedRequests = apiQueue.length;

    processApiQueue();
  });
}

function poisson(lambda, k) {
  if (k < 0) return 0;

  let factorial = 1;

  for (let i = 2; i <= k; i++) {
    factorial *= i;
  }

  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial;
}

function poissonDistribution(lambda, max = 10) {
  const values = [];

  for (let i = 0; i <= max; i++) {
    values.push(poisson(lambda, i));
  }

  const sum = values.reduce((a, b) => a + b, 0);

  return values.map(v => v / (sum || 1));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function percent(n) {
  return Math.round(clamp(n, 0, 1) * 1000) / 10;
}

function marketProbabilities(lambdaHome, lambdaAway) {
  const home = poissonDistribution(lambdaHome, 10);
  const away = poissonDistribution(lambdaAway, 10);

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let bttsYes = 0;

  const totals = Array(22).fill(0);

  for (let h = 0; h < home.length; h++) {
    for (let a = 0; a < away.length; a++) {
      const p = home[h] * away[a];

      if (h > a) {
        homeWin += p;
      } else if (h === a) {
        draw += p;
      } else {
        awayWin += p;
      }

      if (h > 0 && a > 0) {
        bttsYes += p;
      }

      totals[h + a] += p;
    }
  }

  const over = threshold =>
    totals.slice(threshold + 1).reduce((a, b) => a + b, 0);

  const under = threshold => 1 - over(threshold);

  return {
    homeWin: percent(homeWin),
    draw: percent(draw),
    awayWin: percent(awayWin),

    doubleChance1X: percent(homeWin + draw),
    doubleChanceX2: percent(draw + awayWin),
    doubleChance12: percent(homeWin + awayWin),

    over05: percent(over(0)),
    under05: percent(under(0)),

    over15: percent(over(1)),
    under15: percent(under(1)),

    over25: percent(over(2)),
    under25: percent(under(2)),

    over35: percent(over(3)),
    under35: percent(under(3)),

    bttsYes: percent(bttsYes),
    bttsNo: percent(1 - bttsYes)
  };
}

function makeRecommendations(probabilities) {
  const labels = {
    homeWin: 'HOME WIN (1)',
    draw: 'DRAW (X)',
    awayWin: 'AWAY WIN (2)',

    doubleChance1X: 'DOUBLE CHANCE 1X',
    doubleChanceX2: 'DOUBLE CHANCE X2',
    doubleChance12: 'DOUBLE CHANCE 12',

    over05: 'OVER 0.5 GOALS',
    under05: 'UNDER 0.5 GOALS',

    over15: 'OVER 1.5 GOALS',
    under15: 'UNDER 1.5 GOALS',

    over25: 'OVER 2.5 GOALS',
    under25: 'UNDER 2.5 GOALS',

    over35: 'OVER 3.5 GOALS',
    under35: 'UNDER 3.5 GOALS',

    bttsYes: 'BTTS YES',
    bttsNo: 'BTTS NO'
  };

  return Object.entries(probabilities)
    .map(([key, probability]) => ({
      market: labels[key] || key,
      key,
      probability
    }))
    .sort((a, b) => b.probability - a.probability);
}

function getScoreNumbers(match) {
  const score = match?.score || {};
  const running = score.fullTime || score.fulltime || {};

  const home =
    running.home ??
    running.homeTeam ??
    score.home ??
    score.homeTeam;

  const away =
    running.away ??
    running.awayTeam ??
    score.away ??
    score.awayTeam;

  return {
    home: Number.isInteger(home)
      ? home
      : Number.isFinite(Number(home))
        ? Number(home)
        : null,

    away: Number.isInteger(away)
      ? away
      : Number.isFinite(Number(away))
        ? Number(away)
        : null
  };
}

function getValidMinute(match) {
  const raw = match?.minute;

  if (
    Number.isInteger(raw) &&
    raw >= 0 &&
    raw <= 130
  ) {
    return raw;
  }

  return null;
}

function liveProbabilityModel(preHomeXG, preAwayXG, match) {
  const status = String(match?.status || '').toUpperCase();
  const score = getScoreNumbers(match);
  const minute = getValidMinute(match);

  if (!isLiveStatus(status)) {
    return {
      available: false,
      reason: 'Match is not currently live.'
    };
  }

  if (minute === null) {
    return {
      available: false,
      reason: 'The data provider has not supplied a reliable match minute.'
    };
  }

  if (score.home === null || score.away === null) {
    return {
      available: false,
      reason: 'A reliable live score is not available.'
    };
  }

  const duration =
    match?.score?.duration === 'EXTRA_TIME' ||
    status === 'EXTRA_TIME'
      ? 120
      : 90;

  const remaining = clamp(duration - minute, 0, duration);

  let remainingHome = Math.max(
    0.08,
    preHomeXG * (remaining / 90)
  );

  let remainingAway = Math.max(
    0.08,
    preAwayXG * (remaining / 90)
  );

  if (score.home < score.away) remainingHome *= 1.12;
  if (score.away < score.home) remainingAway *= 1.12;

  if (score.home > score.away) remainingHome *= 0.94;
  if (score.away > score.home) remainingAway *= 0.94;

  remainingHome = clamp(remainingHome, 0.01, 3.5);
  remainingAway = clamp(remainingAway, 0.01, 3.5);

  const homeDist = poissonDistribution(remainingHome, 9);
  const awayDist = poissonDistribution(remainingAway, 9);

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let bttsYes = 0;

  const totals = Array(32).fill(0);

  for (let h = 0; h < homeDist.length; h++) {
    for (let a = 0; a < awayDist.length; a++) {
      const finalHome = score.home + h;
      const finalAway = score.away + a;
      const p = homeDist[h] * awayDist[a];

      if (finalHome > finalAway) {
        homeWin += p;
      } else if (finalHome === finalAway) {
        draw += p;
      } else {
        awayWin += p;
      }

      if (finalHome > 0 && finalAway > 0) {
        bttsYes += p;
      }

      totals[finalHome + finalAway] += p;
    }
  }

  const over = n =>
    totals.slice(n + 1).reduce((a, b) => a + b, 0);

  const under = n => 1 - over(n);

  const probabilities = {
    homeWin: percent(homeWin),
    draw: percent(draw),
    awayWin: percent(awayWin),

    doubleChance1X: percent(homeWin + draw),
    doubleChanceX2: percent(draw + awayWin),
    doubleChance12: percent(homeWin + awayWin),

    over05: percent(over(0)),
    under05: percent(under(0)),

    over15: percent(over(1)),
    under15: percent(under(1)),

    over25: percent(over(2)),
    under25: percent(under(2)),

    over35: percent(over(3)),
    under35: percent(under(3)),

    bttsYes: percent(bttsYes),
    bttsNo: percent(1 - bttsYes)
  };

  return {
    available: true,
    isLiveAdjusted: true,
    minute,
    currentScore: score,

    expectedRemainingGoals: {
      home: Math.round(remainingHome * 100) / 100,
      away: Math.round(remainingAway * 100) / 100
    },

    probabilities,
    recommendations: makeRecommendations(probabilities),
    generatedAt: new Date().toISOString()
  };
}

async function getMatchInformation(
  matchId,
  priority = 'background',
  forceFresh = false
) {
  if (!forceFresh) {
    const cached = cacheGet(
      matchCache,
      matchId,
      MATCH_CACHE_TTL
    );

    if (cached && !isLiveStatus(cached.status)) {
      return cached;
    }

    if (
      cached &&
      isLiveStatus(cached.status) &&
      now() - matchCache.get(String(matchId)).at < LIVE_MATCH_CACHE_TTL
    ) {
      return cached;
    }
  }

  if (matchPending.has(String(matchId))) {
    return matchPending.get(String(matchId));
  }

  const pending = footballRequest(
    `/matches/${encodeURIComponent(matchId)}`,
    priority
  )
    .then(data => {
      const match = data.match || data;

      cacheSet(matchCache, matchId, match);

      return match;
    })
    .finally(() => {
      matchPending.delete(String(matchId));
    });

  matchPending.set(String(matchId), pending);

  return pending;
}

async function getTeamStats(teamId, priority = 'background') {
  const cached = cacheGet(
    teamCache,
    teamId,
    TEAM_CACHE_TTL
  );

  if (cached) return cached;

  if (teamPending.has(String(teamId))) {
    return teamPending.get(String(teamId));
  }

  const pending = footballRequest(
    `/teams/${encodeURIComponent(teamId)}/matches?status=FINISHED&limit=10`,
    priority
  )
    .then(data => {
      const matches = Array.isArray(data.matches)
        ? data.matches
        : [];

      const scored = [];
      const conceded = [];

      matches.forEach(match => {
        const homeGoals = Number(
          match.score?.fullTime?.home ??
          match.score?.fullTime?.homeTeam
        );

        const awayGoals = Number(
          match.score?.fullTime?.away ??
          match.score?.fullTime?.awayTeam
        );

        if (
          !Number.isFinite(homeGoals) ||
          !Number.isFinite(awayGoals)
        ) {
          return;
        }

        if (match.homeTeam?.id === Number(teamId)) {
          scored.push(homeGoals);
          conceded.push(awayGoals);
        } else if (match.awayTeam?.id === Number(teamId)) {
          scored.push(awayGoals);
          conceded.push(homeGoals);
        }
      });

      const count = scored.length;

      const stats = {
        played: count,
        wins: 0,
        draws: 0,
        losses: 0,

        goalsFor: scored.reduce((a, b) => a + b, 0),
        goalsAgainst: conceded.reduce((a, b) => a + b, 0),

        averageGoalsFor: count
          ? scored.reduce((a, b) => a + b, 0) / count
          : 1.25,

        averageGoalsAgainst: count
          ? conceded.reduce((a, b) => a + b, 0) / count
          : 1.25,

        form: []
      };

      matches.forEach(match => {
        const homeGoals = Number(
          match.score?.fullTime?.home ??
          match.score?.fullTime?.homeTeam
        );

        const awayGoals = Number(
          match.score?.fullTime?.away ??
          match.score?.fullTime?.awayTeam
        );

        if (
          !Number.isFinite(homeGoals) ||
          !Number.isFinite(awayGoals)
        ) {
          return;
        }

        const isHome =
          match.homeTeam?.id === Number(teamId);

        const goalsFor = isHome
          ? homeGoals
          : awayGoals;

        const goalsAgainst = isHome
          ? awayGoals
          : homeGoals;

        const result =
          goalsFor > goalsAgainst
            ? 'W'
            : goalsFor === goalsAgainst
              ? 'D'
              : 'L';

        stats[
          result === 'W'
            ? 'wins'
            : result === 'D'
              ? 'draws'
              : 'losses'
        ]++;

        if (stats.form.length < 5) {
          stats.form.push(result);
        }
      });

      return cacheSet(teamCache, teamId, stats);
    })
    .finally(() => {
      teamPending.delete(String(teamId));
    });

  teamPending.set(String(teamId), pending);

  return pending;
}

function expectedGoals(homeStats, awayStats) {
  const homeFor =
    Number(homeStats.averageGoalsFor) || 1.25;

  const homeAgainst =
    Number(homeStats.averageGoalsAgainst) || 1.25;

  const awayFor =
    Number(awayStats.averageGoalsFor) || 1.15;

  const awayAgainst =
    Number(awayStats.averageGoalsAgainst) || 1.25;

  return {
    home: clamp(
      (homeFor * 0.58 + awayAgainst * 0.42) * 1.08,
      0.2,
      4.2
    ),

    away: clamp(
      (awayFor * 0.58 + homeAgainst * 0.42) * 0.92,
      0.2,
      4.2
    )
  };
}

function buildTeamForm(homeStats, awayStats) {
  return {
    home: homeStats,
    away: awayStats
  };
}

async function buildMatchAnalysis(
  match,
  priority = 'background'
) {
  const [homeStats, awayStats] = await Promise.all([
    getTeamStats(match.homeTeam.id, priority),
    getTeamStats(match.awayTeam.id, priority)
  ]);

  const xg = expectedGoals(homeStats, awayStats);

  const preMatchProbabilities = marketProbabilities(
    xg.home,
    xg.away
  );

  const preMatchRecommendations = makeRecommendations(
    preMatchProbabilities
  );

  const isLive = isLiveStatus(match.status);

  const liveAnalysis = isLive
    ? liveProbabilityModel(xg.home, xg.away, match)
    : null;

  const usableLive = !!(
    liveAnalysis &&
    liveAnalysis.available &&
    liveAnalysis.isLiveAdjusted
  );

  return {
    match,

    probabilities: usableLive
      ? liveAnalysis.probabilities
      : preMatchProbabilities,

    recommendations: usableLive
      ? liveAnalysis.recommendations
      : preMatchRecommendations,

    probabilityMode: isLive
      ? usableLive
        ? 'LIVE_ADJUSTED'
        : 'LIVE_UNAVAILABLE'
      : 'PRE_MATCH',

    preMatchProbabilities,
    preMatchRecommendations,

    liveAnalysis: isLive
      ? liveAnalysis
      : {
          available: false,
          reason: 'Match has not started.'
        },

    teamForm: buildTeamForm(
      homeStats,
      awayStats
    ),

    model: {
      name: 'Recent-form Poisson model',

      expectedGoals: xg,

      sample: {
        homePlayed: homeStats.played,
        awayPlayed: awayStats.played
      },

      note:
        'Statistical estimates based on recent completed matches. They are not guaranteed outcomes.'
    },

    limitations: [
      'Lineups, injuries, suspensions, weather and tactical changes may not be reflected.',
      'Live estimates require a reliable provider match minute and current score.'
    ]
  };
}

async function getFixtureDateRange() {
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 1);

  const to = new Date();
  to.setUTCDate(to.getUTCDate() + 7);

  return {
    dateFrom: from.toISOString().slice(0, 10),
    dateTo: to.toISOString().slice(0, 10)
  };
}

async function saveFixtureMatches(
  priority = 'normal',
  force = false
) {
  if (
    !force &&
    fixtureCache.value &&
    now() - fixtureCache.at < FIXTURE_CACHE_TTL
  ) {
    return fixtureCache.value;
  }

  const range = await getFixtureDateRange();

  const competitionFilter = encodeURIComponent(
    COMPETITIONS.join(',')
  );

  const data = await footballRequest(
    `/matches?competitions=${competitionFilter}&dateFrom=${range.dateFrom}&dateTo=${range.dateTo}`,
    priority
  );

  const matches = Array.isArray(data.matches)
    ? data.matches
    : [];

  fixtureCache.value = {
    matches,

    filters: {
      ...range,
      competitions: COMPETITIONS
    },

    updatedAt: new Date().toISOString()
  };

  fixtureCache.at = now();

  return fixtureCache.value;
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'GENERAL FOOTBALL TIPS V1.0',
    apiKeyConfigured: !!API_TOKEN,

    queuedRequests: apiQueue.length,
    runningRequest,

    cachedFixtures: !!fixtureCache.value,
    cachedAnalyses: analysisCache.size,
    cachedTeams: teamCache.size,
    cachedMatches: matchCache.size,

    pendingAnalyses: analysisPending.size
  });
});

app.get('/api/fixtures', async (req, res) => {
  try {
    const result = await saveFixtureMatches(
      normalizePriority(req.query.priority || 'normal'),
      req.query.refresh === '1'
    );

    res.json({
      matches: result.matches,
      fixtures: result.matches,
      updatedAt: result.updatedAt,
      filters: result.filters
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message
    });
  }
});

app.get('/api/match/:id/analysis', async (req, res) => {
  const id = String(req.params.id);

  const priority = normalizePriority(
    req.query.priority || 'background'
  );

  try {
    const match = await getMatchInformation(
      id,
      priority,
      false
    );

    const live = isLiveStatus(match.status);

    const cached = !live
      ? cacheGet(
          analysisCache,
          id,
          ANALYSIS_CACHE_TTL
        )
      : null;

    if (cached) {
      return res.json(cached);
    }

    if (analysisPending.has(id)) {
      return res.json(await analysisPending.get(id));
    }

    const pending = buildMatchAnalysis(
      match,
      priority
    )
      .then(data => {
        if (!live) {
          cacheSet(analysisCache, id, data);
        }

        return data;
      })
      .finally(() => {
        analysisPending.delete(id);
      });

    analysisPending.set(id, pending);

    res.json(await pending);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message
    });
  }
});

app.get('/api/match/:id', async (req, res) => {
  try {
    res.json(
      await getMatchInformation(
        req.params.id,
        'high',
        true
      )
    );
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `GENERAL FOOTBALL TIPS V1.0 listening on ${PORT}`
  );
});
