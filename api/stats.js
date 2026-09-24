// Linkhive — script views & likes
// GET  /api/stats                         -> { views: { id: n }, likes: { id: n } }
// POST /api/stats { action, id }          -> action: "view" | "like" | "unlike"
// Storage: Upstash Redis (Vercel Marketplace). Works with either env var naming.
const crypto = require("crypto");

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function pipeline(commands) {
  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Redis error ${res.status}`);
  return (await res.json()).map((r) => r.result);
}

function hashToObject(arr) {
  const out = {};
  for (let i = 0; i < (arr || []).length; i += 2) out[arr[i]] = Math.max(0, parseInt(arr[i + 1], 10) || 0);
  return out;
}

function visitorId(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  // IPs are never stored — only a one-way hash
  return crypto.createHash("sha256").update("linkhive-salt:" + ip).digest("hex").slice(0, 24);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) return res.status(503).json({ error: "Database not connected" });

  try {
    if (req.method === "GET") {
      const [views, likes] = await pipeline([["HGETALL", "lh:views"], ["HGETALL", "lh:likes"]]);
      return res.status(200).json({ views: hashToObject(views), likes: hashToObject(likes) });
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
      const { action, id } = body || {};
      if (!/^[a-z0-9-]{1,80}$/.test(String(id || ""))) return res.status(400).json({ error: "Bad id" });
      const who = visitorId(req);

      if (action === "view") {
        // one view per visitor per script per hour
        const [set] = await pipeline([["SET", `lh:v:${id}:${who}`, "1", "NX", "EX", "3600"]]);
        if (set === "OK") await pipeline([["HINCRBY", "lh:views", id, "1"]]);
        const [n] = await pipeline([["HGET", "lh:views", id]]);
        return res.status(200).json({ id, views: parseInt(n, 10) || 0 });
      }

      if (action === "like" || action === "unlike") {
        // one like per visitor per script
        const [changed] = await pipeline([[action === "like" ? "SADD" : "SREM", `lh:liked:${id}`, who]]);
        if (changed === 1) await pipeline([["HINCRBY", "lh:likes", id, action === "like" ? "1" : "-1"]]);
        const [n] = await pipeline([["HGET", "lh:likes", id]]);
        return res.status(200).json({ id, likes: Math.max(0, parseInt(n, 10) || 0), liked: action === "like" });
      }

      return res.status(400).json({ error: "Bad action" });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: "Server error" });
  }
};
