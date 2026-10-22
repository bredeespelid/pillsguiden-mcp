// Quiz-tester. Kjør: node test/quiz.mjs
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { parseSchedule, occursOn, resolveDate } from "../src/quiz.js";
import { matchBar } from "../src/quiz-tools.js";

// ---- tidsplan (oktober/november 2026; 22.10 er torsdag, uke 43) ----
const D = (iso) => resolveDate(iso, new Date("2026-10-22T10:00:00+02:00"));
const tue20 = D("2026-10-20"), tue27 = D("2026-10-27"), tue3 = D("2026-11-03"), wed21 = D("2026-10-21");
const occ = (txt, d) => occursOn(parseSchedule(txt), d);
assert.equal(tue20.dow, 1);
assert.equal(occ("Tirsdag", tue20), true);
assert.equal(occ("Tirsdag", wed21), false);
assert.equal(occ("TIrsdag", tue20), true);
assert.equal(occ("Tirsdag (annenhver, oddetallsuker)", tue20), true); // uke 43
assert.equal(occ("Tirsdag (annenhver, oddetallsuker)", tue27), false); // uke 44
assert.equal(occ("Mandag (annenhver)", D("2026-10-26")), null);
assert.equal(occ("Tirsdag (siste tirsdag hver måned)", tue27), true);
assert.equal(occ("Tirsdag (siste tirsdag hver måned)", tue20), false);
assert.equal(occ("1. tirsdag hver måned", tue3), true);
assert.equal(occ("1. tirsdag hver måned", tue27), false);
assert.equal(occ("Tirsdag (første i måneden)", tue3), true);
assert.equal(occ("Tirsdag (2. tirsdag hver måned)", D("2026-11-10")), true);
assert.equal(occ("Mandag (én gang per måned)", D("2026-10-26")), null);
assert.equal(occ("Onsdager (annenhver – høstsesong 2024 fra 28/8 til 4/12)", wed21), null);
assert.equal(occ("En torsdag i måneden (varierer)", D("2026-10-22")), null);
assert.equal(occ("Tirsdag (utvalgte)", tue20), null);
assert.deepEqual(parseSchedule("Mandag (Søndag)").days, [0, 6]);
assert.equal(occ("Oslo", tue20), null);
assert.equal(D("i dag").iso, "2026-10-22");
assert.equal(D("i morgen").iso, "2026-10-23");
assert.equal(D("tirsdag").iso, "2026-10-27");
assert.equal(D("torsdag").iso, "2026-10-22");
assert.equal(D("neste torsdag").iso, "2026-10-29");
assert.equal(D("27.10").iso, "2026-10-27");
console.log("tidsplan: ok");

// ---- navnematch mot Pilsguiden ----
const bars = ["Løkka Bar og Kjøkken", "The Fly Fisher", "Jagger Løkka", "Rabalder Bar Oslo", "O'Connor's Irish Pub - Oslo", "Lincoln Sports Bar", "Fru Burums", "Fryd Gastropub Løren", "Fryd Manglerud", "The Good Knight", "Los Tacos Torshov", "Los Tacos Majorstuen"].map((name) => ({ name }));
const mb = (n) => matchBar(n, bars)?.name ?? null;
assert.equal(mb("Rabalder Bar Løkka"), "Rabalder Bar Oslo");
assert.equal(mb("O'Connors"), "O'Connor's Irish Pub - Oslo");
assert.equal(mb("Fru Burums"), "Fru Burums");
assert.equal(mb("Fryd Løren"), "Fryd Gastropub Løren");
assert.equal(mb("The Good Knight"), "The Good Knight");
assert.equal(mb("Lincoln Pub, Torshov"), "Lincoln Sports Bar"); // samme sted (Vogts gate, Torshov)
assert.equal(mb("Smelteverket"), null);
assert.equal(mb("Løkka Bar & Kjøkken"), "Løkka Bar og Kjøkken");
assert.equal(mb("Flyfisher"), "The Fly Fisher");
assert.equal(mb("Los Tacos"), null); // tvetydig
console.log("navnematch: ok");

// ---- ende-til-ende ----
const procs = [
  spawn("node", ["test/mock-pilsguiden.mjs"], { env: { ...process.env, MOCK_PORT: "4013" }, stdio: "inherit" }),
  spawn("node", ["src/http.js"], {
    env: { ...process.env, PORT: "3991", PILSGUIDEN_BASE_URL: "http://localhost:4013", QUIZ_BASE_URL: "http://localhost:4013", WARM_ON_START: "0" },
    stdio: "ignore",
  }),
];
await new Promise((r) => setTimeout(r, 1500));
let id = 0;
async function call(path, name, args) {
  const res = await fetch(`http://localhost:3991${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: name ? "tools/call" : "tools/list", params: name ? { name, arguments: args } : {} }),
  });
  const j = await res.json();
  if (!name) return j.result.tools.map((t) => t.name);
  if (j.result.isError) throw new Error(j.result.content[0].text);
  return JSON.parse(j.result.content[0].text);
}
let n = 0;
const check = (c, m) => (assert.ok(c, m), n++, console.log("  ✓", m));
const names = (r) => r.quizzes.map((q) => q.name);
try {
  check((await call("/mcp", null)).includes("find_quizzes"), "/mcp har quiz-verktøy");
  const qt = await call("/quiz/mcp", null);
  check(qt.includes("find_quizzes") && !qt.includes("cheap_beer_now"), "/quiz/mcp har bare quiz");

  const tue = await call("/mcp", "find_quizzes", { when: "2026-10-27" });
  check(tue.date === "tirsdag 2026-10-27", "dato tolket");
  check(names(tue).includes("Vika Kino") && !names(tue).includes("Glasset") && !names(tue).includes("Cultivate Food, Grünerløkka"), "27.10: siste tirsdag ja, oddetall nei, 1. tirsdag nei");
  check(!names(tue).includes("Puben på hjørnet"), "  standard Oslo (ikke Akershus)");
  check(names(tue)[0] === "Rabalder Bar Løkka", "  sortert på tid (18:00 først)");
  const salt = tue.quizzes.find((q) => q.name === "SALT");
  check(salt && salt.happens === null, "  usikre quizer med happens=null");
  const royal = tue.quizzes.find((q) => q.name === "Bar Royal");
  check(royal.beer?.price === 69 && royal.beer.pilsguiden_name === "Bar Royal", "  Bar Royal kl 19 → 69 kr (etter happy hour)");

  const thu = await call("/mcp", "find_quizzes", { when: "torsdag" });
  const dest = thu.quizzes.find((q) => q.name === "Destiny Pub");
  check(dest.beer?.price === 59 && dest.beer.happy_hour, "torsdag: Destiny kl 18 → 59 kr happy hour");
  const sip = thu.quizzes.find((q) => q.name === "SIP");
  check(sip.beer?.price === 49, "  SIP kl 20:30 → 49 kr");
  const cheap = await call("/mcp", "find_quizzes", { when: "torsdag", sort_by: "beer_price" });
  check(cheap.quizzes[0].name === "Destiny Pub", "  sort_by beer_price");

  const only = await call("/mcp", "find_quizzes", { when: "2026-10-27", include_uncertain: false });
  check(!names(only).includes("SALT"), "include_uncertain=false");
  const music = await call("/mcp", "find_quizzes", { when: "alle", type: "musikk" });
  check(names(music).sort().join() === "Destiny Pub,Saskia", "when=alle + type=musikk");
  const lokka = await call("/mcp", "find_quizzes", { when: "alle", query: "løkka" });
  check(names(lokka).sort().join() === "Cultivate Food, Grünerløkka,Rabalder Bar Løkka", "query=løkka");
  const bergen = await call("/mcp", "find_quizzes", { when: "torsdag", region: "Vestland" });
  check(names(bergen).join() === "Bergen Quizbar", "region=Vestland");
  const marien = (await call("/mcp", "find_quizzes", { when: "alle", query: "marienlyst" })).quizzes[0];
  check(marien.name === "Café Marienlyst" && marien.details === "Hullet i veggen, Kirkeveien 104", "navn/detaljer splittet");
  const regs = await call("/mcp", "list_quiz_regions", {});
  check(regs.regions.map((r) => r.region).join() === "Akershus,Oslo,Vestland", "list_quiz_regions");
  console.log(`quiz ende-til-ende: ${n} ok`);
} finally {
  procs.forEach((p) => p.kill());
}
