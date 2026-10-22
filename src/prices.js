// Alle priser per bar: henter /bar/<slug>/__data.json og tolker gyldighetsteksten.
//
// Listen (/liste/<sted>) viser bare den prisen som gjelder i det øyeblikket den hentes,
// så en bar med vanlig pris + happy hour mister den ene prisen. Detaljsiden har alle.
import { unflatten } from "devalue";

const BASE_URL = (process.env.PILSGUIDEN_BASE_URL || "https://www.pilsguiden.no").replace(/\/$/, "");
const DETAIL_TTL_MS = Number(process.env.DETAIL_CACHE_TTL_SECONDS || 6 * 3600) * 1000;
const CONCURRENCY = Number(process.env.DETAIL_CONCURRENCY || 12);
const USER_AGENT = process.env.USER_AGENT || "pilsguiden-mcp/1.0 (+https://github.com/bredeespelid/pillsguiden-mcp)";

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_NB = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];
const DAY_SHORT_NB = ["man", "tir", "ons", "tor", "fre", "lør", "søn"];

const fold = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/å/g, "a")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();

// mandag/man/monday/mon/... -> 0..6
export function dayIndex(word) {
  const w = fold(word);
  if (!w) return -1;
  const tables = [DAY_NB.map(fold), DAY_SHORT_NB.map(fold), ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], DAY_KEYS];
  for (const t of tables) {
    const i = t.findIndex((d) => d === w || (w.length >= 3 && d.startsWith(w)));
    if (i >= 0) return i;
  }
  return -1;
}

function range(a, b) {
  const out = [];
  for (let i = a; ; i = (i + 1) % 7) {
    out.push(i);
    if (i === b || out.length > 7) break;
  }
  return out;
}

// "mandag - lørdag", "onsdag", "Alle dager", "fredag og lørdag", "hverdager", "helg"
// -> [0..6] eller null (= alle dager). Returnerer undefined hvis ukjent.
export function parseDays(text) {
  const t = fold(text).replace(/\.$/, "");
  if (!t || /^(alle dager|hver dag|hele uken|daglig)$/.test(t)) return null;
  if (/^(hverdager|ukedager)$/.test(t)) return [0, 1, 2, 3, 4];
  if (/^(helg|helger|helgen)$/.test(t)) return [4, 5, 6];
  const set = new Set();
  for (const part of t.split(/\s*(?:,|\bog\b|&|\+)\s*/).filter(Boolean)) {
    const r = part.split(/\s*(?:-|–|til)\s*/).filter(Boolean);
    if (r.length === 2) {
      const a = dayIndex(r[0]);
      const b = dayIndex(r[1]);
      if (a < 0 || b < 0) return undefined;
      range(a, b).forEach((d) => set.add(d));
    } else if (r.length === 1) {
      const a = dayIndex(r[0]);
      if (a < 0) return undefined;
      set.add(a);
    } else return undefined;
  }
  if (!set.size) return undefined;
  if (set.size === 7) return null;
  return [...set].sort((a, b) => a - b);
}

const hm = (h, m) => Number(h) + (m ? Number(m) / 60 : 0);
const TIME = String.raw`(\d{1,2})(?:[:.](\d{2}))?`;

// Tolker gyldighetsteksten fra detaljsiden (og listens varianter).
// -> { type: "always"|"default"|"time_limited", from, until, days, parsed }
export function parseValidityText(text) {
  const raw = String(text || "").trim();
  const t = fold(raw);
  if (!t || /alltid gyldig/.test(t)) return { type: "always", from: null, until: null, days: null, parsed: true };
  if (/ingen annen pris|utenom happy hour/.test(t)) return { type: "default", from: null, until: null, days: null, parsed: true };

  // Del i tid-del og dag-del: "Gyldig mellom 15:00 og 21:00, mandag - lørdag"
  const body = t.replace(/^(prisen\s+)?(er\s+)?(gyldig|gjelder)\s*/, "");
  const comma = body.indexOf(",");
  const timePart = (comma >= 0 ? body.slice(0, comma) : body).trim();
  const dayPart = comma >= 0 ? body.slice(comma + 1).trim() : "";
  const days = dayPart ? parseDays(dayPart) : null;

  let from = null;
  let until = null;
  let ok = true;
  let m;
  if ((m = timePart.match(new RegExp(String.raw`(?:mellom|fra)\s*(?:kl\.?\s*)?${TIME}\s*(?:og|til|-|–)\s*(?:kl\.?\s*)?${TIME}`)))) {
    from = hm(m[1], m[2]);
    until = hm(m[3], m[4]);
  } else if ((m = timePart.match(new RegExp(String.raw`(?:for|frem til|til|inntil)\s*(?:kl\.?\s*)?${TIME}`)))) {
    until = hm(m[1], m[2]); // "før kl 15:00" (fold gjør ø->o), "frem til kl 21"
  } else if ((m = timePart.match(new RegExp(String.raw`(?:etter|fra)\s*(?:kl\.?\s*)?${TIME}`)))) {
    from = hm(m[1], m[2]);
  } else if (/hele apningstiden|hele dagen|til stengetid|^$/.test(timePart)) {
    // hele dagen på angitte dager
  } else {
    ok = false;
  }
  if (days === undefined) ok = false;
  return { type: "time_limited", from, until, days: days === undefined ? null : days, parsed: ok };
}

const pad = (h) => {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return mm ? `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}` : String(hh).padStart(2, "0");
};

function daysLabel(days) {
  if (!days) return "alle dager";
  // Sammenhengende rekke (også over søndag->mandag) vises som "man–lør".
  const s = new Set(days);
  if (days.length > 2) {
    for (let start = 0; start < 7; start++) {
      if (s.has(start) && !s.has((start + 6) % 7)) {
        const seq = range(start, (start + days.length - 1) % 7);
        if (seq.every((d) => s.has(d))) return `${DAY_SHORT_NB[start]}–${DAY_SHORT_NB[(start + days.length - 1) % 7]}`;
      }
    }
  }
  return days.map((d) => DAY_SHORT_NB[d]).join(", ");
}

export function windowLabel(p) {
  if (p.type !== "time_limited") return p.type === "always" ? "alltid" : "vanlig pris";
  let time = "hele dagen";
  if (p.from != null && p.until != null) time = `${pad(p.from)}–${pad(p.until)}`;
  else if (p.until != null) time = `til ${pad(p.until)}`;
  else if (p.from != null) time = `fra ${pad(p.from)}`;
  return `${time}, ${daysLabel(p.days)}`;
}

// Gjelder et tidsvindu på gitt ukedag (0=man) og klokkeslett (desimal)?
// Vinduer over midnatt (22–02) gjelder også natt til neste dag.
export function windowApplies(p, day, hour) {
  if (!p.parsed) return false;
  const onDay = (d) => !p.days || p.days.includes(((d % 7) + 7) % 7);
  const from = p.from ?? (p.until != null ? 6 : 0);
  const until = p.until ?? 24;
  if (until > from) {
    if (onDay(day) && hour >= from && hour < until) return true;
    // Sent på natten (00–06) regnes med til forrige kveld for vinduer som går "til stengetid".
    if (p.until == null && hour < 6 && onDay(day - 1)) return true;
    return false;
  }
  // over midnatt
  return (onDay(day) && hour >= from) || (onDay(day - 1) && hour < until);
}

// Prisen som gjelder på et tidspunkt: billigste tidsbegrensede som gjelder, ellers vanlig pris.
export function applicablePrices(prices, day, hour) {
  const timed = prices.filter((p) => p.type === "time_limited" && windowApplies(p._v || p, day, hour));
  if (timed.length) return timed;
  return prices.filter((p) => p.type !== "time_limited");
}

// ---------- henting ----------

const detailCache = new Map(); // slug -> { at, data } | { at, error }
const inflight = new Map();

async function fetchDetail(slug) {
  const url = `${BASE_URL}/bar/${encodeURIComponent(slug)}/__data.json`;
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  for (const node of json.nodes || []) {
    if (node?.type === "error") throw new Error(node.error?.message || "error");
    if (node?.type !== "data" || !Array.isArray(node.data)) continue;
    const v = unflatten(node.data);
    if (v?.barObj) return v.barObj;
  }
  throw new Error("fant ikke barObj");
}

export async function getBarDetail(slug, { fresh = false } = {}) {
  const hit = detailCache.get(slug);
  if (!fresh && hit && Date.now() - hit.at < (hit.error ? 10 * 60 * 1000 : DETAIL_TTL_MS)) {
    if (hit.error) throw new Error(hit.error);
    return hit.data;
  }
  if (inflight.has(slug)) return inflight.get(slug);
  const p = fetchDetail(slug)
    .then((data) => {
      detailCache.set(slug, { at: Date.now(), data });
      return data;
    })
    .catch((e) => {
      detailCache.set(slug, { at: Date.now(), error: String(e.message || e) });
      throw e;
    })
    .finally(() => inflight.delete(slug));
  inflight.set(slug, p);
  return p;
}

export function cachedDetail(slug) {
  const hit = detailCache.get(slug);
  return hit && !hit.error && Date.now() - hit.at < DETAIL_TTL_MS ? hit.data : null;
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          out[idx] = { ok: true, value: await fn(items[idx], idx) };
        } catch (e) {
          out[idx] = { ok: false, error: String(e.message || e) };
        }
      }
    })
  );
  return out;
}

// ---------- normalisering ----------

function priceFromDetail(p, bar) {
  const v = parseValidityText(p.valid);
  return {
    id: p.id ?? null,
    price: p.price ?? null,
    size_liters: bar.size ?? null,
    price_per_half_liter: p.pint ?? null,
    brewery: bar.brewery ?? null,
    price_checked: p.price_checked ?? null,
    type: v.type === "time_limited" ? "time_limited" : "default",
    valid_from_hour: v.from,
    valid_until_hour: v.until,
    days: v.days ? v.days.map((d) => DAY_KEYS[d]) : null,
    validity: p.valid ?? null,
    window: windowLabel(v),
    active_on_site: p.active ?? null,
    parsed: v.parsed,
    _v: v,
  };
}

function priceFromListEntry(b) {
  const v = parseValidityText(b.validity);
  return {
    id: null,
    price: b.price,
    size_liters: b.size_liters,
    price_per_half_liter: b.price_per_half_liter,
    brewery: b.brewery,
    price_checked: b.price_checked,
    type: v.type === "time_limited" ? "time_limited" : "default",
    valid_from_hour: v.from,
    valid_until_hour: v.until,
    days: v.days ? v.days.map((d) => DAY_KEYS[d]) : null,
    validity: b.validity,
    window: windowLabel(v),
    active_on_site: true,
    parsed: v.parsed,
    _v: v,
  };
}

// Hurtigsjekk: "Prisen er alltid gyldig" i lista betyr IKKE alltid én pris – kontrollen viste at
// barer med en egen dagspris (f.eks. "hele åpningstiden, tirsdag") også vises slik. Brukes bare i audit.
export function needsDetail(b) {
  return !(b.time_limited === false && /alltid gyldig/i.test(b.validity || ""));
}

const WAIT_MS = Number(process.env.DETAIL_WAIT_MS || 25000);

// Legger til `prices` (alle priser) på hver bar ved å hente detaljsiden for ALLE barer (cachet i 6 t).
// Venter maks WAIT_MS på henting; det som ikke er ferdig fylles fra lista og hentes videre i bakgrunnen.
export async function withAllPrices(bars, { waitMs = WAIT_MS } = {}) {
  const missing = bars.filter((b) => !cachedDetail(b.slug));
  let incomplete = 0;
  if (missing.length) {
    const job = mapLimit(missing, CONCURRENCY, (b) => getBarDetail(b.slug));
    await Promise.race([job, new Promise((r) => setTimeout(r, waitMs))]);
  }
  const out = bars.map((b) => {
    const d = cachedDetail(b.slug);
    if (!d) incomplete++;
    const prices = d && Array.isArray(d.prices) && d.prices.length ? d.prices.map((p) => priceFromDetail(p, d)) : [priceFromListEntry(b)];
    return { ...b, prices, prices_source: d ? "bar_page" : "list" };
  });
  out.incomplete = incomplete;
  return out;
}

export const publicPrice = ({ _v, ...p }) => p;
