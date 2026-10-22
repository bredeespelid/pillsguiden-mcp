// HTTP-inngang (Streamable HTTP, stateless) – for hosting på Render, Fly.io, Railway, Cloud Run osv.
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, runAudit } from "./server.js";
import { getList } from "./pilsguiden.js";
import { withAllPrices } from "./prices.js";

const PORT = Number(process.env.PORT || 3000);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || ""; // valgfritt: krev "Authorization: Bearer <token>"

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (_req, res) =>
  res.json({ name: "pilsguiden-mcp", status: "ok", mcp_endpoint: "/mcp", source: "https://www.pilsguiden.no" })
);
app.get("/health", (_req, res) => res.send("ok"));
// Kontrollen tar 10–60 s: start i bakgrunnen og returner status til den er ferdig.
const audits = new Map(); // place -> { status, started, data, error }
app.get("/audit", (req, res) => {
  const place = typeof req.query.place === "string" && req.query.place ? req.query.place : "oslo";
  let a = audits.get(place);
  const stale = a && a.status !== "running" && Date.now() - a.started > 30 * 60 * 1000;
  if (!a || stale) {
    a = { status: "running", started: Date.now() };
    audits.set(place, a);
    runAudit(place)
      .then((data) => Object.assign(a, { status: "done", data }))
      .catch((e) => Object.assign(a, { status: "error", error: String(e.message || e) }));
  }
  if (a.status === "done") return res.json(a.data);
  if (a.status === "error") return res.status(500).json({ error: a.error });
  res.status(202).json({ status: "running", seconds: Math.round((Date.now() - a.started) / 1000), hint: "Prøv igjen om litt." });
});

function checkAuth(req, res) {
  if (!AUTH_TOKEN) return true;
  if (req.headers.authorization === `Bearer ${AUTH_TOKEN}`) return true;
  res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  return false;
}

app.post("/mcp", async (req, res) => {
  if (!checkAuth(req, res)) return;
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const notAllowed = (_req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

app.listen(PORT, () => {
  console.log(`pilsguiden-mcp lytter på :${PORT}/mcp`);
  // Varm opp alle detaljpriser ved oppstart og hver 6. time, så første spørsmål går raskt.
  const warm = () =>
    getList(process.env.DEFAULT_PLACE || "oslo")
      .then((d) => withAllPrices(d.bars, { waitMs: 120000 }))
      .then((b) => console.log(`detaljpriser klare: ${b.length - b.incomplete}/${b.length}`))
      .catch((e) => console.error("oppvarming feilet:", e.message));
  if (process.env.WARM_ON_START !== "0") {
    warm();
    setInterval(warm, 6 * 3600 * 1000).unref();
  }
});
