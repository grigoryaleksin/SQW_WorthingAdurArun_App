"use strict";

const DEFAULT_LAD_NAME = "Worthing";

const BASE_STYLE = { weight: 1, color: "#555555", fillColor: "#4C9BE8", fillOpacity: 0.4 };
const TOWN_STYLE = { weight: 1.5, color: "#1b6e42", fillColor: "#2ca25f", fillOpacity: 0.6 };
const HOVER_STYLE = { weight: 3, color: "#000000" };
const SELECTED_STYLE = { weight: 4, color: "#ff7f0e", fillColor: "#ff7f0e", fillOpacity: 0.5 };
const LAD_STYLE = { color: "#d62728", weight: 3, fill: false };

// CARTO's free basemaps now need an API key, or they show an "API KEY REQUIRED"
// watermark. Optional: request a free key at https://www.carto.com/basemaps/apikey/
// and paste it between the quotes to add the CARTO basemaps. Leave it empty to
// use only the key-free basemaps (Esri light grey, OpenStreetMap).
const CARTO_KEY = "";

const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const CARTO_ATTR = OSM_ATTR + ' &copy; <a href="https://carto.com/attributions">CARTO</a>';
const ESRI_ATTR = "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ";

let ladList, lsoaGeo, ladGeo, lsoaPopByCode, ladPopByCode;
let townInfo = new Map();   // LSOA code -> { lad, town }
let townsByLad = new Map(); // LAD code  -> sorted list of town names
let map, lsoaLayer = null, ladLayer = null, selectedLayer = null, chart = null;
let currentLadCode = null;
let currentTown = null;

const el = (id) => document.getElementById(id);

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  return res.json();
}

function groupByKey(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row[key])) groups.set(row[key], []);
    groups.get(row[key]).push(row);
  }
  for (const series of groups.values()) series.sort((a, b) => a.year - b.year);
  return groups;
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------
function drawChart(title, rows) {
  const valid = (rows || []).filter((r) => r.population !== null);
  const labels = valid.map((r) => r.year);
  const values = valid.map((r) => r.population);
  const heading = valid.length ? title : "No population data found for this selection";

  if (!chart) {
    chart = new Chart(el("chart"), {
      type: "line",
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: "#1f77b4",
          backgroundColor: "#1f77b4",
          borderWidth: 2,
          pointRadius: 4,
          tension: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          title: { display: true, text: heading, font: { size: 16 } },
          tooltip: {
            callbacks: { label: (ctx) => ctx.parsed.y.toLocaleString("en-GB") },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            title: { display: true, text: "Population" },
            ticks: { callback: (v) => v.toLocaleString("en-GB") },
          },
        },
      },
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets[0].data = values;
    chart.options.plugins.title.text = heading;
    chart.update();
  }
}

// Sum the LSOA series for every LSOA in a town (in the current LAD)
function townSeries(town) {
  const totals = new Map();
  for (const [code, info] of townInfo) {
    if (info.lad !== currentLadCode || info.town !== town) continue;
    for (const r of lsoaPopByCode.get(code) || []) {
      if (r.population === null) continue;
      totals.set(r.year, (totals.get(r.year) || 0) + r.population);
    }
  }
  return [...totals]
    .sort((a, b) => a[0] - b[0])
    .map(([year, population]) => ({ year, population }));
}

function ladName(code) {
  const lad = ladList.find((l) => l.LAD23CD === code);
  return lad ? lad.LAD23NM : code;
}

// Chart whatever is currently selected: an LSOA, else a town, else the whole LAD
function updateChart() {
  if (selectedLayer) {
    const code = selectedLayer.feature.properties.LSOA21CD;
    drawChart(`Population: ${code}`, lsoaPopByCode.get(code));
  } else if (currentTown) {
    drawChart(`Town total (approximate area): ${currentTown}`, townSeries(currentTown));
  } else {
    drawChart(`Total population: ${ladName(currentLadCode)}`, ladPopByCode.get(currentLadCode));
  }
}

// ---------------------------------------------------------------------------
// Styling and selection
// ---------------------------------------------------------------------------
function styleFor(layer) {
  if (layer === selectedLayer) return SELECTED_STYLE;
  const info = townInfo.get(layer.feature.properties.LSOA21CD);
  if (currentTown && info && info.town === currentTown) return TOWN_STYLE;
  return BASE_STYLE;
}

function restyleAll() {
  if (lsoaLayer) lsoaLayer.eachLayer((l) => l.setStyle(styleFor(l)));
}

function deselectLsoa() {
  const prev = selectedLayer;
  selectedLayer = null;
  if (prev) prev.setStyle(styleFor(prev));
}

function selectLsoa(layer) {
  const prev = selectedLayer;
  selectedLayer = layer;
  if (prev) prev.setStyle(styleFor(prev));
  layer.setStyle(SELECTED_STYLE);
  updateChart();
}

function showLadTotal() {
  deselectLsoa();
  currentTown = null;
  el("town").value = "";
  restyleAll();
  updateChart();
}

function onTownChange() {
  deselectLsoa();
  currentTown = el("town").value || null;
  restyleAll();
  updateChart();
}

function populateTowns(ladCode) {
  const select = el("town");
  select.innerHTML = "";
  const towns = townsByLad.get(ladCode) || [];
  el("town-row").hidden = towns.length === 0;
  if (!towns.length) return;
  select.add(new Option("— None —", ""));
  for (const t of towns) select.add(new Option(t, t));
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
function loadLad(code) {
  currentLadCode = code;
  currentTown = null;
  selectedLayer = null;
  if (lsoaLayer) map.removeLayer(lsoaLayer);
  if (ladLayer) map.removeLayer(ladLayer);
  populateTowns(code);

  lsoaLayer = L.geoJSON(lsoaGeo, {
    filter: (f) => f.properties.LAD23CD === code,
    style: () => BASE_STYLE,
    onEachFeature: (feature, layer) => {
      const lsoaCode = feature.properties.LSOA21CD;
      const info = townInfo.get(lsoaCode);
      layer.bindTooltip(info ? `${lsoaCode} · ${info.town}` : lsoaCode, { sticky: true });
      layer.on({
        mouseover: () => {
          // Don't call bringToFront() here: re-ordering the SVG element under the
          // cursor makes the browser lose mouseout/click events.
          if (layer !== selectedLayer) layer.setStyle(HOVER_STYLE);
        },
        mouseout: () => {
          if (layer !== selectedLayer) layer.setStyle(styleFor(layer));
        },
        click: () => selectLsoa(layer),
      });
    },
  }).addTo(map);

  ladLayer = L.geoJSON(ladGeo, {
    filter: (f) => f.properties.LAD23CD === code,
    style: () => LAD_STYLE,
    interactive: false,
  }).addTo(map);

  map.fitBounds(lsoaLayer.getBounds());
  updateChart();
}

function setupMap() {
  // Small, unobtrusive credit (kept: CARTO / OpenStreetMap require attribution)
  map = L.map("map", { attributionControl: false });
  L.control.attribution({ prefix: false }).addTo(map);

  // The first basemap listed is the one shown by default
  const basemaps = {};

  if (CARTO_KEY) {
    const carto = (path) =>
      L.tileLayer(`https://basemaps.cartocdn.com/${path}/{z}/{x}/{y}.png?key=${CARTO_KEY}`, {
        attribution: CARTO_ATTR,
        maxZoom: 19,
      });
    basemaps["Light (CARTO)"] = carto("light_all");
    basemaps["Light, no labels (CARTO)"] = carto("light_nolabels");
    basemaps["Colour (CARTO)"] = carto("rastertiles/voyager");
  }

  basemaps["Light grey (Esri)"] = L.tileLayer(
    "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    { attribution: ESRI_ATTR, maxNativeZoom: 16, maxZoom: 19 }
  );
  basemaps["Streets (OpenStreetMap)"] = L.tileLayer(
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    { attribution: OSM_ATTR, maxZoom: 19 }
  );

  Object.values(basemaps)[0].addTo(map);
  L.control.layers(basemaps, null, { position: "topright" }).addTo(map);
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------
async function init() {
  try {
    const [list, lad, lsoa, lsoaPop, ladPop, towns] = await Promise.all([
      loadJSON("data/lad_list.json"),
      loadJSON("data/lad.geojson"),
      loadJSON("data/lsoa.geojson"),
      loadJSON("data/lsoa_pop.json"),
      loadJSON("data/lad_pop.json"),
      loadJSON("data/towns.json").catch(() => []), // optional
    ]);

    ladList = list.sort((a, b) => a.LAD23NM.localeCompare(b.LAD23NM));
    ladGeo = lad;
    lsoaGeo = lsoa;
    lsoaPopByCode = groupByKey(lsoaPop, "LSOA21CD");
    ladPopByCode = groupByKey(ladPop, "LAD23CD");

    for (const t of towns) {
      townInfo.set(t.LSOA21CD, { lad: t.LAD23CD, town: t.town });
      if (!townsByLad.has(t.LAD23CD)) townsByLad.set(t.LAD23CD, new Set());
      townsByLad.get(t.LAD23CD).add(t.town);
    }
    for (const [k, v] of townsByLad) townsByLad.set(k, [...v].sort((a, b) => a.localeCompare(b)));

    setupMap();

    const select = el("lad");
    for (const l of ladList) {
      select.add(new Option(l.LAD23NM, l.LAD23CD));
    }

    const def = ladList.find((l) => l.LAD23NM === DEFAULT_LAD_NAME) || ladList[0];
    select.value = def.LAD23CD;

    select.addEventListener("change", () => loadLad(select.value));
    el("town").addEventListener("change", onTownChange);
    el("clear").addEventListener("click", showLadTotal);

    loadLad(def.LAD23CD);
  } catch (err) {
    console.error(err);
    el("status").textContent =
      "Failed to load data: " + err.message +
      ". If you opened index.html directly, serve the folder with a local web server instead.";
  }
}

init();
