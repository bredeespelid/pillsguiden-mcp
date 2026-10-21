# pilsguiden-mcp

MCP-server som gir Claude (og andre MCP-klienter) tilgang til ølprisene på [pilsguiden.no](https://www.pilsguiden.no/liste/oslo). Data hentes live fra siden og caches i 5 minutter.

## Verktøy

| Verktøy | Hva det gjør |
|---|---|
| `cheap_beer_now` | «Hvor er det billig pils?» Viser som standard de billigste prisene inkl. happy hour med sluttid, sortert på glasspris (det du betaler, `sort_by: half_liter` for omregnet pris). Med `when` (nå, 18, 21:30) filtreres det på tidspunkt. |
| `list_bars` | Hele listen med filter: makspris, bryggeri, fritekst (gate/navn), kun ordinære priser, sortering. |
| `find_bar` | Slå opp én bar på navn. |
| `get_price_stats` | Median/snitt for stedet sammenlignet med Norge. |
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

## Test uten nett

```bash
node test/mock-pilsguiden.mjs &
PILSGUIDEN_BASE_URL=http://localhost:4010 npm start
```

## Merk

Serveren leser SvelteKit-dataendepunktet `/liste/<sted>/__data.json`. Det er ikke et offisielt API og kan endres. Dataene tilhører Pilz-gruppen – vurder å spørre dem før offentlig bruk, og støtt gjerne siden (Vipps #965991).
