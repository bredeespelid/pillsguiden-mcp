// Tester mot lokal mock. Kjør: node test/run.mjs
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { parseValidityText, windowApplies, windowLabel } from "../src/prices.js";

// ---- parser ----
const cases = [
  ["Prisen er alltid gyldig", { type: "always" }],
  ["Gyldig når ingen annen pris gjelder", { type: "default" }],
  ["Prisen gjelder utenom happy hour", { type: "default" }],
  ["Gyldig mellom 15:00 og 21:00, mandag - lørdag", { type: "time_limited", from: 15, until: 21, days: [0, 1, 2, 3, 4, 5], label: "15–21, man–lør" }],
  ["Gyldig mellom 16:00 og 21:00, Alle dager", { from: 16, until: 21, days: null, label: "16–21, alle dager" }],
  ["Gyldig før kl 15:00, Alle dager", { from: null, until: 15, label: "til 15, alle dager" }],
  ["Gyldig hele åpningstiden, onsdag", { from: null, until: null, days: [2], label: "hele dagen, ons" }],
  ["Gyldig etter kl 22:30, fredag og lørdag", { from: 22.5, until: null, days: [4, 5] }],
  ["Gyldig mellom 22:00 og 02:00, fredag - søndag", { from: 22, until: 2, days: [4, 5, 6] }],
  ["Gyldig mellom 17:00 og 19:00, søndag - tirsdag", { days: [0, 1, 6] }],
  ["Gyldig frem til kl 21", { until: 21, days: null }],
  ["Prisen gjelder til stengetid", { type: "time_limited", from: null, until: null }],
  ["Gyldig mellom 15:00 og 21:00, mandag, onsdag, fredag", { days: [0, 2, 4] }],
];
for (const [text, exp] of cases) {
  const v = parseValidityText(text);
  assert.ok(v.parsed, `ikke tolket: ${text}`);
  for (const [k, val] of Object.entries(exp)) {
    if (k === "label") assert.equal(windowLabel(v), val, text);
    else assert.deepEqual(v[k], val, `${text} → ${k}`);
  }
}
assert.equal(parseValidityText("Gyldig på fullmåne").parsed, false);
// over midnatt: fredag 22–02 gjelder natt til lørdag kl 01, ikke natt til fredag
const night = parseValidityText("Gyldig mellom 22:00 og 02:00, fredag");
assert.equal(windowApplies(night, 5, 1), true);
assert.equal(windowApplies(night, 4, 1), false);
assert.equal(windowApplies(night, 4, 23), true);
console.log(`parser: ${cases.length + 4} ok`);

// ---- ende-til-ende ----
const procs = [
  spawn("node", ["test/mock-pilsguiden.mjs"], { env: { ...process.env, MOCK_PORT: "4011" }, stdio: "inherit" }),
  spawn("node", ["src/http.js"], { env: { ...process.env, PORT: "3990", PILSGUIDEN_BASE_URL: "http://localhost:4011" }, stdio: "ignore" }),
];
await new Promise((r) => setTimeout(r, 1500));
let id = 0;
async function call(name, args) {
  const res = await fetch("http://localhost:3990/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = await res.json();
  if (j.result.isError) throw new Error(j.result.content[0].text);
  return JSON.parse(j.result.content[0].text);
}
const sip = (r) => r.suggestions.find((s) => s.name === "SIP Oslo");
const doner = (r) => r.suggestions.find((s) => s.name === "Döner Bros");
let ok = 0;
const check = (cond, msg) => {
  assert.ok(cond, msg);
  ok++;
  console.log("  ✓", msg);
};
try {
  const f = await call("find_bar", { name: "Sip" });
  const ps = f.bars[0].prices;
  check(ps.length === 2, "find_bar(Sip) → 2 priser");
  check(ps.some((p) => p.price === 68 && p.type === "default"), "  68 kr default");
  check(ps.some((p) => p.price === 49 && p.type === "time_limited" && p.valid_from_hour === 15 && p.valid_until_hour === 21 && p.days.join() === "mon,tue,wed,thu,fri,sat"), "  49 kr 15–21 man–lør");
  check(f.bars[0].price === 68 && f.bars[0].validity === "Prisen gjelder utenom happy hour", "  gamle toppfelt beholdt");

  const all = await call("cheap_beer_now", { limit: 50, max_price: 85 });
  check(all.suggestions[0].name === "SIP Oslo" && all.suggestions[0].price === 49, `uten when: SIP 49 øverst (fikk ${all.suggestions[0].name} ${all.suggestions[0].price})`);
  check(sip(all).window === "15–21, man–lør" && sip(all).other_prices[0].price === 68, "  vindu + other_prices");
  check(doner(all).price === 54 && doner(all).other_prices.length === 0, "  Döner uendret 54");

  const at12 = await call("cheap_beer_now", { when: "12", day: "torsdag", limit: 50 });
  check(sip(at12).price === 68, `torsdag kl 12 → SIP 68 (fikk ${sip(at12).price})`);
  check(at12.suggestions.find((s) => s.name === "Bar Royal").price === 59, "  Bar Royal 59 før 15");

  const at18 = await call("cheap_beer_now", { when: "torsdag 18", limit: 50 });
  check(sip(at18).price === 49, "torsdag kl 18 → SIP 49");
  check(at18.suggestions.find((s) => s.name === "Bar Royal").price === 69, "  Bar Royal 69 etter 15");
  check(at18.suggestions.find((s) => s.name === "Cafe Stolen").price === 83, "  Cafe Stolen 83 (75 kun onsdag)");

  const sun = await call("cheap_beer_now", { when: "søndag 18", limit: 50 });
  check(sip(sun).price === 68 && sun.evaluated_for === "søndag kl 18:00", "søndag kl 18 → SIP 68");
  const sun2 = await call("cheap_beer_now", { when: 18, day: "søndag", limit: 50 });
  check(sip(sun2).price === 68, "  samme med day-parameter");

  const wed = await call("cheap_beer_now", { when: "onsdag 18", limit: 50 });
  check(wed.suggestions.find((s) => s.name === "Cafe Stolen").price === 75, "onsdag → Cafe Stolen 75");

  const irish = await call("cheap_beer_now", { when: "21:30", day: "torsdag", limit: 50 });
  check(irish.suggestions.find((s) => s.name.startsWith("The Old Irish")).price === 49, "21:30 → Old Irish 49 (20–23)");
  check(doner(irish).price === 54, "  Döner 54");

  const audit = await call("audit_prices", {});
  check(audit.bars_with_multiple_prices === 5 && audit.not_caught_by_quick_check.length === 0 && audit.unparsed_validity_texts.length === 0, "audit_prices: 5 med flere priser, ingen bommet");

  console.log(`ende-til-ende: ${ok} ok`);
} finally {
  procs.forEach((p) => p.kill());
}
