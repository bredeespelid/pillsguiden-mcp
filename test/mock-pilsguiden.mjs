// Lokal kopi av pilsguiden.no for testing (liste + detaljsider), med data slik de så ut 22.10.2026.
// Kjør: node test/mock-pilsguiden.mjs  →  PILSGUIDEN_BASE_URL=http://localhost:4010 npm start
import http from "node:http";
import { stringify } from "devalue";

// [id, navn, adresse, bryggeri, størrelse, [[pris, pint, sjekket, gyldig, aktiv], ...]]
const BARS = [
  [1689, "Doug's Hamburgers Aker Brygge", "Fjordalléen 4, 0250 Oslo", "Budweiser", 0.5, [[55, 55, "2026-10-16T17:16:19+02:00", "Prisen er alltid gyldig", true]]],
  // Lista viser "Prisen er alltid gyldig" selv om baren har en tirsdagspris (slik nettsiden faktisk gjør).
  [1705, "Phuket Restaurant Oslo", "Herslebs gate 4a, 0561 Oslo", "Ringnes", 0.5, [
    [56, 56, "2026-10-19T20:56:34+02:00", "Gyldig når ingen annen pris gjelder", true, "Prisen er alltid gyldig"],
    [49, 49, "2026-10-14T19:00:00+02:00", "Gyldig hele åpningstiden, tirsdag", false],
  ]],
  [434, "Döner Bros", "Osterhaus' gate 12, 0183 Oslo", "Nordlands Pils", 0.4, [[54, 68, "2026-04-23T19:00:50+02:00", "Prisen er alltid gyldig", true]]],
  [1792, "SIP Oslo", "Storgata 13, 0155 Oslo", "Hansa", 0.4, [
    [68, 85, "2026-10-09T23:40:45+02:00", "Gyldig når ingen annen pris gjelder", true],
    [49, 61, "2026-10-17T23:50:23+02:00", "Gyldig mellom 15:00 og 21:00, mandag - lørdag", false],
  ]],
  [1537, "Destiny Pub Oslo", "Bernt Ankers gate 37, 0179 Oslo", "1489", 0.5, [
    [79, 79, "2026-10-15T18:53:30+02:00", "Gyldig når ingen annen pris gjelder", true],
    [59, 59, "2026-10-09T12:45:54+02:00", "Gyldig mellom 16:00 og 21:00, Alle dager", false],
  ]],
  [1082, "Bar Royal", "Hausmanns gate 8B, 0182 Oslo", "Ringnes", 0.5, [
    [69, 69, "2026-09-11T18:34:46+02:00", "Gyldig når ingen annen pris gjelder", false],
    [59, 59, "2026-07-11T12:47:34+02:00", "Gyldig før kl 15:00, Alle dager", true],
  ]],
  [656, "Cafe Stolen", "Helgesens gate 32, 0553 Oslo", "Hansa", 0.5, [
    [83, 83, "2026-05-26T21:03:08+02:00", "Gyldig når ingen annen pris gjelder", true],
    [75, 75, "2026-09-16T17:57:23+02:00", "Gyldig hele åpningstiden, onsdag", false],
  ]],
  [701, "The Old Irish Pub - Majorstuen", "Kirkeveien 64a, 0364 Oslo", "Carlsberg", 0.4, [
    [109, 136, "2026-10-02T18:34:29+02:00", "Gyldig når ingen annen pris gjelder", true],
    [49, 61, "2026-10-04T20:07:15+02:00", "Gyldig mellom 20:00 og 23:00, Alle dager", false],
  ]],
];

const slug = (n) => n.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const LIST_TEXT = { "Gyldig når ingen annen pris gjelder": "Prisen gjelder utenom happy hour" };

// Lista viser kun den aktive prisen (slik nettsiden gjør).
const list = {
  location_id: 1,
  stats: { location_name: "Oslo", mean: 119, median: 120, count: 589, parent_id: 1954, parent_name: "Norge", parent_count: 1622, parent_mean: 123, parent_median: 124 },
  bars: BARS.map(([id, name, address, brewery, size, prices]) => {
    const [price, pint, checked, valid, , listText] = prices.find((p) => p[4]);
    const isDefault = /alltid|ingen annen/.test(valid);
    return { id, name, address, slug: slug(name), location: 25, brewery, size, price, pint, price_checked: checked, valid_to: listText || LIST_TEXT[valid] || valid, default_price: isDefault, NextLoc: { id: 0, name: "", slug: "" } };
  }),
  links: [{ id: 2, name: "Grünerløkka", slug: "grunerlokka" }, { id: 3, name: "Sentrum", slug: "sentrum" }],
  breadcrumb: [{ name: "Oslo", slug: "oslo" }],
};

const node = (v) => ({ type: "data", data: JSON.parse(stringify(v)), uses: {} });
const layout = node({ admin: false, consent: false });
const listBody = JSON.stringify({ type: "data", nodes: [layout, node({ list })] });
const details = new Map(
  BARS.map(([id, name, address, brewery, size, prices], i) => [
    slug(name),
    JSON.stringify({
      type: "data",
      nodes: [
        layout,
        node({
          barObj: {
            id, slug: slug(name), name, address, orgnummer: "", osm_id: "", linked_bar: false, location: 25,
            latitude: 59.9, longitude: 10.7, drink_id: 1, size, brewery_id: 2, brewery,
            prices: prices.map(([price, pint, price_checked, valid, active], j) => ({ id: id * 10 + j, price, pint, price_checked, valid, active })),
          },
        }),
      ],
    }),
  ])
);


// ---- Norges Quizforbund (WordPress) ----
const qrow = (city, venue, href, day, time, type) =>
  `<tr style="height: 20px;"><td>&nbsp;</td><td>${city}</td><td>${href ? `<a class="broken_link" href="${href}">${venue}</a>` : venue}</td><td>${day}</td><td>${time}</td><td>${type}</td></tr>`;
const qhead = (r) => `<tr style="height: 20px;"><td colspan="6" style="font-weight: bold;">${r}</td></tr>`;
const QUIZ_HTML = `<p>Finn din pubquiz</p><table id="pubquiz-table"><tbody>
${qhead("Akershus")}
${qrow("Lillestrøm", "Puben på hjørnet", "", "Tirsdag", "19:00", "Allmenn")}
${qhead("Oslo")}
${qrow("Oslo", "Fru Burums", "http://fruburums.no/", "Mandag", "19:00", "Allmenn")}
${qrow("Oslo", "Røverstaden", "https://www.facebook.com/roverstaden/", "Mandag (annenhver)", "19:00", "«Fakta om makta» – Samfunn og politikk")}
${qrow("Oslo", "Proud Mary", "", "Mandag (Søndag)", "19:00", "The Office (1. mandag i måneden)")}
${qrow("Oslo", "Bar Royal", "", "Tirsdag", "19:00", "Allmenn")}
${qrow("Oslo", "Rabalder Bar Løkka", "https://www.instagram.com/rabalderbaroslo/", "Tirsdag", "18:00", "Allmenn")}
${qrow("Oslo", "Glasset", "", "Tirsdag (annenhver, oddetallsuker)", "19:00", "Allmenn")}
${qrow("Oslo", "Cultivate Food, Grünerløkka", "https://cultivatefood.no/quiz-night/", "1. tirsdag hver måned", "19:00", "Sjekk programmet")}
${qrow("Oslo", "Vika Kino", "", "Tirsdag (siste tirsdag hver måned)", "19:00", "Film")}
${qrow("Oslo", "Saskia", "", "Tirsdag (første i måneden)", "19:00", "Allmenn og musikk")}
${qrow("Oslo", "SALT", "https://www.salted.no/quiz-paa-salt", "Tirsdag (utvalgte)", "19:00", "Popquiz")}
${qrow("Oslo", "Kjøkken og Bar", "", "Oslo", "18:00", "Allmenn")}
${qrow("Oslo", "Café Marienlyst («Hullet i veggen», Kirkeveien 104)", "https://www.facebook.com/p/Cafe-Marienlyst/", "Mandag", "18:30", "Allmenn")}
${qrow("Oslo", "Destiny Pub", "", "Torsdag", "18:00", "Musikk")}
${qrow("Oslo", "SIP", "", "Torsdag", "20:30", "Allmenn")}
${qrow("Oslo", "Kulturhuset", "", "En torsdag i måneden (varierer)", "19:00", "IconaPopQuiz")}
${qrow("Oslo", "Victor's Lounge", "", "TIrsdag", "?", "Allmenn")}
${qhead("Vestland")}
${qrow("Bergen", "Bergen Quizbar", "", "Torsdag", "20:00", "Allmenn")}
</tbody></table>`;
const quizBody = JSON.stringify([{ id: 109, modified: "2026-09-29T22:29:24", content: { rendered: QUIZ_HTML, protected: false } }]);

export const requests = [];
http
  .createServer((q, r) => {
    requests.push(q.url);
    r.setHeader("content-type", "application/json");
    const m = q.url.match(/^\/bar\/([^/]+)\/__data\.json/);
    if (q.url.startsWith("/liste/oslo")) return r.end(listBody);
    if (q.url.startsWith("/wp-json/wp/v2/pages")) return r.end(quizBody);
    if (m && details.has(m[1])) return r.end(details.get(m[1]));
    if (m) return r.end(JSON.stringify({ type: "data", nodes: [layout, { type: "error", error: { message: "Internal Error" } }] }));
    r.statusCode = 404;
    r.end("{}");
  })
  .listen(Number(process.env.MOCK_PORT || 4010));
