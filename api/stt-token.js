// POST /api/stt-token — short-lived Deepgram token minting for streaming STT.
//
// Client contract:
//   Request:  POST JSON {} (body unused)
//   Response: 200 { token, expires_in } when DEEPGRAM_API_KEY is configured;
//             404 { error: "not_configured" } when it is not — the widget
//             treats that as "use the Web Speech fallback", silently.
//
// Upstream: Deepgram temp-token grant. The token only needs to survive the
// WebSocket handshake, so a 30 s TTL keeps the blast radius of a leaked
// token minimal. The long-lived API key never leaves this function.

import { checkAccess, globalBudget, rateLimit, sendJson } from "./_lib.js";

const DEEPGRAM_GRANT_URL = "https://api.deepgram.com/v1/auth/grant";
const TOKEN_TTL_SECONDS = 30;
const UPSTREAM_TIMEOUT_MS = 10_000;

export default async function handler(req, res) {
  if (!checkAccess(req, res)) return;
  if (!rateLimit(req, res, "stt", 10, 5 * 60_000)) return;
  if (!globalBudget(res, "stt", 200, 60 * 60_000)) return;

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    // Deliberately quiet: no key means Deepgram STT is simply not enabled.
    sendJson(res, 404, { error: "not_configured" });
    return;
  }

  // Abort upstream on client disconnect or timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  res.on("close", () => controller.abort());

  try {
    const upstream = await fetch(DEEPGRAM_GRANT_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl_seconds: TOKEN_TTL_SECONDS }),
    });

    if (!upstream.ok) {
      console.error(`stt-token: upstream HTTP ${upstream.status}`);
      sendJson(res, 502, { error: "upstream_error" });
      return;
    }

    let grant = null;
    try {
      grant = await upstream.json();
    } catch {
      /* malformed upstream body → handled below */
    }
    if (!grant || typeof grant.access_token !== "string" || grant.access_token.length === 0) {
      console.error("stt-token: upstream response missing access_token");
      sendJson(res, 502, { error: "upstream_error" });
      return;
    }

    sendJson(res, 200, { token: grant.access_token, expires_in: grant.expires_in });
  } catch (err) {
    console.error(`stt-token: ${err?.name || "error"}`);
    sendJson(res, 502, { error: "upstream_error" });
  } finally {
    clearTimeout(timer);
  }
}
