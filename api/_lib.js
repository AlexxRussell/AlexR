// Shared helpers for the alexrussell.io voice-agent API.
// Underscore prefix keeps this file from becoming a Vercel route.

export const MINIMAX_BASE = "https://api.minimax.io";

/** Write a JSON response and end. */
export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * Origin allowlist:
 *  - https://alexrussell.io / https://www.alexrussell.io (production)
 *  - http://localhost:* / http://127.0.0.1:* (local dev)
 * POST requests without an Origin header are rejected. Browser fetch POSTs
 * include Origin, including same-origin calls.
 */
function originAllowed(origin) {
  if (!origin) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const { protocol, hostname } = url;
  if (protocol === "https:") {
    if (hostname === "alexrussell.io" || hostname === "www.alexrussell.io") return true;
  }
  if (protocol === "http:") {
    if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  }
  return false;
}

/**
 * Method + origin gate. Handles OPTIONS preflight itself.
 * Returns true if the request may proceed (it is a POST from an
 * allowed origin); returns false after having written the response
 * (204 preflight, 403 forbidden, or 405 wrong method).
 */
export function checkAccess(req, res) {
  const origin = req.headers?.origin;
  const allowed = originAllowed(origin);

  if (origin && allowed) {
    // Echo the concrete origin rather than "*" so the allowlist stays strict.
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    if (!allowed) {
      sendJson(res, 403, { error: "forbidden" });
      return false;
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.statusCode = 204;
    res.end();
    return false;
  }

  if (!allowed) {
    sendJson(res, 403, { error: "forbidden" });
    return false;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    sendJson(res, 405, { error: "method_not_allowed" });
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Rate limiting.
//
// Best-effort in-memory sliding windows: per client IP per endpoint key,
// plus a coarse global budget per endpoint. State lives in this module
// instance, so it is only per warm serverless instance, resets on cold
// starts, and does not coordinate across concurrent instances. A platform
// WAF/rate-limit rule is still recommended as defense in depth.
// ---------------------------------------------------------------------------

const rateBuckets = new Map(); // "key:ip" -> [timestampMs, ...]
let lastPrune = 0;
const PRUNE_INTERVAL_MS = 60_000;
const MAX_WINDOW_MS = 60 * 60_000;
const MAX_BUCKETS = 5000; // hard cap on tracked client buckets per instance

function clientIp(req) {
  // Prefer platform-set headers that clients cannot spoof. Vercel sets
  // x-vercel-forwarded-for / x-real-ip itself; a client-supplied
  // x-forwarded-for is only a fallback for other runtimes (and is the
  // reason it comes last).
  const trusted =
    req.headers?.["x-vercel-forwarded-for"] || req.headers?.["x-real-ip"];
  if (typeof trusted === "string" && trusted.length > 0) {
    return trusted.split(",")[0].trim();
  }
  const fwd = req.headers?.["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

/**
 * Returns true if the request is within `limit` hits per `windowMs`.
 * Over the limit: writes a 429 JSON response and returns false.
 */
export function rateLimit(req, res, key, limit, windowMs) {
  const now = Date.now();

  // Periodically drop buckets that can no longer influence any window.
  if (now - lastPrune > PRUNE_INTERVAL_MS) {
    lastPrune = now;
    for (const [bucketKey, hits] of rateBuckets) {
      if (hits.length === 0 || now - hits[hits.length - 1] > MAX_WINDOW_MS) {
        rateBuckets.delete(bucketKey);
      }
    }
  }

  const bucketKey = `${key}:${clientIp(req)}`;
  let hits = rateBuckets.get(bucketKey);
  if (!hits) {
    // Memory guard: a caller minting unique client IPs must not balloon
    // the bucket map between prunes. Force a prune at the cap; if the
    // map is still saturated with live buckets, fail closed.
    if (rateBuckets.size >= MAX_BUCKETS) {
      lastPrune = now;
      for (const [k, h] of rateBuckets) {
        if (h.length === 0 || now - h[h.length - 1] > MAX_WINDOW_MS) {
          rateBuckets.delete(k);
        }
      }
      if (rateBuckets.size >= MAX_BUCKETS) {
        res.setHeader("Retry-After", "60");
        sendJson(res, 429, { error: "busy" });
        return false;
      }
    }
    hits = [];
    rateBuckets.set(bucketKey, hits);
  }

  // Slide the window: drop hits older than windowMs.
  const cutoff = now - windowMs;
  while (hits.length > 0 && hits[0] <= cutoff) hits.shift();

  if (hits.length >= limit) {
    res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
    sendJson(res, 429, { error: "rate_limited" });
    return false;
  }

  hits.push(now);
  return true;
}

/**
 * Per warm-instance budget across all callers for a key.
 * Over the limit: writes a 429 busy response and returns false.
 */
export function globalBudget(res, key, limit, windowMs) {
  const now = Date.now();
  const bucketKey = `global:${key}`;
  let hits = rateBuckets.get(bucketKey);
  if (!hits) {
    hits = [];
    rateBuckets.set(bucketKey, hits);
  }

  const cutoff = now - windowMs;
  while (hits.length > 0 && hits[0] <= cutoff) hits.shift();

  if (hits.length >= limit) {
    res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
    sendJson(res, 429, { error: "busy" });
    return false;
  }

  hits.push(now);
  return true;
}

// ---------------------------------------------------------------------------
// Body parsing.
// ---------------------------------------------------------------------------

/**
 * Parse the request body as JSON with a hard size cap.
 * Returns the parsed value, or null after having written an error
 * response (413 too large, 400 invalid JSON).
 *
 * Works both with the raw Node request stream and with runtimes that
 * pre-buffer the body onto req.body (Vercel's Node helpers do this).
 */
export async function readJson(req, res, maxBytes) {
  // Pre-parsed by the platform?
  if (req.body !== undefined && req.body !== null) {
    const size = Buffer.byteLength(
      typeof req.body === "string" ? req.body : JSON.stringify(req.body)
    );
    if (size > maxBytes) {
      sendJson(res, 413, { error: "payload_too_large" });
      return null;
    }
    if (typeof req.body === "string") {
      try {
        return JSON.parse(req.body);
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return null;
      }
    }
    return req.body;
  }

  // Fail fast on a declared oversize body.
  const declared = Number(req.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    sendJson(res, 413, { error: "payload_too_large" });
    return null;
  }

  const chunks = [];
  let received = 0;
  try {
    for await (const chunk of req) {
      received += chunk.length;
      if (received > maxBytes) {
        sendJson(res, 413, { error: "payload_too_large" });
        return null;
      }
      chunks.push(chunk);
    }
  } catch {
    sendJson(res, 400, { error: "bad_request" });
    return null;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "invalid_json" });
    return null;
  }
}
