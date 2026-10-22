# pilsguiden-mcp

MCP-server som gir Claude (og andre MCP-klienter) tilgang til ølprisene på [pilsguiden.no](https://www.pilsguiden.no/liste/oslo). Data hentes live fra siden og caches i 5 minutter.

## Verktøy

| Verktøy | Hva det gjør |
|---|---|
| `cheap_beer_now` | «Hvor er det billig pils?» Én rad per bar med billigste pris + `other_prices`. Uten `when` er happy hour med (merket «15–21, man–lør»); med `when` (nå, 18, «søndag 18») og `day` brukes prisen som faktisk gjelder da. Sortert på glasspris. |
| `list_bars` | Hele listen med filter: makspris, bryggeri, fritekst (gate/navn), kun ordinære priser, sortering. |
| `find_bar` | Slå opp én bar på navn. `prices` gir alle priser (vanlig + happy hour) med tidsvindu og ukedager. |
| `get_price_stats` | Median/snitt for stedet sammenlignet med Norge. |
| `audit_prices` | Vedlikehold: sjekker alle barer mot detaljsiden og rapporterer barer med flere priser og ukjente gyldighetstekster. Også som `GET /audit?place=oslo`. |
| `list_areas` | Bydeler med slug, f.eks. `oslo/grunerlokka`. |

Alle tar `place` (standard `oslo`). Prisene er per halvliter.

## Kjør lokalt

```bash
npm install
npm start            # HTTP på http://localhost:3000/mcp
npm run stdio        # stdio for Claude Desktop / Claude Code
```

## Host live

**Render (gratis):** push til GitHub → New → Blueprint → velg repoet (bruker `render.yaml`). Endepunkt: `https://<navn>.onrender.com/mcp`.

**Fly.io / Railway / Cloud Run:** bruk `Dockerfile` (lytter på `$PORT`).

```bash
fly launch --now          # eller
gcloud run deploy pilsguiden-mcp --source . --allow-unauthenticated
```

### Miljøvariabler

| Variabel | Standard | |
|---|---|---|
| `PORT` | 3000 | |
| `MCP_AUTH_TOKEN` | – | Hvis satt kreves `Authorization: Bearer <token>` |
| `CACHE_TTL_SECONDS` | 300 | Cache mot pilsguiden.no |
| `DEFAULT_PLACE` | oslo | |

## Koble til Claude

Claude.ai / mobilappen: **Innstillinger → Connectors → Add custom connector** → lim inn `https://<din-host>/mcp`. (Bruk uten `MCP_AUTH_TOKEN` her – custom connectors støtter OAuth, ikke statiske tokens.)

Claude Code:
```bash
claude mcp add --transport http pilsguiden https://<din-host>/mcp
```

Claude Desktop (lokalt, stdio):
```json
{ "mcpServers": { "pilsguiden": { "command": "node", "args": ["/sti/til/pilsguiden-mcp/src/stdio.js"] } } }
```

## Hvordan prisene hentes

Lista (`/liste/<sted>/__data.json`) viser bare prisen som gjelder i øyeblikket den hentes. Alle priser ligger på `/bar/<slug>/__data.json`, med gyldighet som fritekst («Gyldig mellom 15:00 og 21:00, mandag - lørdag»), som `src/prices.js` tolker. Detaljsidene hentes for barer som kan ha flere priser og caches i 6 timer (`DETAIL_CACHE_TTL_SECONDS`).

## Test uten nett

```bash
npm test
```

Eller manuelt:

```bash
node test/mock-pilsguiden.mjs &
PILSGUIDEN_BASE_URL=http://localhost:4010 npm start
```

## Merk

Serveren leser SvelteKit-dataendepunktet `/liste/<sted>/__data.json`. Det er ikke et offisielt API og kan endres. Dataene tilhører Pilz-gruppen – vurder å spørre dem før offentlig bruk, og støtt gjerne siden (Vipps #965991).
