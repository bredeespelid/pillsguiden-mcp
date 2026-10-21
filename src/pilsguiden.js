// Henter og normaliserer data fra pilsguiden.no (SvelteKit __data.json-endepunkter).
import { unflatten } from "devalue";

const BASE_URL = (process.env.PILSGUIDEN_BASE_URL || "https://www.pilsguiden.no").replace(/\/$/, "");
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 300) * 1000;
const USER_AGENT = process.env.USER_AGENT || "pilsguiden-mcp/1.0 (+https://github.com/)";

const cache = new Map(); // path -> { at, data }

function cleanPath(p) {
  return String(p || "")
    .toLowerCase()
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/[^a-z0-9\-]/g, ""))
    .filter(Boolean)
    .join("/");
}

async function fetchListNode(path) {
  const key = cleanPath(path);
  if (!key) throw new Error("Mangler sted, f.eks. 'oslo' eller 'oslo/grunerlokka'.");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const url = `${BASE_URL}/liste/${key}/__data.json`;
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
  });
  if (res.status === 404) throw new Error(`Fant ikke stedet '${key}' på Pilsguiden.`);
  if (!res.ok) throw new Error(`Pilsguiden svarte ${res.status} for ${url}`);
  const json = await res.json();

  if (json.type === "redirect") throw new Error(`Pilsguiden omdirigerer '${key}' til ${json.location}`);
  if (json.type === "error") throw new Error(`Pilsguiden-feil: ${JSON.stringify(json.error)}`);

  // Finn noden som inneholder listen (den med "list"-nøkkelen).
  let list = null;
  for (const node of json.nodes || []) {
    if (!node || node.type !== "data" || !Array.isArray(node.data)) continue;
    const value = unflatten(node.data);
    if (value && value.list) {
      list = value.list;
      break;
    }
  }
  if (!list) throw new Error("Uventet dataformat fra Pilsguiden (fant ikke 'list').");

  const data = normalize(list, key);
  cache.set(key, { at: Date.now(), data });
  return data;
}

function normalize(list, path) {
  const s = list.stats || {};
  const bars = (list.bars || []).map((b) => ({
    id: b.id,
    name: b.name,
    address: b.address || null,
    slug: b.slug,
    brewery: b.brewery || null,
    size_liters: b.size ?? null,
    price: b.price ?? null, // pris for oppgitt størrelse
    price_per_half_liter: b.pint ?? null, // normalisert til 0,5 l (det siden sorterer på)
    price_checked: b.price_checked || null,
    validity: b.valid_to || null,
    time_limited: b.default_price === false, // ⏰ på nettsiden
    normalized: b.size != null && b.size !== 0.5, // * på nettsiden
    location_id: b.location ?? null,
  }));

  const areas = Array.isArray(list.links)
    ? list.links
        .filter((l) => l && (l.slug || l.name))
        .map((l) => ({ name: l.name ?? null, slug: l.slug ?? null, id: l.id ?? null }))
    : [];

  return {
    path,
    url: `${BASE_URL}/liste/${path}`,
    location_name: s.location_name || path,
    stats: {
      median: s.median ?? null,
      mean: s.mean ?? null,
      count: s.count ?? null,
      parent_name: s.parent_name ?? null,
      parent_median: s.parent_median ?? null,
      parent_mean: s.parent_mean ?? null,
      parent_count: s.parent_count ?? null,
    },
    areas,
    breadcrumb: list.breadcrumb ?? null,
    bars,
    fetched_at: new Date().toISOString(),
  };
}

export async function getList(path) {
  return fetchListNode(path);
}

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/å/g, "a");

// Nåværende tid i Oslo som { hour, minute, iso }.
export function osloNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("nb-NO", {
      timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit", weekday: "long",
      year: "numeric", month: "2-digit", day: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return {
    hour: Number(parts.hour), minute: Number(parts.minute), weekday: parts.weekday,
    label: `${parts.weekday} ${parts.day}.${parts.month}.${parts.year} kl ${parts.hour}:${parts.minute}`,
  };
}

// Tolker gyldighetsteksten. Returnerer { until_hour } eller {} hvis alltid gyldig / ukjent.
export function parseValidity(text) {
  if (!text) return {};
  const m = String(text).match(/frem til kl\.?\s*(\d{1,2})(?:[:.](\d{2}))?/i);
  if (m) return { until_hour: Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0) };
  return {};
}

// Er prisen gyldig på gitt klokkeslett (timer, desimal)? Happy hour antas å gjelde fra åpning (ca. kl 12).
export function validAt(bar, hour) {
  if (!bar.time_limited) return true;
  const { until_hour } = parseValidity(bar.validity);
  if (until_hour == null) return true; // f.eks. "gjelder til stengetid"
  const h = hour < 6 ? hour + 24 : hour; // etter midnatt = sent på kvelden
  return h < until_hour;
}

export function ageDays(bar, now = Date.now()) {
  const t = Date.parse(bar.price_checked);
  return Number.isFinite(t) ? Math.floor((now - t) / 86400000) : null;
}

export function filterBars(bars, { max_price, min_price, brewery, query, only_regular_price, sort, limit }) {
  let out = bars.slice();
  if (query) {
    const q = norm(query);
    out = out.filter((b) => norm(b.name).includes(q) || norm(b.address).includes(q));
  }
  if (brewery) {
    const q = norm(brewery);
    out = out.filter((b) => norm(b.brewery).includes(q));
  }
  if (max_price != null) out = out.filter((b) => b.price_per_half_liter != null && b.price_per_half_liter <= max_price);
  if (min_price != null) out = out.filter((b) => b.price_per_half_liter != null && b.price_per_half_liter >= min_price);
  if (only_regular_price) out = out.filter((b) => !b.time_limited);

  const by = sort || "price_asc";
  const cmp = {
    price_asc: (a, b) => (a.price_per_half_liter ?? 1e9) - (b.price_per_half_liter ?? 1e9),
    price_desc: (a, b) => (b.price_per_half_liter ?? -1) - (a.price_per_half_liter ?? -1),
    name: (a, b) => a.name.localeCompare(b.name, "nb"),
    recently_checked: (a, b) => String(b.price_checked).localeCompare(String(a.price_checked)),
  }[by];
  if (cmp) out.sort(cmp);
  const total = out.length;
  return { total, bars: out.slice(0, limit ?? 25) };
}
