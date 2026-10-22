// MCP-server for Pilsguiden – ølpriser i Norge.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getList, filterBars, osloNow, ageDays } from "./pilsguiden.js";
import { registerQuizTools } from "./quiz-tools.js";
import {
  withAllPrices,
  applicablePrices,
  publicPrice,
  dayIndex,
  needsDetail,
  getBarDetail,
  mapLimit,
  parseValidityText,
} from "./prices.js";

const DEFAULT_PLACE = process.env.DEFAULT_PLACE || "oslo";
const DAY_NB = ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag"];

const placeSchema = z
  .string()
  .optional()
  .describe(
    `Sted som sti under /liste/, f.eks. 'oslo', 'oslo/grunerlokka', 'bergen'. Standard: '${DEFAULT_PLACE}'. Bruk list_areas for gyldige bydeler.`
  );

const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (err) => ({ isError: true, content: [{ type: "text", text: String(err?.message || err) }] });

const hhmm = (h) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

// "nå" | "18" | "18:30" | 21.5 | "søndag 18" | "i morgen 20"  (+ valgfri day-parameter)
function parseWhen(when, dayArg, now) {
  const w = when == null ? "" : String(when).trim().toLowerCase();
  let day = now.day;
  let hour = null;
  let explicitDay = false;

  const setDay = (word) => {
    const t = String(word).trim().toLowerCase();
    if (!t || t === "i dag" || t === "idag" || t === "today") return true;
    if (t === "i morgen" || t === "imorgen" || t === "tomorrow") {
      day = (now.day + 1) % 7;
      explicitDay = true;
      return true;
    }
    const i = dayIndex(t);
    if (i < 0) return false;
    day = i;
    explicitDay = true;
    return true;
  };

  if (dayArg != null && !setDay(dayArg)) throw new Error(`Forstod ikke dagen '${dayArg}'. Bruk f.eks. 'søndag' eller 'i morgen'.`);

  if (!w) return { hour: null, day, explicitDay };
  if (["nå", "na", "now"].includes(w)) return { hour: now.hour + now.minute / 60, day: explicitDay ? day : now.day, explicitDay, isNow: !explicitDay };

  let rest = w;
  for (const re of [/\bi\s*morgen\b|\bimorgen\b|\btomorrow\b/, /\bi\s*dag\b|\bidag\b/]) {
    const m = rest.match(re);
    if (m) {
      setDay(m[0]);
      rest = rest.replace(re, " ");
    }
  }
  const word = rest.match(/[a-zæøå]{3,}/);
  if (word && !/^kl$/.test(word[0]) && dayIndex(word[0]) >= 0) {
    setDay(word[0]);
    rest = rest.replace(word[0], " ");
  }
  const m = rest.match(/(\d{1,2})(?:[:.,](\d{1,2}))?/);
  if (!m) {
    if (explicitDay) return { hour: null, day, explicitDay };
    throw new Error("Forstod ikke tidspunktet. Bruk 'nå' eller f.eks. '18', '18:30', 'søndag 18'.");
  }
  const frac = m[2] ? (rest.includes(":") || m[2].length === 2 ? Number(m[2]) / 60 : Number("0." + m[2])) : 0;
  hour = Number(m[1]) + frac;
  if (hour >= 24) hour -= 24;
  return { hour, day, explicitDay };
}

const sortKey = (by) => (by === "half_liter" ? "price_per_half_liter" : "price");
const cmpPrices = (key) => (a, b) =>
  (a[key] ?? 1e9) - (b[key] ?? 1e9) ||
  (a.price_per_half_liter ?? 1e9) - (b.price_per_half_liter ?? 1e9) ||
  String(b.price_checked).localeCompare(String(a.price_checked));

const briefPrice = (p) => ({
  price: p.price,
  size_liters: p.size_liters,
  price_per_half_liter: p.price_per_half_liter,
  type: p.type,
  window: p.window,
  validity: p.validity,
});

export function createServer() {
  const server = new McpServer(
    { name: "pilsguiden", version: "1.5.0" },
    {
      instructions:
        "Ølpriser fra pilsguiden.no. Mange barer har flere priser (vanlig pris + happy hour med tidsvindu og ukedager). " +
        "For 'hvor er det billig pils?' bruk cheap_beer_now: uten 'when' vurderes hver pris for seg (happy hour inkludert, merket med vindu som '15–21, man–lør'); med 'when' (og evt. dag) brukes prisen som faktisk gjelder da. " +
        "Presenter i listens rekkefølge (billigste glass først), oppgi størrelse og pris per halvliter, og vis tidsvinduet for happy hour. find_bar gir alle priser for én bar. " +
        "Pubquiz: bruk find_quizzes (standard Oslo, i dag). Den viser også pilspris på quiz-tidspunktet der stedet finnes på Pilsguiden. Quizer med happens=null går annenhver uke/månedlig – si at man bør sjekke lenken.",
    }
  );

  server.registerTool(
    "list_bars",
    {
      title: "Ølpriser – liste",
      description:
        "Henter barer/utesteder med pilspris fra pilsguiden.no for et sted (standard Oslo). Toppnivå-prisen er den som gjelder akkurat nå på nettsiden; `prices` har alle priser per bar. Kan filtreres og sorteres.",
      inputSchema: {
        place: placeSchema,
        max_price: z.number().optional().describe("Maks pris per halvliter (NOK)"),
        min_price: z.number().optional().describe("Min pris per halvliter (NOK)"),
        brewery: z.string().optional().describe("Filtrer på bryggeri/merke, f.eks. 'Ringnes', 'Hansa'"),
        query: z.string().optional().describe("Fritekstsøk i navn og adresse, f.eks. 'Torggata'"),
        only_regular_price: z.boolean().optional().describe("Utelat tidsbegrensede priser (happy hour o.l.)"),
        sort: z.enum(["price_asc", "price_desc", "name", "recently_checked"]).optional(),
        limit: z.number().int().min(1).max(500).optional().describe("Antall resultater (standard 25)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ place, ...filters }) => {
      try {
        const data = await getList(place || DEFAULT_PLACE);
        const { total, bars } = filterBars(data.bars, filters);
        const enriched = await withAllPrices(bars);
        return json({
          location: data.location_name,
          source: data.url,
          median_price: data.stats.median,
          matches: total,
          returned: bars.length,
          bars: enriched.map((b) => ({ ...b, prices: b.prices.map(publicPrice) })),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "cheap_beer_now",
    {
      title: "Billigste pils (inkl. happy hour)",
      description:
        "Svarer på 'hvor er det billig pils?'. Én rad per bar med den billigste prisen, pluss `other_prices` med barens andre priser. " +
        "Uten 'when': hver pris vurderes for seg, så happy hour-priser er med og merket med vindu (f.eks. '15–21, man–lør'). " +
        "Med 'when' ('nå', '18', '21:30', 'søndag 18') og evt. 'day': bare prisen som faktisk gjelder på den ukedagen og det klokkeslettet (Oslo-tid); utenfor happy hour brukes vanlig pris. " +
        "Sortert på glasspris (det du betaler) som standard. Presenter i samme rekkefølge, oppgi størrelse og pris per halvliter, og vis tidsvinduet for happy hour.",
      inputSchema: {
        place: placeSchema,
        when: z
          .union([z.string(), z.number()])
          .optional()
          .describe("Valgfritt. 'nå', klokkeslett ('18', '18:30') eller dag + tid ('søndag 18', 'i morgen 20'). Utelat for å se alle billigste priser inkl. happy hour."),
        day: z.string().optional().describe("Valgfritt. Ukedag ('søndag', 'fredag', 'i morgen'). Standard: i dag."),
        sort_by: z
          .enum(["half_liter", "glass"])
          .optional()
          .describe("'glass' (standard: billigste glass uansett størrelse) eller 'half_liter' (omregnet til 0,5 l)"),
        max_price: z.number().optional().describe("Maks pris per halvliter (NOK)"),
        max_age_days: z.number().int().optional().describe("Ignorer priser sjekket for mer enn så mange dager siden (standard 365)"),
        limit: z.number().int().min(1).max(50).optional().describe("Antall forslag (standard 10)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ place, when, day, sort_by, max_price, max_age_days, limit }) => {
      try {
        const now = osloNow();
        const t = parseWhen(when, day, now);
        const timeFilter = t.hour != null;
        const label = !timeFilter
          ? t.explicitDay
            ? `${DAY_NB[t.day]} (alle tider, inkl. happy hour)`
            : "alle tider (inkl. happy hour)"
          : t.isNow
            ? now.label
            : `${DAY_NB[t.day]} kl ${hhmm(t.hour)}`;

        const d = await getList(place || DEFAULT_PLACE);
        const bars = await withAllPrices(d.bars.filter((b) => b.price_per_half_liter != null));
        const key = sortKey(sort_by);
        const maxAge = max_age_days ?? 365;
        const okPrice = (p) => {
          const age = ageDays(p);
          return p[key] != null && (age == null || age <= maxAge) && (max_price == null || (p.price_per_half_liter ?? 1e9) <= max_price);
        };

        const rows = [];
        let allEvening = null;
        for (const b of bars) {
          let pool = b.prices;
          if (timeFilter) pool = applicablePrices(b.prices, t.day, t.hour);
          else if (t.explicitDay)
            pool = b.prices.filter((p) => p.type !== "time_limited" || !p._v.days || p._v.days.includes(t.day));
          pool = pool.filter(okPrice);
          if (!pool.length) continue;
          const chosen = [...pool].sort(cmpPrices(key))[0];
          const others = b.prices.filter((p) => p !== chosen);
          rows.push({ b, chosen, others });

          const def = b.prices.filter((p) => p.type !== "time_limited" && okPrice(p)).sort(cmpPrices(key))[0];
          if (def && (!allEvening || cmpPrices(key)(def, allEvening.p) < 0)) allEvening = { b, p: def };
        }
        rows.sort((x, y) => cmpPrices(key)(x.chosen, y.chosen));

        const row = ({ b, chosen: p, others }) => ({
          name: b.name,
          price: p.price,
          size_liters: p.size_liters,
          price_per_half_liter: p.price_per_half_liter,
          happy_hour: p.type === "time_limited",
          price_type: p.type,
          window: p.window,
          valid_from_hour: p.valid_from_hour,
          valid_until_hour: p.valid_until_hour,
          days: p.days,
          validity: p.validity,
          brewery: p.brewery ?? b.brewery,
          address: b.address,
          price_checked: p.price_checked,
          price_age_days: ageDays(p),
          other_prices: others.map(briefPrice),
        });
        const picks = rows.slice(0, limit ?? 10).map(row);
        const brief = (r) =>
          r && {
            name: r.b.name,
            price: r.p.price,
            size_liters: r.p.size_liters,
            price_per_half_liter: r.p.price_per_half_liter,
            window: r.p.window,
            address: r.b.address,
          };
        const cheapestGlass = rows.length ? [...rows].sort((x, y) => cmpPrices("price")(x.chosen, y.chosen))[0] : null;

        return json({
          location: d.location_name,
          source: d.url,
          evaluated_for: label,
          sorted_by: key === "price" ? "glasspris" : "pris per halvliter",
          median_price: d.stats.median,
          matches: rows.length,
          ...(bars.incomplete ? { warning: `${bars.incomplete} barer mangler detaljpriser akkurat nå (henter fortsatt) – prøv igjen om et halvt minutt for komplett liste.` } : {}),
          cheapest_glass: cheapestGlass && { ...brief({ b: cheapestGlass.b, p: cheapestGlass.chosen }), happy_hour: cheapestGlass.chosen.type === "time_limited" },
          cheapest_all_evening: brief(allEvening),
          note:
            (timeFilter
              ? "Viser prisen som gjelder på valgt dag og klokkeslett. "
              : "Ingen tid oppgitt: hver pris vurderes for seg, så happy hour-priser er med – vis vinduet (window). ") +
            "price = glasspris for size_liters; price_per_half_liter = omregnet til 0,5 l. other_prices = barens andre priser. Prisene er brukerrapporterte.",
          suggestions: picks,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "get_price_stats",
    {
      title: "Prisstatistikk",
      description: "Median- og snittpris per halvliter for et sted, sammenlignet med overordnet område (f.eks. Norge).",
      inputSchema: { place: placeSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ place }) => {
      try {
        const d = await getList(place || DEFAULT_PLACE);
        const prices = d.bars.map((b) => b.price_per_half_liter).filter((p) => p != null);
        const s = d.stats;
        return json({
          location: d.location_name,
          source: d.url,
          ...s,
          difference_from_parent: s.median != null && s.parent_median != null ? s.median - s.parent_median : null,
          cheapest: prices.length ? Math.min(...prices) : null,
          most_expensive: prices.length ? Math.max(...prices) : null,
          bars_listed: d.bars.length,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_areas",
    {
      title: "Bydeler/områder",
      description: "Lister underområder (bydeler) for et sted, med slug som kan brukes i 'place', f.eks. 'oslo/grunerlokka'.",
      inputSchema: { place: placeSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ place }) => {
      try {
        const d = await getList(place || DEFAULT_PLACE);
        return json({
          location: d.location_name,
          areas: d.areas.map((a) => ({ ...a, place: a.slug ? `${d.path}/${a.slug}` : null })),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "find_bar",
    {
      title: "Finn bar",
      description:
        "Søk etter en bar på navn. Gir `prices` med ALLE priser (vanlig pris og happy hour), hver med pris, størrelse, pris per halvliter, type, tidsvindu (valid_from_hour/valid_until_hour), ukedager og gyldighetstekst.",
      inputSchema: {
        name: z.string().describe("Hele eller deler av navnet, f.eks. 'Bar Royal'"),
        place: placeSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name, place }) => {
      try {
        const d = await getList(place || DEFAULT_PLACE);
        const { total, bars } = filterBars(d.bars, { query: name, sort: "name", limit: 20 });
        const enriched = await withAllPrices(bars);
        return json({
          location: d.location_name,
          matches: total,
          bars: enriched.map((b) => ({ ...b, prices: b.prices.map(publicPrice) })),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "audit_prices",
    {
      title: "Kontroll: priser per bar",
      description:
        "Vedlikehold: henter detaljsiden for ALLE barer på et sted og sammenligner antall priser med det lista viser. Rapporterer barer med flere priser, barer der hurtigsjekken ville bommet, ukjente gyldighetstekster og feil. Tar 10–60 sekunder.",
      inputSchema: { place: placeSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ place }) => {
      try {
        return json(await runAudit(place));
      } catch (e) {
        return fail(e);
      }
    }
  );

  registerQuizTools(server);
  return server;
}

// Kontroll: henter detaljsiden for alle barer og sammenligner med lista. Resultatet caches i 30 min.
const auditCache = new Map();
export async function runAudit(place) {
  const key = place || DEFAULT_PLACE;
  const hit = auditCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  const d = await getList(key);
  const res = await mapLimit(d.bars, 8, (b) => getBarDetail(b.slug));
  const multi = [];
  const missed = [];
  const failed = [];
  const unparsed = new Map();
  const counts = {};
  d.bars.forEach((b, i) => {
    const r = res[i];
    if (!r.ok) return failed.push({ name: b.name, slug: b.slug, error: r.error });
    const prices = r.value.prices || [];
    counts[prices.length] = (counts[prices.length] || 0) + 1;
    for (const p of prices) {
      const v = parseValidityText(p.valid);
      if (!v.parsed) unparsed.set(p.valid, (unparsed.get(p.valid) || 0) + 1);
    }
    if (prices.length > 1) {
      const entry = {
        name: b.name,
        list_shows: 1,
        bar_page_has: prices.length,
        prices: prices.map((p) => `${p.price} kr – ${p.valid}`),
      };
      multi.push(entry);
      if (!needsDetail(b)) missed.push(entry);
    }
  });
  const data = {
    location: d.location_name,
    checked_at: new Date().toISOString(),
    bars_checked: d.bars.length,
    price_count_distribution: counts,
    bars_with_multiple_prices: multi.length,
    not_caught_by_quick_check: missed,
    unparsed_validity_texts: [...unparsed].map(([text, n]) => ({ text, count: n })),
    fetch_errors: failed,
    bars: multi,
  };
  auditCache.set(key, { at: Date.now(), data });
  return data;
}

// Eget endepunkt med bare quiz-verktøyene (/quiz/mcp).
export function createQuizServer() {
  const server = new McpServer(
    { name: "pubquiz", version: "1.0.0" },
    {
      instructions:
        "Pubquizer fra Norges Quizforbund (standard Oslo). Bruk find_quizzes med when ('i dag', 'tirsdag', dato). Quizer med happens=null går annenhver uke/månedlig – be brukeren sjekke lenken. beer viser pilspris på stedet ved quiz-start fra Pilsguiden.",
    }
  );
  registerQuizTools(server);
  return server;
}
