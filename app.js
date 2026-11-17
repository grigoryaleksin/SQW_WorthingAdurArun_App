"use strict";

const DEFAULT_LAD_NAME = "Worthing";

const BASE_STYLE = { weight: 1, color: "#555555", fillColor: "#4C9BE8", fillOpacity: 0.4 };
const HOVER_STYLE = { weight: 3, color: "#000000" };
const SELECTED_STYLE = { weight: 4, color: "#ff7f0e", fillColor: "#ff7f0e", fillOpacity: 0.5 };
const LAD_STYLE = { color: "#d62728", weight: 3, fill: false };

let ladList, lsoaGeo, ladGeo, lsoaPopByCode, ladPopByCode;
let map, lsoaLayer = null, ladLayer = null, selectedLayer = null, chart = null;
let currentLadCode = null;

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

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
function ladName(code) {
  const lad = ladList.find((l) => l.LAD23CD === code);
  return lad ? lad.LAD23NM : code;
}

function showLadTotal() {
  if (selectedLayer) {
    selectedLayer.setStyle(BASE_STYLE);
    selectedLayer = null;
  }
  drawChart(`Total population: ${ladName(currentLadCode)}`, ladPopByCode.get(currentLadCode));
}

function selectLsoa(layer, code) {
  if (selectedLayer) selectedLayer.setStyle(BASE_STYLE);
  selectedLayer = layer;
  layer.setStyle(SELECTED_STYLE);
  layer.bringToFront();
  if (ladLayer) ladLayer.bringToFront();
  drawChart(`Population: ${code}`, lsoaPopByCode.get(code));
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
function loadLad(code) {
  currentLadCode = code;
  selectedLayer = null;
  if (lsoaLayer) map.removeLayer(lsoaLayer);
  if (ladLayer) map.removeLayer(ladLayer);

  lsoaLayer = L.geoJSON(lsoaGeo, {
    filter: (f) => f.properties.LAD23CD === code,
    style: () => BASE_STYLE,
    onEachFeature: (feature, layer) => {
      const lsoaCode = feature.properties.LSOA21CD;
      layer.bindTooltip(lsoaCode, { sticky: true });
      layer.on({
        mouseover: () => {
          if (layer !== selectedLayer) {
            layer.setStyle(HOVER_STYLE);
            layer.bringToFront();
            if (ladLayer) ladLayer.bringToFront();
          }
        },
        mouseout: () => {
          if (layer !== selectedLayer) layer.setStyle(BASE_STYLE);
        },
        click: () => selectLsoa(layer, lsoaCode),
      });
    },
  }).addTo(map);

  ladLayer = L.geoJSON(ladGeo, {
    filter: (f) => f.properties.LAD23CD === code,
    style: () => LAD_STYLE,
    interactive: false,
  }).addTo(map);

  map.fitBounds(lsoaLayer.getBounds());
  showLadTotal();
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------
async function init() {
  try {
    const [list, lad, lsoa, lsoaPop, ladPop] = await Promise.all([
      loadJSON("data/lad_list.json"),
      loadJSON("data/lad.geojson"),
      loadJSON("data/lsoa.geojson"),
      loadJSON("data/lsoa_pop.json"),
      loadJSON("data/lad_pop.json"),
    ]);

    ladList = list.sort((a, b) => a.LAD23NM.localeCompare(b.LAD23NM));
    ladGeo = lad;
    lsoaGeo = lsoa;
    lsoaPopByCode = groupByKey(lsoaPop, "LSOA21CD");
    ladPopByCode = groupByKey(ladPop, "LAD23CD");

    map = L.map("map");
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
      maxZoom: 19,
    }).addTo(map);

    const select = el("lad");
    for (const l of ladList) {
      const opt = document.createElement("option");
      opt.value = l.LAD23CD;
      opt.textContent = l.LAD23NM;
      select.appendChild(opt);
    }

    const def = ladList.find((l) => l.LAD23NM === DEFAULT_LAD_NAME) || ladList[0];
    select.value = def.LAD23CD;

    select.addEventListener("change", () => loadLad(select.value));
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