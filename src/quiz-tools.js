// MCP-verktøy for pubquiz, med pilspris fra Pilsguiden på stedet der det finnes.
import { z } from "zod";
import { getQuizzes, resolveDate, occursOn, publicQuiz, DAY_NB, QUIZ_PAGE } from "./quiz.js";
import { getList } from "./pilsguiden.js";
import { withAllPrices, applicablePrices } from "./prices.js";

const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (err) => ({ isError: true, content: [{ type: "text", text: String(err?.message || err) }] });

const fold = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/å/g, "a")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const STOP = new Set(["oslo", "the", "og", "and", "bar", "pub", "puben", "restaurant", "restaurang", "cafe", "kafe", "kafeen", "scene", "gastropub", "sportsbar", "sports", "irish", "public", "house", "avd", "kjokken", "spiseri", "music", "live"]);
const tokens = (s) =>
  fold(s)
    .replace(/['’`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));

// Finn Pilsguiden-bar med samme navn. Alle "viktige" ord i det korteste navnet må finnes i det andre.
export function matchBar(quizName, bars) {
  const q = tokens(quizName);
  if (!q.length) return null;
  const shortOnly = !q.some((t) => t.length >= 4); // f.eks. "SIP", "200": krev identiske navn
  let best = null;
  for (const b of bars) {
    const t = tokens(b.name);
    if (!t.length) continue;
    if (shortOnly && (t.length !== q.length || !q.every((x) => t.includes(x)))) continue;
    const [small, big] = q.length <= t.length ? [q, new Set(t)] : [t, new Set(q)];
    if (!small.every((x) => big.has(x))) continue;
    const union = new Set([...q, ...t]).size;
    const score = small.length / union;
    if (!best || score > best.score) best = { bar: b, score, tie: false };
    else if (score === best.score) best.tie = true;
  }
  return best && !best.tie ? best.bar : null;
}

const hourOf = (time) => {
  const m = String(time || "").match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) + Number(m[2]) / 60 : 19;
};

export function registerQuizTools(server) {
  server.registerTool(
    "find_quizzes",
    {
      title: "Finn pubquiz",
      description:
        "Pubquizer fra Norges Quizforbund sin liste (standard: Oslo). Gir quizer en gitt dag ('i dag', 'i morgen', 'tirsdag', '2026-10-27') sortert på klokkeslett, med type (allmenn, musikk, film …), hyppighet og lenke. " +
        "`happens` er true/false/null: null betyr at quizen er annenhver uke eller månedlig uten fast mønster – be brukeren sjekke lenken. " +
        "Der stedet finnes på Pilsguiden følger `beer` med: pilsprisen som gjelder på quiz-tidspunktet (inkl. happy hour). Bruk when='alle' for å søke i alle quizer uansett dag.",
      inputSchema: {
        when: z
          .string()
          .optional()
          .describe("Dag: 'i dag' (standard), 'i morgen', ukedag ('tirsdag', 'neste fredag'), dato ('2026-10-27' / '27.10'), eller 'alle' for hele lista."),
        region: z.string().optional().describe("Fylke/område slik lista grupperer det, f.eks. 'Oslo', 'Akershus', 'Vestland'. Standard: Oslo. 'alle' = hele landet."),
        type: z.string().optional().describe("Filtrer på quiztype, f.eks. 'musikk', 'allmenn', 'film', 'sport', 'rock', 'nerd'"),
        query: z.string().optional().describe("Søk i stedsnavn/by, f.eks. 'Løkka', 'Torshov', 'O'Connors'"),
        after: z.string().optional().describe("Bare quizer som starter kl X eller senere, f.eks. '19' eller '18:30'"),
        before: z.string().optional().describe("Bare quizer som starter før kl X"),
        include_uncertain: z.boolean().optional().describe("Ta med quizer som kanskje går (annenhver uke/månedlig uten fast dato). Standard true."),
        sort_by: z.enum(["time", "beer_price"]).optional().describe("'time' (standard) eller 'beer_price' (billigste pils på quiz-tidspunktet først)"),
        with_beer: z.boolean().optional().describe("Slå opp pilspris på Pilsguiden (standard true)"),
        limit: z.number().int().min(1).max(200).optional().describe("Maks antall (standard 40)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ when, region, type, query, after, before, include_uncertain, sort_by, with_beer, limit }) => {
      try {
        const { quizzes, modified } = await getQuizzes();
        const all = fold(when || "").trim() === "alle" || fold(when || "").trim() === "all";
        const date = all ? null : resolveDate(when);
        const reg = fold(region || "Oslo");
        let list = quizzes.filter((q) => reg === "alle" || reg === "all" || fold(q.region).includes(reg) || fold(q.city).includes(reg));
        if (type) list = list.filter((q) => fold(q.type).includes(fold(type)));
        if (query) list = list.filter((q) => fold(`${q.venue} ${q.city}`).includes(fold(query)));
        if (after) list = list.filter((q) => q.time && hourOf(q.time) >= hourOf(after));
        if (before) list = list.filter((q) => q.time && hourOf(q.time) < hourOf(before));

        let rows = list.map((q) => ({ q, happens: date ? occursOn(q._sched, date) : null }));
        if (date) rows = rows.filter((r) => r.happens === true || (r.happens === null && include_uncertain !== false && r.q._sched.days.includes(date.dow)));

        // Pilspris på quiz-tidspunktet
        if (with_beer !== false && rows.length) {
          try {
            const pg = await getList("oslo");
            const matched = rows.map((r) => ({ r, bar: fold(r.q.region).includes("oslo") || fold(r.q.city).includes("oslo") ? matchBar(r.q.name, pg.bars) : null }));
            const uniq = [...new Set(matched.filter((m) => m.bar).map((m) => m.bar))];
            const enriched = new Map((await withAllPrices(uniq, { waitMs: 15000 })).map((b) => [b.slug, b]));
            for (const { r, bar } of matched) {
              if (!bar) continue;
              const b = enriched.get(bar.slug);
              const dow = date ? date.dow : r.q._sched.days[0] ?? 0;
              const pool = applicablePrices(b.prices, dow, hourOf(r.q.time));
              const p = [...pool].sort((x, y) => (x.price ?? 1e9) - (y.price ?? 1e9))[0];
              if (!p) continue;
              r.beer = {
                pilsguiden_name: b.name,
                pilsguiden_address: b.address,
                price: p.price,
                size_liters: p.size_liters,
                price_per_half_liter: p.price_per_half_liter,
                brewery: p.brewery,
                window: p.window,
                happy_hour: p.type === "time_limited",
                price_checked: p.price_checked,
              };
            }
          } catch (e) {
            rows.beer_error = String(e.message || e);
          }
        }

        const key = sort_by === "beer_price" ? (r) => r.beer?.price_per_half_liter ?? 1e9 : (r) => hourOf(r.q.time);
        rows.sort((a, b) => key(a) - key(b) || hourOf(a.q.time) - hourOf(b.q.time) || a.q.name.localeCompare(b.q.name, "nb"));
        const out = rows.slice(0, limit ?? 40).map((r) => ({
          ...publicQuiz(r.q),
          happens: date ? r.happens : undefined,
          ...(r.beer ? { beer: r.beer } : {}),
        }));
        return json({
          source: QUIZ_PAGE,
          list_updated: modified,
          date: date ? `${DAY_NB[date.dow]} ${date.iso}` : "alle dager",
          region: region || "Oslo",
          matches: rows.length,
          returned: out.length,
          note:
            "happens: true = går denne dagen, null = kanskje (annenhver uke / månedlig) – sjekk lenken. Lista vedlikeholdes av Norges Quizforbund og kan være utdatert. beer = pilspris på stedet ved quiz-start fra Pilsguiden (navnematch – nevn pilsguiden_name).",
          ...(rows.beer_error ? { beer_error: rows.beer_error } : {}),
          quizzes: out,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_quiz_regions",
    {
      title: "Quiz-områder",
      description: "Lister fylker/områder i quizlista med antall quizer og antall per ukedag.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const { quizzes, modified } = await getQuizzes();
        const regions = {};
        for (const q of quizzes) {
          const r = (regions[q.region] ||= { region: q.region, quizzes: 0, per_day: Object.fromEntries(DAY_NB.map((d) => [d, 0])) });
          r.quizzes++;
          for (const d of q.days) r.per_day[d]++;
        }
        return json({ source: QUIZ_PAGE, list_updated: modified, total: quizzes.length, regions: Object.values(regions) });
      } catch (e) {
        return fail(e);
      }
    }
  );
}
