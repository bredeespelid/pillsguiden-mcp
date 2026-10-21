// MCP-server for Pilsguiden – ølpriser i Norge.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getList, filterBars, osloNow, parseValidity, validAt, ageDays } from "./pilsguiden.js";

const DEFAULT_PLACE = process.env.DEFAULT_PLACE || "oslo";

const placeSchema = z
  .string()
  .optional()
  .describe(
    `Sted som sti under /liste/, f.eks. 'oslo', 'oslo/grunerlokka', 'bergen'. Standard: '${DEFAULT_PLACE}'. Bruk list_areas for gyldige bydeler.`
  );

const json = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (err) => ({ isError: true, content: [{ type: "text", text: String(err?.message || err) }] });

export function createServer() {
  const server = new McpServer(
    { name: "pilsguiden", version: "1.1.0" },
    {
      instructions:
        "Ølpriser fra pilsguiden.no. Når brukeren spør hvor det er billig pils uten å si når de skal ut, spør først om tidspunktet (nå, etter jobb, kl 22 …) – mange av de billigste prisene er happy hour som slutter kl 19–23. Bruk så cheap_beer_now med 'when'. Oppgi både glasspris med størrelse og pris per halvliter.",
    }
  );

  server.registerTool(
    "list_bars",
    {
      title: "Ølpriser – liste",
      description:
        "Henter barer/utesteder med pilspris fra pilsguiden.no for et sted (standard Oslo). Prisene er normalisert per halvliter. Kan filtreres og sorteres.",
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
        return json({
          location: data.location_name,
          source: data.url,
          median_price: data.stats.median,
          matches: total,
          returned: bars.length,
          bars,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "cheap_beer_now",
    {
      title: "Billig pils nå / i kveld",
      description:
        "Svarer på 'hvor bør jeg dra for billig pils?'. Rangeringen avhenger sterkt av klokkeslett, fordi mange av de billigste prisene er happy hour som bare gjelder til f.eks. kl 19, 21 eller 23. " +
        "VIKTIG: Hvis brukeren ikke har sagt NÅR de skal ut (f.eks. 'nå', 'kl 18', 'etter jobb', 'i kveld kl 22'), SPØR brukeren om tidspunkt før du kaller verktøyet – ikke gjett. " +
        "Svar med både glasspris og størrelse (price + size_liters) og halvliterpris, og nevn når happy hour slutter.",
      inputSchema: {
        place: placeSchema,
        when: z
          .union([z.string(), z.number()])
          .describe(
            "Når brukeren skal ut, Oslo-tid: 'nå' eller klokkeslett som '18', '18:30', '21.5'. Påkrevd – spør brukeren hvis det ikke er oppgitt."
          ),
        sort_by: z
          .enum(["half_liter", "glass"])
          .optional()
          .describe("'half_liter' (standard, rettferdig sammenligning) eller 'glass' (billigste glass uansett størrelse)"),
        max_price: z.number().optional().describe("Maks pris per halvliter (NOK)"),
        max_age_days: z
          .number()
          .int()
          .optional()
          .describe("Ignorer priser sjekket for mer enn så mange dager siden (standard 365)"),
        limit: z.number().int().min(1).max(50).optional().describe("Antall forslag (standard 10)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ place, when, sort_by, max_price, max_age_days, limit }) => {
      try {
        const now = osloNow();
        const w = String(when || "").trim().toLowerCase();
        let hour;
        if (!w || w === "nå" || w === "na" || w === "now") hour = now.hour + now.minute / 60;
        else {
          const m = w.match(/(\d{1,2})(?:[:.,](\d{1,2}))?/);
          if (!m) return fail("Forstod ikke tidspunktet. Bruk 'nå' eller f.eks. '18', '18:30'.");
          const h = Number(m[1]);
          const frac = m[2] ? (w.includes(":") || m[2].length === 2 ? Number(m[2]) / 60 : Number("0." + m[2])) : 0;
          hour = h + frac;
        }
        const at_hour = !w || w === "nå" || w === "na" || w === "now" ? null : hour;
        const d = await getList(place || DEFAULT_PLACE);
        const maxAge = max_age_days ?? 365;
        const candidates = d.bars
          .filter((b) => b.price_per_half_liter != null)
          .filter((b) => validAt(b, hour))
          .map((b) => ({ ...b, price_age_days: ageDays(b), valid_until: parseValidity(b.validity).until_hour ?? null }))
          .filter((b) => b.price_age_days == null || b.price_age_days <= maxAge)
          .filter((b) => max_price == null || b.price_per_half_liter <= max_price)
          .sort((a, b) => {
            const key = sort_by === "glass" ? "price" : "price_per_half_liter";
            return (a[key] ?? 1e9) - (b[key] ?? 1e9) || (a.price_age_days ?? 999) - (b.price_age_days ?? 999);
          });
        const cheapestGlass = candidates.reduce((m, b) => (b.price != null && (!m || b.price < m.price) ? b : m), null);
        const picks = candidates.slice(0, limit ?? 10).map((b) => ({
          name: b.name,
          price_per_half_liter: b.price_per_half_liter,
          price: b.price,
          size_liters: b.size_liters,
          brewery: b.brewery,
          address: b.address,
          validity: b.validity,
          happy_hour: b.time_limited,
          valid_until_hour: b.valid_until,
          price_checked: b.price_checked,
          price_age_days: b.price_age_days,
        }));
        return json({
          location: d.location_name,
          source: d.url,
          evaluated_for: at_hour != null ? `kl ${String(Math.floor(hour)).padStart(2, "0")}:${String(Math.round((hour % 1) * 60)).padStart(2, "0")}` : now.label,
          sorted_by: sort_by === "glass" ? "glasspris" : "pris per halvliter",
          median_price: d.stats.median,
          cheapest_glass: cheapestGlass && {
            name: cheapestGlass.name,
            price: cheapestGlass.price,
            size_liters: cheapestGlass.size_liters,
            price_per_half_liter: cheapestGlass.price_per_half_liter,
            valid_until_hour: cheapestGlass.valid_until,
          },
          note:
            "price = det du betaler for glasset (size_liters). price_per_half_liter = omregnet til 0,5 l for rettferdig sammenligning. Nevn begge når glasset ikke er 0,5 l. Happy hour-priser er kun med hvis de gjelder på valgt tidspunkt. Prisene er brukerrapporterte.",
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
          difference_from_parent:
            s.median != null && s.parent_median != null ? s.median - s.parent_median : null,
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
        const p = place || DEFAULT_PLACE;
        const d = await getList(p);
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
      description: "Søk etter en bestemt bar på navn og få pris, bryggeri, adresse og når prisen sist ble sjekket.",
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
        return json({ location: d.location_name, matches: total, bars });
      } catch (e) {
        return fail(e);
      }
    }
  );

  return server;
}
