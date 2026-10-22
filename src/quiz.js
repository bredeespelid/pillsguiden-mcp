// Pubquizer fra Norges Quizforbund (norgesquizforbund.no/arrangementer/finn-din-pubquiz/).
// Siden er en WordPress-side med én tabell (#pubquiz-table). Vi henter den via WP REST-API-et.
import { parse } from "node-html-parser";

const QUIZ_BASE = (process.env.QUIZ_BASE_URL || "https://www.norgesquizforbund.no").replace(/\/$/, "");
export const QUIZ_PAGE = "https://www.norgesquizforbund.no/arrangementer/finn-din-pubquiz/";
const TTL_MS = Number(process.env.QUIZ_CACHE_TTL_SECONDS || 3600) * 1000;
const USER_AGENT = process.env.USER_AGENT || "pilsguiden-mcp/1.0 (+https://github.com/bredeespelid/pillsguiden-mcp)";

export const DAY_NB = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];
const DAY_RE = /(man|tirs|ons|tors|fre|lør|søn)dag(?:er)?/gi;

const fold = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/å/g, "a")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const ORD = { første: 1, forste: 1, andre: 2, tredje: 3, fjerde: 4, femte: 5 };

// Tolker dag-kolonnen: "Tirsdag (annenhver, oddetallsuker)", "1. tirsdag hver måned", "Mandag (Søndag)" …
export function parseSchedule(text) {
  const raw = String(text || "").trim();
  const t = raw.toLowerCase();
  const days = [];
  for (const m of t.matchAll(DAY_RE)) {
    const i = ["man", "tirs", "ons", "tors", "fre", "lør", "søn"].indexOf(m[1]);
    if (i >= 0 && !days.includes(i)) days.push(i);
  }
  let frequency = "weekly";
  let nth = null;
  let label = "hver uke";
  const ftxt = fold(t);
  if (/annenhver|hver andre uke|partall|oddetal/.test(ftxt)) {
    if (/oddetal/.test(ftxt)) [frequency, label] = ["odd_weeks", "oddetallsuker"];
    else if (/partall/.test(ftxt)) [frequency, label] = ["even_weeks", "partallsuker"];
    else [frequency, label] = ["biweekly", "annenhver uke"];
  } else if (/siste/.test(ftxt)) {
    [frequency, label] = ["monthly_last", "siste i måneden"];
  } else if (/(\d)\.\s*[a-zæøå]*dag|\b(\d)\.\s*(i|hver)/.test(t) || /\b(forste|andre|tredje|fjerde|femte)\b/.test(ftxt)) {
    const m = t.match(/(\d)\./);
    const w = ftxt.match(/\b(forste|andre|tredje|fjerde|femte)\b/);
    nth = m ? Number(m[1]) : ORD[w[1]];
    [frequency, label] = ["monthly_nth", `${nth}. i måneden`];
  } else if (/maned|gang i|gang per/.test(ftxt)) {
    [frequency, label] = ["monthly", "én gang i måneden"];
  } else if (/utvalgte|varierer|ujevn/.test(ftxt)) {
    [frequency, label] = ["irregular", "utvalgte datoer"];
  }
  return { days, frequency, nth, label, text: raw };
}

const isoWeek = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((dt - first) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
};

// Går quizen den gitte datoen? true / false / null (= kanskje – sjekk med stedet)
export function occursOn(sched, date) {
  const { y, m, d, dow } = date;
  if (!sched.days.length) return null;
  if (!sched.days.includes(dow)) return false;
  switch (sched.frequency) {
    case "weekly":
      return true;
    case "odd_weeks":
      return isoWeek(y, m, d) % 2 === 1;
    case "even_weeks":
      return isoWeek(y, m, d) % 2 === 0;
    case "monthly_nth":
      return Math.ceil(d / 7) === sched.nth;
    case "monthly_last":
      return d + 7 > new Date(Date.UTC(y, m, 0)).getUTCDate();
    default:
      return null;
  }
}

function splitVenue(v) {
  const m = v.match(/^(.*?)\s*[(«]\s*(.+?)\s*[)»]?\s*$/);
  if (m && m[1]) return { name: m[1].replace(/,\s*$/, "").trim(), details: m[2].replace(/[()«»]/g, "").trim() };
  return { name: v.trim(), details: null };
}

const clean = (s) => String(s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

export function parseTable(html) {
  const root = parse(html);
  const table = root.querySelector("#pubquiz-table") || root.querySelector("table");
  if (!table) throw new Error("Fant ikke quiztabellen på norgesquizforbund.no");
  const out = [];
  let region = null;
  for (const tr of table.querySelectorAll("tr")) {
    const tds = tr.querySelectorAll("td,th");
    if (!tds.length) continue;
    if (tds.length === 1 || tds[0].getAttribute("colspan")) {
      const r = clean(tds[0].text);
      if (r) region = r;
      continue;
    }
    if (tds.length < 6) continue;
    const [, cityTd, venueTd, dayTd, timeTd, typeTd] = tds;
    const venue = clean(venueTd.text);
    if (!venue) continue;
    const a = venueTd.querySelector("a");
    const time = clean(timeTd.text).match(/(\d{1,2})[:.](\d{2})/);
    const sched = parseSchedule(clean(dayTd.text));
    const { name, details } = splitVenue(venue);
    out.push({
      region,
      city: clean(cityTd.text) || region,
      venue,
      name,
      details,
      link: a?.getAttribute("href") || null,
      day_text: sched.text,
      days: sched.days.map((d) => DAY_NB[d]),
      frequency: sched.frequency,
      frequency_label: sched.label,
      time: time ? `${time[1].padStart(2, "0")}:${time[2]}` : null,
      type: clean(typeTd.text) || null,
      _sched: sched,
    });
  }
  return out;
}

let cache = null;
export async function getQuizzes() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const url = `${QUIZ_BASE}/wp-json/wp/v2/pages?slug=finn-din-pubquiz&_fields=id,modified,content`;
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
  if (!res.ok) throw new Error(`norgesquizforbund.no svarte ${res.status}`);
  const json = await res.json();
  const page = Array.isArray(json) ? json[0] : json;
  if (!page?.content?.rendered) throw new Error("Uventet svar fra norgesquizforbund.no");
  cache = { at: Date.now(), modified: page.modified || null, quizzes: parseTable(page.content.rendered) };
  return cache;
}

// ---------- dato ----------

export function osloDate(offsetDays = 0, base = new Date()) {
  const dt = new Date(base.getTime() + offsetDays * 86400000);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Oslo", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(dt)
      .map((x) => [x.type, x.value])
  );
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    dow: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday),
    hour: Number(p.hour) + Number(p.minute) / 60,
    iso: `${p.year}-${p.month}-${p.day}`,
  };
}

// "i dag" | "i morgen" | "tirsdag" | "2026-10-27" | "27.10" -> dato (neste forekomst av ukedagen, i dag inkludert)
export function resolveDate(when, base = new Date()) {
  const today = osloDate(0, base);
  const w = fold(String(when ?? "i dag").trim());
  if (!w || /^(i ?dag|na|today|now|i kveld|ikveld)$/.test(w)) return today;
  if (/^(i ?morgen|tomorrow)$/.test(w)) return osloDate(1, base);
  if (/^i ?overmorgen$/.test(w)) return osloDate(2, base);
  let m = w.match(/^(\d{4})-(\d{2})-(\d{2})$/) || null;
  if (m || (m = w.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{4})?$/))) {
    const [y, mo, d] = m[0].includes("-") ? [m[1], m[2], m[3]] : [m[3] || today.y, m[2], m[1]];
    const target = Date.UTC(Number(y), Number(mo) - 1, Number(d), 12);
    const diff = Math.round((target - Date.UTC(today.y, today.m - 1, today.d, 12)) / 86400000);
    return osloDate(diff, base);
  }
  const names = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lordag", "sondag"];
  const short = ["man", "tir", "ons", "tor", "fre", "lor", "son"];
  const next = /neste|nest/.test(w);
  for (let i = 0; i < 7; i++) {
    if (w.includes(names[i]) || w.split(/\s+/).includes(short[i])) {
      let diff = (i - today.dow + 7) % 7;
      if (next && diff === 0) diff = 7;
      return osloDate(diff, base);
    }
  }
  throw new Error(`Forstod ikke dagen '${when}'. Bruk f.eks. 'i dag', 'i morgen', 'tirsdag' eller '2026-10-27'.`);
}

export const publicQuiz = ({ _sched, ...q }) => q;
