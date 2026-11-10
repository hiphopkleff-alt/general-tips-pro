'use strict';

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const API_TOKEN = process.env.API_FOOTBALL_KEY;
const API_BASE = 'https://v3.football.api-sports.io';
const API_REQUEST_INTERVAL = 6500;
const FIXTURE_PAGES = 3;
const FIXTURE_CACHE_TTL = 2 * 60 * 60 * 1000;
const ANALYSIS_CACHE_TTL = 60 * 60 * 1000;
const TEAM_CACHE_TTL = 12 * 60 * 60 * 1000;
const MATCH_CACHE_TTL = 5 * 60 * 1000;
const LIVE_MATCH_CACHE_TTL = 60 * 1000;

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
  return LIVE_STATUSES.has(
    String(status || '').toUpperCase()
  );
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

  return p === 'high' || p === 'urgent'
    ? 0
    : p === 'normal'
      ? 1
      : 2;
}

function normalizePriority(priority) {
  const weight = priorityWeight(priority);

  return weight === 0
    ? 'high'
    : weight === 1
      ? 'normal'
      : 'background';
}

function promoteFootballRequest(task, priority) {
  if (
    priorityWeight(priority) < task.weight &&
    !task.started
  ) {
    task.weight = priorityWeight(priority);

    apiQueue.sort(
      (a, b) =>
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
      apiQueue.sort(
        (a, b) =>
          a.weight - b.weight ||
          a.createdAt - b.createdAt
      );

      const task = apiQueue.shift();

      const wait = Math.max(
        0,
        API_REQUEST_INTERVAL -
        (now() - lastApiRequestAt)
      );

      if (wait) {
        await new Promise(resolve =>
          setTimeout(resolve, wait)
        );
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

function footballRequest(
  endpoint,
  priority = 'background'
) {
  if (!API_TOKEN) {
    return Promise.reject(
      new Error(
        'API_FOOTBALL_KEY is not configured in Render.'
      )
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
        const response = await fetch(
          API_BASE + endpoint,
          {
            method: 'GET',
            headers: {
              'x-apisports-key': API_TOKEN,
              Accept: 'application/json'
            }
          }
        );

        const body = await response
          .json()
          .catch(() => ({}));

        if (
          !response.ok ||
          (
            body.errors &&
            Object.keys(body.errors).length
          )
        ) {
          const detail =
            body.message ||
            (
              typeof body.errors === 'object'
                ? JSON.stringify(body.errors)
                : body.errors
            );

          const error = new Error(
            detail ||
            `API-Football returned HTTP ${response.status}`
          );

          error.status = response.status || 502;

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

  return (
    Math.exp(-lambda) *
    Math.pow(lambda, k) /
    factorial
  );
}

function poissonDistribution(lambda, max = 10) {
  const values = [];

  for (let i = 0; i <= max; i++) {
    values.push(poisson(lambda, i));
  }

  const sum = values.reduce(
    (a, b) => a + b,
    0
  );

  return values.map(v => v / (sum || 1));
}
function mapFixtureStatus(short) {
  const s = String(short || '').toUpperCase();

  if (['1H', '2H', 'LIVE'].includes(s)) return 'IN_PLAY';
  if (['HT', 'BT'].includes(s)) return 'PAUSED';
  if (['ET', 'AET'].includes(s)) return 'EXTRA_TIME';
  if (s === 'P') return 'PENALTY_SHOOTOUT';

  if (['FT', 'PEN', 'AWD', 'WO'].includes(s)) {
    return 'FINISHED';
  }

  if (s === 'PST') return 'POSTPONED';
  if (s === 'CANC') return 'CANCELLED';
  if (s === 'ABD') return 'ABANDONED';
  if (['SUSP', 'INT'].includes(s)) return 'SUSPENDED';
  if (s === 'TBD') return 'TIMED';

  return 'SCHEDULED';
}

function mapFixture(item) {
  const fixture = item.fixture || {};
  const teams = item.teams || {};
  const goals = item.goals || {};
  const score = item.score || {};
  const league = item.league || {};
  const home = teams.home || {};
  const away = teams.away || {};

  const status = mapFixtureStatus(
    fixture.status && fixture.status.short
  );

  const elapsed =
    fixture.status &&
    fixture.status.elapsed != null
      ? fixture.status.elapsed
      : null;

  const homeGoals =
    goals.home != null ? goals.home : null;

  const awayGoals =
    goals.away != null ? goals.away : null;

  const match = {
    id: fixture.id,

    utcDate: fixture.date,

    status,

    minute: elapsed,

    homeTeam: {
      id: home.id,
      name: home.name || 'Home Team',
      shortName: home.name || 'Home Team',
      crest: home.logo || null
    },

    awayTeam: {
      id: away.id,
      name: away.name || 'Away Team',
      shortName: away.name || 'Away Team',
      crest: away.logo || null
    },

    competition: {
      id: league.id,
      name: league.name || 'Football',
      code: league.country || ''
    },

    score: {
      fullTime: {
        home: homeGoals,
        away: awayGoals
      },
      halfTime: {
        home:
          score.halftime &&
          score.halftime.home != null
            ? score.halftime.home
            : null,
        away:
          score.halftime &&
          score.halftime.away != null
            ? score.halftime.away
            : null
      }
    },

    venue: fixture.venue
      ? fixture.venue.name
      : null,

    apiFootball: {
      fixtureId: fixture.id,
      homeTeamId: home.id,
      awayTeamId: away.id,
      leagueId: league.id,
      statusShort:
        fixture.status &&
        fixture.status.short
          ? fixture.status.short
          : ''
    }
  };

  return match;
}

function dateString(date) {
  return date.toISOString().slice(0, 10);
}

function getLagosToday() {
  const parts = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'Africa/Lagos',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }
  ).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateText, days) {
  const date = new Date(
    `${dateText}T12:00:00Z`
  );

  date.setUTCDate(
    date.getUTCDate() + days
  );

  return dateString(date);
}

function sortFixtures(fixtures) {
  return fixtures.sort((a, b) => {
    const aDate = new Date(a.utcDate || 0).getTime();
    const bDate = new Date(b.utcDate || 0).getTime();

    return aDate - bDate;
  });
}

async function fetchFixturePage(
  from,
  to,
  page,
  priority
) {
  const params = new URLSearchParams({
    from,
    to,
    timezone: 'Africa/Lagos',
    page: String(page)
  });

  return footballRequest(
    `/fixtures?${params.toString()}`,
    priority
  );
}

async function fetchAllFixtures(priority = 'normal') {
  const today = getLagosToday();
  const endDate = addDays(today, 10);

  const all = [];
  const seen = new Set();

  for (
    let page = 1;
    page <= FIXTURE_PAGES;
    page++
  ) {
    const result = await fetchFixturePage(
      today,
      endDate,
      page,
      priority
    );

    const rows = Array.isArray(result.response)
      ? result.response
      : [];

    for (const row of rows) {
      const mapped = mapFixture(row);

      if (
        mapped.id &&
        !seen.has(String(mapped.id))
      ) {
        seen.add(String(mapped.id));
        all.push(mapped);
      }
    }

    const totalPages =
      result.paging &&
      Number(result.paging.total)
        ? Number(result.paging.total)
        : 1;

    if (page >= totalPages) break;
  }

  sortFixtures(all);

  return all;
}

async function getFixtures(priority = 'normal', force = false) {
  if (
    !force &&
    fixtureCache.value &&
    now() - fixtureCache.at < FIXTURE_CACHE_TTL
  ) {
    return fixtureCache.value;
  }

  const fixtures = await fetchAllFixtures(priority);

  fixtureCache.value = fixtures;
  fixtureCache.at = now();

  for (const fixture of fixtures) {
    matchCache.set(String(fixture.id), {
      value: fixture,
      at: now()
    });
  }

  return fixtures;
}

function getFixtureFromCache(id) {
  const item = matchCache.get(String(id));

  if (!item) return null;

  if (
    now() - item.at >
    (
      isLiveStatus(item.value.status)
        ? LIVE_MATCH_CACHE_TTL
        : MATCH_CACHE_TTL
    )
  ) {
    return null;
  }

  return item.value;
}

async function getMatchInformation(
  id,
  priority = 'normal'
) {
  const cached = getFixtureFromCache(id);

  if (cached) return cached;

  const existing = matchPending.get(String(id));

  if (existing) return existing;

  const promise = (async () => {
    const result = await footballRequest(
      `/fixtures?id=${encodeURIComponent(id)}`,
      priority
    );

    const row =
      Array.isArray(result.response) &&
      result.response.length
        ? result.response[0]
        : null;

    if (!row) {
      throw new Error('Match was not found.');
    }

    const match = mapFixture(row);

    matchCache.set(String(id), {
      value: match,
      at: now()
    });

    return match;
  })();

  matchPending.set(String(id), promise);

  try {
    return await promise;
  } finally {
    matchPending.delete(String(id));
  }
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function average(values) {
  if (!values.length) return 0;

  return values.reduce(
    (sum, value) => sum + value,
    0
  ) / values.length;
}

function percentage(value) {
  return Math.round(
    clamp(value, 0, 1) * 1000
  ) / 10;
}

function getTeamCacheKey(teamId) {
  return `team-${teamId}`;
}

async function getTeamRecentForm(
  teamId,
  priority = 'background'
) {
  const key = getTeamCacheKey(teamId);

  const cached = cacheGet(
    teamCache,
    key,
    TEAM_CACHE_TTL
  );

  if (cached) return cached;

  if (teamPending.has(key)) {
    promoteFootballRequest(
      teamPending.get(key).task,
      priority
    );

    return teamPending.get(key).promise;
  }

  const promise = (async () => {
    const params = new URLSearchParams({
      team: String(teamId),
      last: '10',
      status: 'FT'
    });

    const result = await footballRequest(
      `/fixtures?${params.toString()}`,
      priority
    );

    const rows = Array.isArray(result.response)
      ? result.response
      : [];

    const matches = rows.map(mapFixture);

    const form = [];
    const goalsFor = [];
    const goalsAgainst = [];

    for (const match of matches) {
      const home =
        String(match.apiFootball.homeTeamId) ===
        String(teamId);

      const scored = home
        ? match.score.fullTime.home
        : match.score.fullTime.away;

      const conceded = home
        ? match.score.fullTime.away
        : match.score.fullTime.home;

      if (
        scored == null ||
        conceded == null
      ) continue;

      goalsFor.push(Number(scored));
      goalsAgainst.push(Number(conceded));

      if (scored > conceded) form.push('W');
      else if (scored === conceded) form.push('D');
      else form.push('L');
    }

    const data = {
      teamId,
      played: form.length,
      form: form.slice(0, 5),
      wins: form.filter(x => x === 'W').length,
      draws: form.filter(x => x === 'D').length,
      losses: form.filter(x => x === 'L').length,
      goalsFor: goalsFor.reduce((a, b) => a + b, 0),
      goalsAgainst: goalsAgainst.reduce((a, b) => a + b, 0),
      averageGoalsFor: average(goalsFor),
      averageGoalsAgainst: average(goalsAgainst),
      matches
    };

    return cacheSet(teamCache, key, data);
  })();

  const task = apiQueue.find(
    item => !item.started
  );

  teamPending.set(key, {
    promise,
    task
  });

  try {
    return await promise;
  } finally {
    teamPending.delete(key);
  }
}
// TEAM FORM AND MATCH ANALYSIS

async function getTeamRecentForm(
  teamId,
  priority = 'background'
) {
  const key = getTeamCacheKey(teamId);

  const cached = cacheGet(
    teamCache,
    key,
    TEAM_CACHE_TTL
  );

  if (cached) return cached;

  if (teamPending.has(key)) {
    return teamPending.get(key);
  }

  const promise = (async () => {
    const params = new URLSearchParams({
      team: String(teamId),
      last: '10',
      status: 'FT'
    });

    const result = await footballRequest(
      `/fixtures?${params.toString()}`,
      priority
    );

    const rows = Array.isArray(result.response)
      ? result.response
      : [];

    const form = [];
    const goalsFor = [];
    const goalsAgainst = [];

    for (const item of rows) {
      const match = mapFixture(item);

      const isHome =
        String(match.apiFootball.homeTeamId) ===
        String(teamId);

      const scored = isHome
        ? match.score.fullTime.home
        : match.score.fullTime.away;

      const conceded = isHome
        ? match.score.fullTime.away
        : match.score.fullTime.home;

      if (scored == null || conceded == null) {
        continue;
      }

      goalsFor.push(Number(scored));
      goalsAgainst.push(Number(conceded));

      if (scored > conceded) form.push('W');
      else if (scored === conceded) form.push('D');
      else form.push('L');
    }

    const played = form.length;

    const data = {
      teamId,
      played,
      wins: form.filter(x => x === 'W').length,
      draws: form.filter(x => x === 'D').length,
      losses: form.filter(x => x === 'L').length,
      goalsFor: goalsFor.reduce((a, b) => a + b, 0),
      goalsAgainst: goalsAgainst.reduce((a, b) => a + b, 0),
      averageGoalsFor: played
        ? average(goalsFor)
        : 1.25,
      averageGoalsAgainst: played
        ? average(goalsAgainst)
        : 1.25,
      form: form.slice(0, 5)
    };

    return cacheSet(teamCache, key, data);
  })();

  teamPending.set(key, promise);

  try {
    return await promise;
  } finally {
    teamPending.delete(key);
  }
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
  const homeId = match.homeTeam.id;
  const awayId = match.awayTeam.id;

  const [homeStats, awayStats] =
    await Promise.all([
      getTeamRecentForm(homeId, priority),
      getTeamRecentForm(awayId, priority)
    ]);

  const xg = expectedGoals(
    homeStats,
    awayStats
  );

  const probabilities = marketProbabilities(
    xg.home,
    xg.away
  );

  const recommendations =
    makeRecommendations(probabilities);

  const isLive = isLiveStatus(match.status);

  const liveAnalysis = isLive
    ? liveProbabilityModel(
        xg.home,
        xg.away,
        match
      )
    : null;

  const usableLive = Boolean(
    liveAnalysis &&
    liveAnalysis.available &&
    liveAnalysis.isLiveAdjusted
  );

  return {
    match,

    probabilities: usableLive
      ? liveAnalysis.probabilities
      : probabilities,

    recommendations: usableLive
      ? liveAnalysis.recommendations
      : recommendations,

    probabilityMode: isLive
      ? (
          usableLive
            ? 'LIVE_ADJUSTED'
            : 'LIVE_UNAVAILABLE'
        )
      : 'PRE_MATCH',

    preMatchProbabilities: probabilities,
    preMatchRecommendations: recommendations,

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

      expectedGoals: {
        home: Math.round(xg.home * 100) / 100,
        away: Math.round(xg.away * 100) / 100
      },

      sample: {
        homePlayed: homeStats.played,
        awayPlayed: awayStats.played
      },

      note:
        'Statistical estimates based on recent completed matches. Predictions are not guaranteed.'
    },

    limitations: [
      'Lineups, injuries, suspensions, weather and tactical changes may not be reflected.',
      'Live estimates require a reliable provider match minute and current score.'
    ],

    generatedAt: new Date().toISOString()
  };
                         }
// PROBABILITY ENGINE

function marketProbabilities(homeXG, awayXG) {
  const home = poissonDistribution(homeXG, 10);
  const away = poissonDistribution(awayXG, 10);

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over05 = 0;
  let over15 = 0;
  let over25 = 0;
  let over35 = 0;
  let under05 = 0;
  let under15 = 0;
  let under25 = 0;
  let under35 = 0;
  let bttsYes = 0;

  for (let h = 0; h < home.length; h++) {
    for (let a = 0; a < away.length; a++) {
      const probability = home[h] * away[a];
      const total = h + a;

      if (h > a) homeWin += probability;
      else if (h === a) draw += probability;
      else awayWin += probability;

      if (total >= 1) over05 += probability;
      if (total >= 2) over15 += probability;
      if (total >= 3) over25 += probability;
      if (total >= 4) over35 += probability;

      if (total < 1) under05 += probability;
      if (total < 2) under15 += probability;
      if (total < 3) under25 += probability;
      if (total < 4) under35 += probability;

      if (h > 0 && a > 0) bttsYes += probability;
    }
  }

  const result = {
    homeWin: percentage(homeWin),
    draw: percentage(draw),
    awayWin: percentage(awayWin),

    doubleChance1X: percentage(homeWin + draw),
    doubleChanceX2: percentage(draw + awayWin),
    doubleChance12: percentage(homeWin + awayWin),

    over05: percentage(over05),
    over15: percentage(over15),
    over25: percentage(over25),
    over35: percentage(over35),

    under05: percentage(under05),
    under15: percentage(under15),
    under25: percentage(under25),
    under35: percentage(under35),

    bttsYes: percentage(bttsYes),
    bttsNo: percentage(1 - bttsYes)
  };

  return result;
}

function makeRecommendations(probabilities) {
  const markets = [
    ['HOME WIN', 'homeWin'],
    ['DRAW', 'draw'],
    ['AWAY WIN', 'awayWin'],

    ['DOUBLE CHANCE 1X', 'doubleChance1X'],
    ['DOUBLE CHANCE X2', 'doubleChanceX2'],
    ['DOUBLE CHANCE 12', 'doubleChance12'],

    ['OVER 0.5 GOALS', 'over05'],
    ['OVER 1.5 GOALS', 'over15'],
    ['OVER 2.5 GOALS', 'over25'],
    ['OVER 3.5 GOALS', 'over35'],

    ['UNDER 0.5 GOALS', 'under05'],
    ['UNDER 1.5 GOALS', 'under15'],
    ['UNDER 2.5 GOALS', 'under25'],
    ['UNDER 3.5 GOALS', 'under35'],

    ['BTTS YES', 'bttsYes'],
    ['BTTS NO', 'bttsNo']
  ];

  return markets
    .map(([market, key]) => ({
      market,
      probability: probabilities[key],
      confidence: probabilities[key],
      confidenceLabel:
        probabilities[key] >= 75
          ? 'HIGH'
          : probabilities[key] >= 60
            ? 'MEDIUM'
            : 'LOW',

      enabled: probabilities[key] >= 55
    }))
    .sort(
      (a, b) =>
        b.probability - a.probability
    );
}

// LIVE MODEL
// Never invent a live score or match minute.

function liveProbabilityModel(
  homeXG,
  awayXG,
  match
) {
  const status = String(
    match.apiFootball &&
    match.apiFootball.statusShort || ''
  ).toUpperCase();

  const minute = Number(match.minute);

  const homeScore =
    match.score &&
    match.score.fullTime &&
    match.score.fullTime.home;

  const awayScore =
    match.score &&
    match.score.fullTime &&
    match.score.fullTime.away;

  const validMinute =
    Number.isFinite(minute) &&
    minute > 0 &&
    minute <= 130;

  const validScore =
    homeScore !== null &&
    homeScore !== undefined &&
    awayScore !== null &&
    awayScore !== undefined;

  if (
    !validMinute ||
    !validScore ||
    !['1H', '2H', 'HT', 'ET', 'LIVE'].includes(status)
  ) {
    return {
      available: false,
      isLiveAdjusted: false,
      reason:
        'Reliable live match minute or score is unavailable.',
      recommendations: []
    };
  }

  const elapsed = clamp(minute / 90, 0, 1);

  const remaining = Math.max(
    0.02,
    1 - elapsed
  );

  const homeRemaining = homeXG * remaining;
  const awayRemaining = awayXG * remaining;

  const homeDistribution =
    poissonDistribution(homeRemaining, 8);

  const awayDistribution =
    poissonDistribution(awayRemaining, 8);

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over05 = 0;
  let over15 = 0;
  let over25 = 0;
  let over35 = 0;
  let under05 = 0;
  let under15 = 0;
  let under25 = 0;
  let under35 = 0;
  let bttsYes = 0;

  for (
    let h = 0;
    h < homeDistribution.length;
    h++
  ) {
    for (
      let a = 0;
      a < awayDistribution.length;
      a++
    ) {
      const probability =
        homeDistribution[h] *
        awayDistribution[a];

      const finalHome =
        Number(homeScore) + h;

      const finalAway =
        Number(awayScore) + a;

      const total = finalHome + finalAway;

      if (finalHome > finalAway) {
        homeWin += probability;
      } else if (finalHome === finalAway) {
        draw += probability;
      } else {
        awayWin += probability;
      }

      if (total >= 1) over05 += probability;
      if (total >= 2) over15 += probability;
      if (total >= 3) over25 += probability;
      if (total >= 4) over35 += probability;

      if (total < 1) under05 += probability;
      if (total < 2) under15 += probability;
      if (total < 3) under25 += probability;
      if (total < 4) under35 += probability;

      if (finalHome > 0 && finalAway > 0) {
        bttsYes += probability;
      }
    }
  }

  const probabilities = {
    homeWin: percentage(homeWin),
    draw: percentage(draw),
    awayWin: percentage(awayWin),

    doubleChance1X:
      percentage(homeWin + draw),

    doubleChanceX2:
      percentage(draw + awayWin),

    doubleChance12:
      percentage(homeWin + awayWin),

    over05: percentage(over05),
    over15: percentage(over15),
    over25: percentage(over25),
    over35: percentage(over35),

    under05: percentage(under05),
    under15: percentage(under15),
    under25: percentage(under25),
    under35: percentage(under35),

    bttsYes: percentage(bttsYes),
    bttsNo: percentage(1 - bttsYes)
  };

  return {
    available: true,
    isLiveAdjusted: true,
    minute,
    score: {
      home: Number(homeScore),
      away: Number(awayScore)
    },
    probabilities,
    recommendations:
      makeRecommendations(probabilities)
  };
}

// API ROUTES

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'GENERAL FOOTBALL TIPS V1.0',
    provider: 'API-Football',
    apiKeyConfigured: Boolean(API_TOKEN),
    queuedRequests: apiQueue.length,
    runningRequest,
    cachedFixtures: Boolean(fixtureCache.value),
    fixtureCount: fixtureCache.value
      ? fixtureCache.value.length
      : 0,
    cachedAnalyses: analysisCache.size,
    cachedTeams: teamCache.size,
    cachedMatches: matchCache.size,
    pendingAnalyses: analysisPending.size
  });
});

app.get('/api/fixtures', async (req, res) => {
  try {
    const priority = normalizePriority(
      req.query.priority
    );

    const force =
      req.query.refresh === 'true';

    const fixtures = await getFixtures(
      priority,
      force
    );

    res.json({
      matches: fixtures,
      fixtures,
      count: fixtures.length,
      provider: 'API-Football',
      dateFrom: getLagosToday(),
      dateTo: addDays(getLagosToday(), 10)
    });
  } catch (error) {
    console.error(
      'Fixtures error:',
      error.message
    );

    res.status(error.status || 502).json({
      error: 'Unable to load fixtures.',
      message: error.message
    });
  }
});

app.get(
  '/api/match/:id/analysis',
  async (req, res) => {
    const id = req.params.id;

    const priority = normalizePriority(
      req.query.priority
    );

    const cacheKey = String(id);

    const cached = cacheGet(
      analysisCache,
      cacheKey,
      ANALYSIS_CACHE_TTL
    );

    if (cached) {
      return res.json(cached);
    }

    if (analysisPending.has(cacheKey)) {
      return res.json(
        await analysisPending.get(cacheKey)
      );
    }

    const promise = (async () => {
      const match = await getMatchInformation(
        id,
        priority
      );

      if (FINISHED_STATUSES.has(match.status)) {
        const error = new Error(
          'This match has finished. View it in History.'
        );

        error.status = 410;
        throw error;
      }

      if (UNAVAILABLE_STATUSES.has(match.status)) {
        const error = new Error(
          'This fixture is not currently available for analysis.'
        );

        error.status = 409;
        throw error;
      }

      const analysis = await buildMatchAnalysis(
        match,
        priority
      );

      return cacheSet(
        analysisCache,
        cacheKey,
        analysis
      );
    })();

    analysisPending.set(cacheKey, promise);

    try {
      const result = await promise;
      res.json(result);
    } catch (error) {
      console.error(
        'Analysis error:',
        id,
        error.message
      );

      res.status(error.status || 502).json({
        error: 'Unable to analyse this match.',
        message: error.message
      });
    } finally {
      analysisPending.delete(cacheKey);
    }
  }
);

// HISTORY / COMPLETED FIXTURES

app.get('/api/history', async (req, res) => {
  try {
    const fixtures = await getFixtures('normal');

    const history = fixtures.filter(
      match =>
        FINISHED_STATUSES.has(match.status)
    );

    res.json({
      matches: history,
      count: history.length
    });
  } catch (error) {
    res.status(error.status || 502).json({
      error: 'Unable to load history.',
      message: error.message
    });
  }
});

// FRONTEND

app.get('/', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'index.html')
  );
});

app.use((error, req, res, next) => {
  console.error(error);

  if (res.headersSent) return next(error);

  res.status(500).json({
    error: 'Internal server error.'
  });
});

app.listen(PORT, () => {
  console.log(
    `GENERAL FOOTBALL TIPS V1.0 running on port ${PORT}`
  );

  console.log(
    `API-Football key configured: ${Boolean(API_TOKEN)}`
  );
});
