const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(__dirname));

const API_TOKEN = process.env.FOOTBALL_DATA_TOKEN;

let fixtureCache = {
  data: null,
  expiresAt: 0
};

let pendingRequest = null;

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "GENERAL TIPS PRO V1.0",
    apiKeyConfigured: Boolean(API_TOKEN)
  });
});

app.get("/api/fixtures", async (req, res) => {
  try {
    if (!API_TOKEN) {
      return res.status(503).json({
        error: "Football API token is not configured."
      });
    }

    const now = Date.now();

    if (fixtureCache.data && now < fixtureCache.expiresAt) {
      return res.json(fixtureCache.data);
    }

    if (!pendingRequest) {
      pendingRequest = (async () => {
        const response = await fetch(
          "https://api.football-data.org/v4/matches",
          {
            headers: {
              "X-Auth-Token": API_TOKEN
            }
          }
        );

        if (!response.ok) {
          const error = new Error(
            "Football data provider returned HTTP " + response.status
          );
          error.status = response.status;
          throw error;
        }

        const data = await response.json();

        const result = {
          count: data.count || 0,
          matches: data.matches || [],
          updatedAt: new Date().toISOString()
        };

        fixtureCache = {
          data: result,
          expiresAt: Date.now() + 5 * 60 * 1000
        };

        return result;
      })();
    }

    try {
      const result = await pendingRequest;
      res.json(result);
    } finally {
      pendingRequest = null;
    }

  } catch (error) {
    console.error("Fixture error:", error.message);

    res.status(error.status || 500).json({
      error: "Unable to load football fixtures.",
      details: error.message
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log("GENERAL TIPS PRO running on port " + PORT);
});
