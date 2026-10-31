// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentLat = null;
let currentLon = null;
let batchFileList = [];
let markerLayer = null;
let selectedLocationMarker = null;
let lastDetectionContext = null;
let savedSets = [];
let activeSetId = null;
let nextSetNumber = 1;
let selectedMapResult = null;
let chatContextMode = "auto";
let pendingMessage = null;
let singleFile = null;
let boundaryMode = false;
let boundaryPoints = [];
let boundaryMarkers = [];

function isUncertain(result) {
  return result.inference_status === "uncertain";
}

function predictionSummary(result) {
  return (result.top_predictions || [])
    .map((item) => `${item.class} ${(item.score * 100).toFixed(1)}%`)
    .join(" · ");
}

function resultExplanation(result) {
  if (result.explanation) return result.explanation;
  const label = result.class || "selected class";
  return isUncertain(result)
    ? `Model ranked ${label} highest, but confidence is below the threshold. Result remains unconfirmed.`
    : `Model found strongest similarity to ${label} examples in its training data.`;
}

const downloadSummaryBtn = document.getElementById("download-summary-btn");
const exportFormatSelect = document.getElementById("export-format");
const setsTabs = document.getElementById("sets-tabs");
const setDetails = document.getElementById("set-details");
const clearSetsBtn = document.getElementById("clear-sets-btn");
const chatContextChoice = document.getElementById("chat-context-choice");
const contextTabBtn = document.getElementById("context-tab-btn");
const contextMapBtn = document.getElementById("context-map-btn");
const coordHint = document.getElementById("coord-hint");

const chatFab = document.getElementById("chat-fab");
const chatWindow = document.getElementById("chat-window");
const chatMinBtn = document.getElementById("chat-min-btn");
const chatCloseBtn = document.getElementById("chat-close-btn");
const chatLog = document.getElementById("chat-log");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const chatModePill = document.getElementById("chat-mode-pill");

// ---------------------------------------------------------------------------
// Detection command panel
// ---------------------------------------------------------------------------
(function initScanPanel() {
  const launcher = document.getElementById("scan-launcher");
  const panel = document.getElementById("workflow-panel");
  const close = document.getElementById("scan-modal-close");
  const backdrop = document.getElementById("scan-modal-backdrop");
  if (!launcher || !panel || !close || !backdrop) return;

  function toggle(open) {
    panel.classList.toggle("is-open", open);
    panel.setAttribute("aria-hidden", String(!open));
    launcher.setAttribute("aria-expanded", String(open));
    backdrop.hidden = !open;
    if (open) panel.querySelector("button, input")?.focus();
    else launcher.focus();
  }
  launcher.addEventListener("click", () => toggle(true));
  close.addEventListener("click", () => toggle(false));
  backdrop.addEventListener("click", () => toggle(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.classList.contains("is-open")) toggle(false);
  });
})();

const scanLoader = document.getElementById("scan-loader");
const scanLoaderDetail = document.getElementById("scan-loader-detail");
let scanLoaderTimer = null;
function showScanLoader(batch = false) {
  if (!scanLoader) return;
  const messages = batch
    ? ["Indexing image batch…", "Comparing canopy signatures…", "Building disease density layer…"]
    : ["Extracting visual features…", "Comparing disease signatures…", "Fusing location and weather risk…"];
  let index = 0;
  scanLoaderDetail.textContent = messages[index];
  scanLoader.hidden = false;
  scanLoaderTimer = setInterval(() => {
    index = (index + 1) % messages.length;
    scanLoaderDetail.textContent = messages[index];
  }, 1400);
}
function hideScanLoader() {
  clearInterval(scanLoaderTimer);
  scanLoaderTimer = null;
  if (scanLoader) scanLoader.hidden = true;
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/liberty",
  // General Santos City default view; history links override this with ?lat=...&lon=...
  center: [125.1716, 6.1164],
  zoom: 11.5,
  pitch: 35,
  bearing: -8,
  attributionControl: false,
});
const mapFocus = new URLSearchParams(window.location.search);
const focusLat = Number(mapFocus.get("lat"));
const focusLon = Number(mapFocus.get("lon"));
if (Number.isFinite(focusLat) && Number.isFinite(focusLon)) {
  map.setCenter([focusLon, focusLat]);
  map.setZoom(15);
}
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-left");
map.addControl(new maplibregl.AttributionControl({ compact: true }));

const mapStyles = {
  dark: "https://tiles.openfreemap.org/styles/dark",
  positron: "https://tiles.openfreemap.org/styles/positron",
  liberty: "https://tiles.openfreemap.org/styles/liberty",
};
document.querySelectorAll("[data-map-style]").forEach((button) => {
  button.addEventListener("click", () => {
    const style = button.dataset.mapStyle;
    if (!mapStyles[style] || button.classList.contains("active")) return;
    map.setStyle(mapStyles[style]);
    document.querySelectorAll("[data-map-style]").forEach((option) => {
      const active = option === button;
      option.classList.toggle("active", active);
      option.setAttribute("aria-pressed", String(active));
    });
  });
});
document.querySelector('[data-map-style="liberty"]')?.classList.add("active");
document.querySelector('[data-map-style="liberty"]')?.setAttribute("aria-pressed", "true");
document.querySelector('[data-map-style="dark"]')?.classList.remove("active");
document.querySelector('[data-map-style="dark"]')?.setAttribute("aria-pressed", "false");

function createMarkerLayer() {
  return { markers: new Set(), visible: true };
}
function setLayerVisible(layer, visible) {
  layer.visible = visible;
  layer.markers.forEach((marker) => marker.getElement().style.display = visible ? "" : "none");
}
function clearMarkerLayer(layer) {
  layer.markers.forEach((marker) => marker.remove());
  layer.markers.clear();
}
markerLayer = createMarkerLayer();

const boundaryModeBtn = document.getElementById("boundary-mode-btn");
const boundaryFinishBtn = document.getElementById("boundary-finish-btn");
const boundaryClearBtn = document.getElementById("boundary-clear-btn");
const boundaryCountInput = document.getElementById("boundary-count-input");
const boundaryStatus = document.getElementById("boundary-status");
const boundaryResult = document.getElementById("boundary-result");
const temporalModal = document.getElementById("temporal-modal");
const temporalModalClose = document.getElementById("temporal-modal-close");
const temporalModalContent = document.getElementById("temporal-modal-content");
const boundaryLoader = document.getElementById("boundary-loader");
let temporalTimer;
let lastTemporalAnalysis = null;
let temporalHotspots = [];

function boundaryTargetCount() {
  return Math.min(25, Math.max(3, Number.parseInt(boundaryCountInput?.value, 10) || 4));
}

function boundaryGeoJSON() {
  const coordinates = boundaryPoints.map((point) => [point.lon, point.lat]);
  if (coordinates.length < 2) return { type: "FeatureCollection", features: [] };
  if (coordinates.length > 2) coordinates.push(coordinates[0]);
  return {
    type: "Feature",
    geometry: { type: coordinates.length > 3 ? "Polygon" : "LineString", coordinates: coordinates.length > 3 ? [coordinates] : coordinates },
    properties: {},
  };
}

function renderBoundaryShape() {
  if (!map.isStyleLoaded()) return;
  const source = map.getSource("selected-boundary");
  if (source) source.setData(boundaryGeoJSON());
  else {
    map.addSource("selected-boundary", { type: "geojson", data: boundaryGeoJSON() });
    map.addLayer({ id: "selected-boundary-fill", type: "fill", source: "selected-boundary", filter: ["==", "$type", "Polygon"], paint: { "fill-color": "#e8b94a", "fill-opacity": 0.18 } });
    map.addLayer({ id: "selected-boundary-line", type: "line", source: "selected-boundary", paint: { "line-color": "#e8b94a", "line-width": 2, "line-dasharray": [2, 1] } });
  }
}

function pointInsideBoundary(lon, lat) {
  let inside = false;
  for (let i = 0, j = boundaryPoints.length - 1; i < boundaryPoints.length; j = i++) {
    const a = boundaryPoints[i];
    const b = boundaryPoints[j];
    if ((a.lat > lat) !== (b.lat > lat) && lon < ((b.lon - a.lon) * (lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}

function interiorHeatPoints(samples, dayIndex) {
  const lons = boundaryPoints.map((point) => point.lon);
  const lats = boundaryPoints.map((point) => point.lat);
  const [minLon, maxLon] = [Math.min(...lons), Math.max(...lons)];
  const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
  const points = [];
  const steps = 24;
  for (let y = 1; y < steps; y += 1) {
    for (let x = 1; x < steps; x += 1) {
      const lon = minLon + (maxLon - minLon) * x / steps;
      const lat = minLat + (maxLat - minLat) * y / steps;
      if (!pointInsideBoundary(lon, lat)) continue;
      let weightedTemperature = 0;
      let totalWeight = 0;
      samples.forEach((sample) => {
        const distanceSquared = (sample.lon - lon) ** 2 + (sample.lat - lat) ** 2;
        const weight = 1 / Math.max(distanceSquared, 1e-10);
        weightedTemperature += sample.temperatures[dayIndex] * weight;
        totalWeight += weight;
      });
      const measuredTemperature = weightedTemperature / totalWeight;
      const nx = x / steps;
      const ny = y / steps;
      const hotspot = (cx, cy, spread) => Math.exp(-((nx - cx) ** 2 + (ny - cy) ** 2) / spread);
      const heatScore = Math.min(1, 0.06 + temporalHotspots.reduce((score, spot) => score + hotspot(spot.x, spot.y, spot.spread) * spot.intensity, 0));
      points.push({ lon, lat, temperature: measuredTemperature, heatScore });
    }
  }
  return points;
}

function renderTemperatureHeatmap(samples, dayIndex) {
  const heatPoints = interiorHeatPoints(samples, dayIndex);
  const data = {
    type: "FeatureCollection",
    features: heatPoints.map((sample) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [sample.lon, sample.lat] },
      properties: { temperature: sample.temperature, heatScore: sample.heatScore },
    })),
  };
  const source = map.getSource("temperature-heatmap");
  if (source) source.setData(data);
  else {
    map.addSource("temperature-heatmap", { type: "geojson", data });
    map.addLayer({
      id: "temperature-heatmap",
      type: "circle",
      source: "temperature-heatmap",
      paint: {
        "circle-radius": ["interpolate", ["exponential", 1.7], ["zoom"], 8, 10, 12, 24, 16, 72, 20, 210],
        "circle-blur": 0.86,
        "circle-opacity": 0.7,
        "circle-color": ["interpolate", ["linear"], ["get", "heatScore"], 0, "#0015a8", 0.18, "#006cff", 0.34, "#00d9ff", 0.5, "#20d66b", 0.68, "#fff000", 0.84, "#ff7a00", 1, "#ed1c24"],
      },
    });
    map.moveLayer("selected-boundary-line");
  }
  map.setPaintProperty("temperature-heatmap", "circle-color", ["interpolate", ["linear"], ["get", "heatScore"], 0, "#0015a8", 0.18, "#006cff", 0.34, "#00d9ff", 0.5, "#20d66b", 0.68, "#fff000", 0.84, "#ff7a00", 1, "#ed1c24"]);
}

function temperatureColor(value) {
  if (value < 20) return "#36c5f0";
  if (value <= 26) return "#62e890";
  if (value <= 32) return "#e8b94a";
  return "#ef6045";
}

function showTemporalHeatmap(data) {
  clearInterval(temporalTimer);
  temporalHotspots = data.heatPattern || Array.from({ length: 3 + Math.floor(Math.random() * 3) }, () => ({
    x: 0.15 + Math.random() * 0.7,
    y: 0.15 + Math.random() * 0.7,
    spread: 0.012 + Math.random() * 0.04,
    intensity: 0.55 + Math.random() * 0.5,
  }));
  data.heatPattern = temporalHotspots;
  const bounds = new maplibregl.LngLatBounds();
  boundaryPoints.forEach((point) => bounds.extend([point.lon, point.lat]));
  map.fitBounds(bounds, { padding: 110, duration: 1300, maxZoom: 16 });
  let index = 0;
  const samples = data.samples?.length ? data.samples : boundaryPoints.map((point) => ({
    ...point,
    temperatures: data.timeline.map((day) => day.mean_c),
  }));
  const showDay = () => {
    const day = data.timeline[index];
    const color = temperatureColor(day.mean_c);
    renderTemperatureHeatmap(samples, index);
    map.setPaintProperty("selected-boundary-fill", "fill-color", color);
    map.setPaintProperty("selected-boundary-fill", "fill-opacity", 0.08);
    map.setPaintProperty("selected-boundary-line", "line-color", color);
    boundaryStatus.textContent = `${day.date} · ${day.mean_c}°C area mean · ${day.favorable ? "favorable disease band" : "outside favorable band"}`;
    index = (index + 1) % data.timeline.length;
  };
  showDay();
  temporalTimer = setInterval(showDay, 1100);
}

function openTemporalModal(data) {
  const latest = data.timeline[data.timeline.length - 1];
  temporalModalContent.innerHTML = `
    <div class="temporal-metrics">
      <div><span>AREA MEAN</span><strong>${latest.mean_c}°C</strong></div>
      <div><span>THERMAL RANGE</span><strong>${latest.min_c}–${latest.max_c}°C</strong></div>
      <div><span>FAVORABLE DAYS</span><strong>${data.summary.favorable_days}/${data.summary.total_days}</strong></div>
      <div><span>SAMPLE NODES</span><strong>${data.sample_count}</strong></div>
    </div>
    <p>${data.summary.note}</p>
    <p class="temporal-ai-note"><b>AI FIELD SIGNAL</b> Animated map cycles through each observed and forecast day. Color texture is a modeled spatial visualization around measured area temperature—not field-sensor measurements or disease severity. Gold and red show relatively warmer modeled zones.</p>`;
  temporalModal.hidden = false;
}

function closeTemporalModal() {
  temporalModal.hidden = true;
}

temporalModalClose?.addEventListener("click", closeTemporalModal);
temporalModal?.addEventListener("click", (event) => { if (event.target === temporalModal) closeTemporalModal(); });

function addBoundaryPoint(lngLat) {
  const target = boundaryTargetCount();
  if (boundaryPoints.length >= target) return;
  boundaryPoints.push({ lat: lngLat.lat, lon: lngLat.lng });
  const pointIndex = boundaryPoints.length - 1;
  const dot = document.createElement("span");
  dot.className = "boundary-vertex";
  dot.title = "Drag to adjust boundary";
  const marker = new maplibregl.Marker({ element: dot, anchor: "center", draggable: true })
    .setLngLat(lngLat)
    .addTo(map);
  marker.on("drag", () => {
    const position = marker.getLngLat();
    boundaryPoints[pointIndex] = { lat: position.lat, lon: position.lng };
    renderBoundaryShape();
  });
  marker.on("dragend", () => {
    boundaryStatus.textContent = `${boundaryPoints.length} of ${target} dots selected — boundary updated.`;
  });
  boundaryMarkers.push(marker);
  const complete = boundaryPoints.length === target;
  boundaryFinishBtn.disabled = !complete;
  boundaryClearBtn.hidden = false;
  boundaryStatus.textContent = `${boundaryPoints.length} of ${target} dots selected${complete ? " — boundary connected" : ""}.`;
  if (complete) {
    boundaryMode = false;
    boundaryModeBtn.setAttribute("aria-pressed", "false");
    boundaryModeBtn.textContent = "Select boundary";
    map.getCanvas().style.cursor = "";
  }
  renderBoundaryShape();
}

function clearBoundary() {
  boundaryMarkers.forEach((marker) => marker.remove());
  boundaryMarkers = [];
  boundaryPoints = [];
  lastTemporalAnalysis = null;
  clearInterval(temporalTimer);
  boundaryFinishBtn.disabled = true;
  boundaryClearBtn.hidden = true;
  boundaryResult.hidden = true;
  boundaryResult.replaceChildren();
  boundaryStatus.textContent = `Place ${boundaryTargetCount()} dots around an area.`;
  renderBoundaryShape();
}

map.on("click", (event) => {
  if (boundaryMode) addBoundaryPoint(event.lngLat);
  else if (lastTemporalAnalysis && pointInsideBoundary(event.lngLat.lng, event.lngLat.lat)) openTemporalModal(lastTemporalAnalysis);
  else setCoords(event.lngLat.lat, event.lngLat.lng);
});
map.on("style.load", renderBoundaryShape);

boundaryModeBtn?.addEventListener("click", () => {
  if (boundaryMode) {
    boundaryMode = false;
    boundaryModeBtn.setAttribute("aria-pressed", "false");
    boundaryModeBtn.textContent = "Select boundary";
    map.getCanvas().style.cursor = "";
    return;
  }
  if (boundaryLoader) boundaryLoader.hidden = false;
  setTimeout(() => {
    if (boundaryLoader) boundaryLoader.hidden = true;
    boundaryMode = true;
    boundaryModeBtn.setAttribute("aria-pressed", "true");
    boundaryModeBtn.textContent = "Selecting dots…";
    boundaryStatus.textContent = `Place ${boundaryTargetCount()} dots to map thermal field.`;
    map.getCanvas().style.cursor = "crosshair";
  }, 1100);
});
boundaryClearBtn?.addEventListener("click", clearBoundary);
boundaryCountInput?.addEventListener("change", () => {
  boundaryCountInput.value = boundaryTargetCount();
  clearBoundary();
});
boundaryFinishBtn?.addEventListener("click", async () => {
  boundaryMode = false;
  boundaryModeBtn.setAttribute("aria-pressed", "false");
  boundaryModeBtn.textContent = "Select boundary";
  map.getCanvas().style.cursor = "";
  boundaryFinishBtn.disabled = true;
  boundaryStatus.textContent = "Sampling Open-Meteo temperatures across boundary…";
  try {
    const response = await fetch("/api/spatiotemporal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boundary: boundaryPoints }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Area analysis failed");
    const title = document.createElement("strong");
    title.textContent = "14-day area temperature timeline";
    const note = document.createElement("span");
    note.textContent = `${data.summary.note} Sampled at ${data.sample_count} locations.`;
    const grid = document.createElement("div");
    grid.className = "boundary-result-grid";
    data.timeline.forEach((day) => {
      const cell = document.createElement("div");
      cell.className = `boundary-day${day.favorable ? " hot" : ""}`;
      cell.title = `${day.date}: ${day.min_c}–${day.max_c}°C`;
      cell.textContent = `${day.date.slice(5)}\n${day.mean_c}°`;
      grid.appendChild(cell);
    });
    boundaryResult.replaceChildren(title, note, grid);
    boundaryResult.hidden = false;
    lastTemporalAnalysis = data;
    showTemporalHeatmap(data);
    openTemporalModal(data);
  } catch (error) {
    boundaryStatus.textContent = error.message;
  } finally {
    boundaryFinishBtn.disabled = boundaryPoints.length !== boundaryTargetCount();
  }
});

function setCoords(lat, lon) {
  currentLat = lat;
  currentLon = lon;
  document.getElementById("lat-input").value = lat.toFixed(6);
  document.getElementById("lon-input").value = lon.toFixed(6);
  coordHint.textContent = `Coordinates set: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  coordHint.classList.add("is-set");
  map.flyTo({ center: [lon, lat], zoom: 14, duration: 900 });
  renderLocationMarker();
  updateDetectButtons();
}

document.getElementById("lat-input").addEventListener("input", syncManualCoords);
document.getElementById("lon-input").addEventListener("input", syncManualCoords);
function syncManualCoords() {
  const latValue = document.getElementById("lat-input").value.trim();
  const lonValue = document.getElementById("lon-input").value.trim();
  const lat = Number(latValue);
  const lon = Number(lonValue);

  if (!latValue || !lonValue || !Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    currentLat = null;
    currentLon = null;
    coordHint.textContent = latValue || lonValue
      ? "Enter a valid latitude (-90 to 90) and longitude (-180 to 180)."
      : "No coordinates set yet";
    coordHint.classList.remove("is-set");
    if (selectedLocationMarker) {
      selectedLocationMarker.remove();
      markerLayer.markers.delete(selectedLocationMarker);
      selectedLocationMarker = null;
    }
    updateDetectButtons();
    return;
  }

  currentLat = lat;
  currentLon = lon;
  coordHint.textContent = `Coordinates set: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  coordHint.classList.add("is-set");
  renderLocationMarker();
  updateDetectButtons();
}

document.getElementById("use-gps-btn").addEventListener("click", () => {
  if (!navigator.geolocation) {
    coordHint.textContent = "Geolocation not supported - click the map to set coordinates manually.";
    coordHint.classList.remove("is-set");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => setCoords(pos.coords.latitude, pos.coords.longitude),
    (error) => {
      const message = error.code === 1
        ? "Location permission denied - click the map to set coordinates manually."
        : error.code === 2
          ? "Your current location is unavailable - click the map to set coordinates manually."
          : "Location request timed out - click the map to set coordinates manually.";
      coordHint.textContent = message;
      coordHint.classList.remove("is-set");
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
});

function addResultMarker(r, layer, setId = null) {
  const dot = document.createElement("button");
  dot.type = "button";
  dot.className = "map-result-marker";
  dot.style.setProperty("--marker-color", isUncertain(r) ? "#94a3b8" : r.color);
  dot.setAttribute("aria-label", isUncertain(r) ? `Uncertain ${r.class} prediction` : `${r.class} detection`);
  const severityText = r.severity_pct === null || r.severity_pct === undefined
    ? "N/A (classification model)"
    : `${r.severity_pct}%`;
  const popup = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = isUncertain(r) ? "Unknown — review needed" : r.class;
  popup.appendChild(title);
  const details = document.createElement("div");
  details.textContent = `Confidence: ${(r.confidence * 100).toFixed(1)}% · Severity: ${severityText}`;
  popup.appendChild(details);
  if (isUncertain(r)) {
    const uncertainty = document.createElement("div");
    uncertainty.textContent = `Predicted ${r.class}; threshold ${(r.confidence_threshold * 100).toFixed(0)}%. ${predictionSummary(r)}`;
    popup.appendChild(uncertainty);
  }
  if (r.weather) {
    const weather = document.createElement("div");
    weather.textContent = `Weather risk: ${r.weather.risk_level} (${r.weather.risk_note})`;
    popup.appendChild(weather);
  }
  if (r.mock) {
    const mockNote = document.createElement("em");
    mockNote.textContent = "Mock result — model not trained yet";
    popup.appendChild(mockNote);
  }
  const marker = new maplibregl.Marker({ element: dot, anchor: "center" })
    .setLngLat([r.lon, r.lat])
    .setPopup(new maplibregl.Popup({ offset: 16, className: "detection-popup" }).setDOMContent(popup))
    .addTo(map);
  layer.markers.add(marker);
  dot.addEventListener("click", (event) => {
    event.stopPropagation();
    if (setId && savedSets.some((set) => set.id === setId)) {
      activeSetId = setId;
      const selectedSet = savedSets.find((set) => set.id === setId);
      lastDetectionContext = selectedSet?.weather && !r.weather
        ? { ...r, weather: selectedSet.weather }
        : r;
      renderSetTabs();
      renderSetDetails();
      resultsForSelectedMarker(r, setId);
      updateDownloadButton();
      const workflowPanel = document.getElementById("workflow-panel");
      if (!workflowPanel.classList.contains("is-open")) {
        document.getElementById("scan-launcher").click();
      }
      document.querySelector(".sets-panel")?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    selectedMapResult = r;
    chatContextMode = "auto";
    updateChatContextChoice();
  });
}

function renderLocationMarker() {
  if (selectedLocationMarker) {
    selectedLocationMarker.remove();
    markerLayer.markers.delete(selectedLocationMarker);
    selectedLocationMarker = null;
  }
  if (currentLat === null || currentLon === null) return;

  const pin = document.createElement("span");
  pin.className = "map-location-marker";
  selectedLocationMarker = new maplibregl.Marker({ element: pin, anchor: "center" })
    .setLngLat([currentLon, currentLat])
    .setPopup(new maplibregl.Popup({ offset: 14 }).setText("Selected planting location"))
    .addTo(map);
  markerLayer.markers.add(selectedLocationMarker);
}

function updateDownloadButton() {
  downloadSummaryBtn.disabled = !lastDetectionContext;
}

function getActiveSet() {
  return savedSets.find((set) => set.id === activeSetId) || null;
}

function createSetLabel(index) {
  return `Set ${index + 1}`;
}

function renderSetTabs() {
  setsTabs.innerHTML = "";
  savedSets.forEach((set) => {
    setLayerVisible(set.markerLayer, true);
  });
  savedSets.forEach((set, index) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `set-tab${set.id === activeSetId ? " active" : ""}`;
    tab.textContent = set.label || createSetLabel(index);
    tab.addEventListener("click", () => {
      activeSetId = set.id;
      lastDetectionContext = set.context;
      selectedMapResult = null;
      chatContextMode = "auto";
      updateChatContextChoice();
      renderSetTabs();
      renderSetDetails();
      renderActiveSetResults();
      updateDownloadButton();
    });
    setsTabs.appendChild(tab);
  });
  clearSetsBtn.disabled = savedSets.length === 0;
}

function renderSetDetails() {
  const activeSet = getActiveSet();
  if (!activeSet) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No saved set selected. Run a detection to create a new set.";
    setDetails.replaceChildren(empty);
    return;
  }

  const lines = [];
  lines.push(`Type: ${activeSet.type === "batch" ? "Batch" : "Single"}`);
  if (activeSet.type === "batch") {
    lines.push(`Classes: ${Object.keys(activeSet.summary || {}).join(", ")}`);
    lines.push(`Images: ${activeSet.results.length}`);
  } else {
    lines.push(`Detection: ${activeSet.context.class} (${(activeSet.context.confidence * 100).toFixed(1)}%)`);
  }
  if (activeSet.weather) {
    lines.push(`Weather: ${activeSet.weather.conditions || "unknown"}, risk ${activeSet.weather.risk_level}`);
  }
  if (activeSet.coordinates) {
    lines.push(`Coordinates: ${activeSet.coordinates.lat.toFixed(6)}, ${activeSet.coordinates.lon.toFixed(6)}`);
  }

  const details = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = activeSet.label;
  const detailText = document.createElement("div");
  detailText.className = "set-detail-lines";
  detailText.textContent = lines.join("\n");
  details.append(title, detailText);
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "btn btn-outline small";
  removeButton.id = "remove-active-set-btn";
  removeButton.textContent = "Remove active set";
  setDetails.replaceChildren(details, removeButton);

  document.getElementById("remove-active-set-btn").addEventListener("click", () => {
    const removedSet = getActiveSet();
    if (removedSet?.markerLayer) {
      clearMarkerLayer(removedSet.markerLayer);
    }
    savedSets = savedSets.filter((set) => set.id !== activeSetId);
    activeSetId = savedSets.length ? savedSets[savedSets.length - 1].id : null;
    lastDetectionContext = getActiveSet()?.context || null;
    selectedMapResult = null;
    chatContextMode = "auto";
    renderSetTabs();
    renderSetDetails();
    renderActiveSetResults();
    updateDownloadButton();
    updateChatContextChoice();
  });
}

function renderActiveSetResults() {
  const results = document.getElementById("results-list");
  const activeSet = getActiveSet();
  if (!activeSet) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Detection results will appear here.";
    results.replaceChildren(empty);
    return;
  }

  results.replaceChildren();
  activeSet.results.forEach((result) => renderResult(result, activeSet.id));
}

function resultsForSelectedMarker(result, setId) {
  const results = document.getElementById("results-list");
  results.replaceChildren();
  renderResult(result, setId);
}

function addSavedSet(context) {
  const id = `set-${Date.now()}-${nextSetNumber}`;
  const label = `Set ${nextSetNumber}`;
  nextSetNumber += 1;
  const setObject = {
    id,
    label,
    type: context.batch ? "batch" : "single",
    context,
    summary: context.summary || null,
    results: context.results || (context.batch ? [] : [context]),
    weather: context.weather || null,
    coordinates: context.lat != null && context.lon != null ? { lat: context.lat, lon: context.lon } : null,
    markerLayer: createMarkerLayer(),
  };
  savedSets.push(setObject);
  activeSetId = id;
  lastDetectionContext = context;
  chatContextMode = "auto";
  renderSetTabs();
  renderSetDetails();
  renderActiveSetResults();
  updateDownloadButton();
  updateChatContextChoice();
  return setObject;
}

async function loadDetectionHistory() {
  try {
    const response = await fetch("/api/history");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "History could not be loaded.");

    [...(data.groups || [])].reverse().forEach((group) => {
      const first = group.results?.[0];
      if (!first) return;
      const context = group.batch
        ? {
            batch: true,
            summary: group.summary,
            results: group.results,
            weather: first.weather,
            lat: first.lat,
            lon: first.lon,
          }
        : first;
      const savedSet = addSavedSet(context);
      savedSet.label = `${group.batch ? "Batch" : "Scan"} · ${new Date(group.timestamp).toLocaleString()}`;
      group.results.forEach((result) => addResultMarker(result, savedSet.markerLayer, savedSet.id));
    });
    renderSetTabs();
    renderSetDetails();
  } catch (error) {
    console.error("Detection history unavailable:", error);
  }
}

function clearSavedSets() {
  savedSets.forEach((set) => {
    clearMarkerLayer(set.markerLayer);
  });
  savedSets = [];
  activeSetId = null;
  lastDetectionContext = null;
  selectedMapResult = null;
  chatContextMode = "auto";
  renderSetTabs();
  renderSetDetails();
  renderActiveSetResults();
  updateDownloadButton();
  updateChatContextChoice();
}

function updateChatContextChoice() {
  const activeSet = getActiveSet();
  if (activeSet && selectedMapResult) {
    chatContextChoice.classList.remove("hidden");
    return;
  }
  chatContextChoice.classList.add("hidden");
}

clearSetsBtn.addEventListener("click", clearSavedSets);
loadDetectionHistory();
contextTabBtn.addEventListener("click", () => {
  chatContextMode = "tab";
  chatContextChoice.classList.add("hidden");
  if (pendingMessage) {
    const message = pendingMessage;
    pendingMessage = null;
    userInput.value = "";
    sendMessageWithContext(message);
  }
});
contextMapBtn.addEventListener("click", () => {
  chatContextMode = "map";
  chatContextChoice.classList.add("hidden");
  if (pendingMessage) {
    const message = pendingMessage;
    pendingMessage = null;
    userInput.value = "";
    sendMessageWithContext(message);
  }
});

function resolveChatContext() {
  const activeSet = getActiveSet();
  if (chatContextMode === "tab") return activeSet?.context || null;
  if (chatContextMode === "map") return selectedMapResult || null;
  if (activeSet && selectedMapResult) {
    updateChatContextChoice();
    return null;
  }
  if (selectedMapResult) return selectedMapResult;
  if (activeSet) return activeSet.context;
  return null;
}

function sendMessageWithContext(message) {
  addMessage(message, "user");
  const context = resolveChatContext() || {};
  sendBtn.disabled = true;
  fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, context }),
  })
    .then(async (chatRes) => {
      const chatData = await chatRes.json();
      if (!chatRes.ok) throw new Error(chatData.error || "The assistant request failed.");
      return chatData;
    })
    .then((chatData) => {
      addMessage(chatData.reply || "Error getting reply.", "bot");
      if (chatData.offline) {
        chatModePill.textContent = "local / offline mode";
        chatModePill.className = "pill small warn";
      } else {
        chatModePill.textContent = "online";
        chatModePill.className = "pill small ok";
      }
    })
    .catch((error) => {
      addMessage(error.message || "Can't reach the assistant right now. You're in local / offline mode.", "bot");
      chatModePill.textContent = "local / offline mode";
      chatModePill.className = "pill small warn";
    })
    .finally(() => {
      sendBtn.disabled = false;
    });
}

function sendMessage() {
  if (sendBtn.disabled) return;
  const message = userInput.value.trim();
  if (!message) return;
  const activeSet = getActiveSet();
  if (activeSet && selectedMapResult && chatContextMode === "auto") {
    pendingMessage = message;
    chatContextChoice.classList.remove("hidden");
    return;
  }
  userInput.value = "";
  pendingMessage = null;
  sendMessageWithContext(message);
}

// ---------------------------------------------------------------------------
// Upload mode switch (single / batch) — animated segmented control
// ---------------------------------------------------------------------------
(function uploadSwitch() {
  const switchBtns = Array.from(document.querySelectorAll(".tab-btn"));
  const panels = Array.from(document.querySelectorAll(".tab-panel"));

  if (!switchBtns.length) return;

  function activate(btn) {
    switchBtns.forEach((b) => {
      const isActive = b === btn;
      b.classList.toggle("active", isActive);
      b.setAttribute("aria-selected", String(isActive));
      b.tabIndex = isActive ? 0 : -1;
    });

    const targetId = `tab-${btn.dataset.tab}`;
    panels.forEach((panel) => {
      const isActive = panel.id === targetId;
      panel.classList.toggle("active", isActive);
      panel.setAttribute("aria-hidden", String(!isActive));
    });
  }

  switchBtns.forEach((btn, index) => {
    btn.addEventListener("click", () => activate(btn));
    btn.addEventListener("keydown", (event) => {
      let nextIndex = null;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % switchBtns.length;
      if (event.key === "ArrowLeft") nextIndex = (index - 1 + switchBtns.length) % switchBtns.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = switchBtns.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      activate(switchBtns[nextIndex]);
      switchBtns[nextIndex].focus();
    });
  });
})();

function updateDetectButtons() {
  const hasCoords = currentLat !== null && currentLon !== null;
  document.getElementById("single-detect-btn").disabled = !(hasCoords && singleFile);
  document.getElementById("batch-detect-btn").disabled = !(hasCoords && batchFileList.length > 0);
}

downloadSummaryBtn.addEventListener("click", downloadDetectionSummary);

// ---------------------------------------------------------------------------
// Single image upload
// ---------------------------------------------------------------------------
const singleDropzone = document.getElementById("single-dropzone");
const singleFileInput = document.getElementById("single-file");
const leafPreview = document.getElementById("leaf-preview");
const leafPreviewImage = document.getElementById("leaf-preview-image");
let leafPreviewUrl = null;

function showLeafPreview(file) {
  if (!leafPreview || !leafPreviewImage) return;
  if (leafPreviewUrl) URL.revokeObjectURL(leafPreviewUrl);
  leafPreviewUrl = URL.createObjectURL(file);
  leafPreviewImage.src = leafPreviewUrl;
  leafPreview.hidden = false;
}

singleFileInput.addEventListener("click", () => {
  singleFileInput.value = "";
});
singleFileInput.addEventListener("change", (e) => {
  if (e.target.files.length) {
    singleFile = e.target.files[0];
    showLeafPreview(singleFile);
    singleDropzone.querySelector(".dz-title").textContent = singleFile.name;
    updateDetectButtons();
  }
});
["dragover", "dragleave", "drop"].forEach((evt) => {
  singleDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    singleDropzone.classList.toggle("drag-over", evt === "dragover");
    if (evt === "drop" && e.dataTransfer.files.length) {
      singleFile = e.dataTransfer.files[0];
      showLeafPreview(singleFile);
      singleDropzone.querySelector(".dz-title").textContent = singleFile.name;
      updateDetectButtons();
    }
  });
});

document.getElementById("single-detect-btn").addEventListener("click", async () => {
  if (!singleFile || currentLat === null) return;
  const btn = document.getElementById("single-detect-btn");
  btn.disabled = true;
  btn.classList.add("is-loading");
  btn.textContent = "Detecting\u2026";
  leafPreview?.classList.add("is-scanning");

  const fd = new FormData();
  fd.append("image", singleFile);
  fd.append("lat", currentLat);
  fd.append("lon", currentLon);

  try {
    const [res] = await Promise.all([
      fetch("/api/detect", { method: "POST", body: fd }),
      new Promise((resolve) => setTimeout(resolve, 1350)),
    ]);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Detection failed (HTTP ${res.status}).`);
    if (data.error) throw new Error(data.error);
    const savedSet = addSavedSet(data);
    addResultMarker(data, savedSet.markerLayer, savedSet.id);
    updateDownloadButton();
  } catch (err) {
    renderError(err?.message || String(err));
  } finally {
    leafPreview?.classList.remove("is-scanning");
    btn.classList.remove("is-loading");
    btn.textContent = "Run detection";
    updateDetectButtons();
  }
});

// ---------------------------------------------------------------------------
// Batch upload
// ---------------------------------------------------------------------------
const batchDropzone = document.getElementById("batch-dropzone");
const batchFilesInput = document.getElementById("batch-files");

batchFilesInput.addEventListener("click", () => {
  batchFilesInput.value = "";
});
batchFilesInput.addEventListener("change", (e) => {
  batchFileList = Array.from(e.target.files);
  document.getElementById("batch-count").textContent = `${batchFileList.length} images selected`;
  updateDetectButtons();
});
["dragover", "dragleave", "drop"].forEach((evt) => {
  batchDropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    batchDropzone.classList.toggle("drag-over", evt === "dragover");
    if (evt === "drop" && e.dataTransfer.files.length) {
      batchFileList = Array.from(e.dataTransfer.files);
      document.getElementById("batch-count").textContent = `${batchFileList.length} images selected`;
      updateDetectButtons();
    }
  });
});

document.getElementById("batch-detect-btn").addEventListener("click", async () => {
  if (!batchFileList.length || currentLat === null) return;
  const btn = document.getElementById("batch-detect-btn");
  btn.disabled = true;
  btn.classList.add("is-loading");
  btn.textContent = "Detecting\u2026";
  showScanLoader(true);

  const fd = new FormData();
  batchFileList.forEach((f) => fd.append("images", f));
  fd.append("lat", currentLat);
  fd.append("lon", currentLon);

  try {
    const res = await fetch("/api/detect_batch", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Batch detection failed (HTTP ${res.status}).`);
    if (data.error) throw new Error(data.error);
    if (!Array.isArray(data.results) || data.results.length === 0) {
      throw new Error("The server returned no batch results.");
    }
    const batchWeather = data.results.length ? data.results[0].weather : null;
    const batchContext = {
      batch: true,
      summary: data.summary,
      results: data.results,
      weather: batchWeather,
      lat: currentLat,
      lon: currentLon,
    };
    const savedSet = addSavedSet(batchContext);
    data.results.forEach((r) => {
      addResultMarker(r, savedSet.markerLayer, savedSet.id);
    });
    updateDownloadButton();
  } catch (err) {
    renderError(err?.message || String(err));
  } finally {
    hideScanLoader();
    btn.classList.remove("is-loading");
    btn.textContent = "Run batch detection";
    updateDetectButtons();
  }
});

// ---------------------------------------------------------------------------
// Results list
// ---------------------------------------------------------------------------
function renderResult(r, setId) {
  const list = document.getElementById("results-list");

  const severityText = r.severity_pct === null || r.severity_pct === undefined
    ? "N/A"
    : `${r.severity_pct}%`;
  const card = document.createElement("div");
  card.className = `result-card${isUncertain(r) ? " is-uncertain" : ""}`;
  card.dataset.setId = setId;
  card.style.borderLeftColor = isUncertain(r) ? "#d6a936" : r.color;
  const image = document.createElement("img");
  image.src = r.image_url;
  image.alt = "Uploaded banana leaf";
  const meta = document.createElement("div");
  meta.className = "result-meta";
  const className = document.createElement("div");
  className.className = "result-class";
  className.textContent = isUncertain(r) ? "Unknown — review needed" : r.class;
  const confidence = document.createElement("div");
  confidence.className = "result-sub";
  confidence.textContent = `Confidence ${(r.confidence * 100).toFixed(1)}% · severity ${severityText}`;
  meta.append(className, confidence);
  const explanation = document.createElement("div");
  explanation.className = "result-explanation";
  explanation.textContent = resultExplanation(r);
  meta.appendChild(explanation);
  if (isUncertain(r)) {
    const uncertainty = document.createElement("div");
    uncertainty.className = "uncertain-tag";
    uncertainty.textContent = `Predicted ${r.class} · threshold ${(r.confidence_threshold * 100).toFixed(0)}%`;
    const alternatives = document.createElement("div");
    alternatives.className = "result-sub";
    alternatives.textContent = `Candidates: ${predictionSummary(r)}`;
    meta.append(uncertainty, alternatives);
  }
  if (r.weather) {
    const weather = document.createElement("div");
    weather.className = "result-sub";
    weather.textContent = `Weather: ${r.weather.conditions || "unknown"}, ${r.weather.temp ?? "N/A"}°C, humidity ${r.weather.humidity ?? "N/A"}%, risk ${r.weather.risk_level}`;
    meta.appendChild(weather);
  }
  if (r.mock) {
    const mockNote = document.createElement("div");
    mockNote.className = "mock-tag";
    mockNote.textContent = "Mock result — train the model to replace this";
    meta.appendChild(mockNote);
  }
  card.append(image, meta);
  list.prepend(card);
}

function renderError(message) {
  const list = document.getElementById("results-list");
  const card = document.createElement("div");
  card.className = "result-card";
  card.style.borderLeftColor = "#B23A2E";
  const meta = document.createElement("div");
  meta.className = "result-meta";
  const title = document.createElement("div");
  title.className = "result-class";
  title.textContent = "Error";
  const detail = document.createElement("div");
  detail.className = "result-sub";
  detail.textContent = message;
  meta.append(title, detail);
  card.appendChild(meta);
  list.prepend(card);
}

// ---------------------------------------------------------------------------
// Health check (model / assistant status pills)
// ---------------------------------------------------------------------------
async function checkHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    const modelPill = document.getElementById("model-pill");
    modelPill.innerHTML = `<span class="pill-dot"></span>` + (data.model_loaded ? "Model ready" : "Model mock mode");
    modelPill.className = "pill " + (data.model_loaded ? "ok" : "warn");

    const assistantPill = document.getElementById("assistant-pill");
    assistantPill.innerHTML = `<span class="pill-dot"></span>` + (data.assistant_configured ? "Assistant configured" : "Assistant offline");
    assistantPill.className = "pill " + (data.assistant_configured ? "ok" : "warn");

    chatModePill.textContent = data.assistant_configured ? "Ready" : "Offline";
    chatModePill.className = "pill small " + (data.assistant_configured ? "ok" : "warn");
  } catch {
    document.getElementById("model-pill").textContent = "model: unknown";
    document.getElementById("assistant-pill").textContent = "assistant: unreachable";
  }
}
checkHealth();

async function setReviewStatus(id, reviewStatus) {
  const response = await fetch(`/api/detections/${encodeURIComponent(id)}/review`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ review_status: reviewStatus }),
  });
  if (!response.ok) throw new Error((await response.json()).error || "Review update failed");
  await loadReviewQueue();
}

function startReviewReupload(result) {
  if (typeof setCoords === "function") setCoords(result.lat, result.lon);
  document.getElementById("scan-launcher")?.click();
  document.getElementById("single-file")?.click();
}

async function loadReviewQueue() {
  const list = document.getElementById("review-list");
  if (!list) return;
  try {
    const response = await fetch("/api/review?status=pending");
    if (!response.ok) throw new Error("Review queue unavailable");
    const { results } = await response.json();
    list.replaceChildren();
    if (!results.length) {
      list.innerHTML = '<p class="review-empty">No detections need review.</p>';
      return;
    }
    results.forEach((result) => {
      const card = document.createElement("article");
      card.className = "review-card";
      const image = document.createElement("img");
      image.src = result.image_url;
      image.alt = "Banana leaf awaiting review";
      const content = document.createElement("div");
      content.className = "review-card-content";
      const title = document.createElement("h2");
      title.textContent = "Unknown — review needed";
      const score = document.createElement("p");
      score.textContent = `Predicted ${result.class} at ${(result.confidence * 100).toFixed(1)}% (threshold ${(result.confidence_threshold * 100).toFixed(0)}%)`;
      const candidates = document.createElement("p");
      candidates.className = "prediction-list";
      candidates.textContent = `Competing scores: ${predictionSummary(result)}`;
      const guidance = document.createElement("p");
      guidance.textContent = "Recapture closer, in even light, with sharp focus and the whole affected leaf visible.";
      const actions = document.createElement("div");
      actions.className = "review-actions";
      [["Confirm prediction", "confirmed"], ["Reject prediction", "rejected"]].forEach(([label, status]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-outline";
        button.textContent = label;
        button.addEventListener("click", () => setReviewStatus(result.id, status).catch((error) => alert(error.message)));
        actions.appendChild(button);
      });
      const reupload = document.createElement("button");
      reupload.type = "button";
      reupload.className = "btn btn-primary";
      reupload.textContent = "Recapture / reupload";
      reupload.addEventListener("click", () => startReviewReupload(result));
      actions.appendChild(reupload);
      content.append(title, score, candidates, guidance, actions);
      card.append(image, content);
      list.appendChild(card);
    });
  } catch (error) {
    list.innerHTML = `<p class="review-empty">${error.message}</p>`;
  }
}
loadReviewQueue();

async function loadHistoryPage() {
  const list = document.getElementById("history-list");
  const mapList = document.getElementById("map-history-list");
  if (!mapList) return;
  try {
    const response = await fetch("/api/history");
    if (!response.ok) throw new Error("History unavailable");
    const { groups } = await response.json();
    mapList?.replaceChildren();
    if (!groups.length) {
      if (mapList) mapList.innerHTML = '<p class="muted">No saved scans yet.</p>';
      return;
    }
    groups.forEach((group) => {
      const card = document.createElement("article");
      card.className = "history-card";
      const heading = document.createElement("h2");
      heading.textContent = `${group.batch ? "Batch" : "Scan"} · ${new Date(group.timestamp).toLocaleString()}`;
      card.appendChild(heading);
      group.results.forEach((result) => {
        const row = document.createElement("div");
        row.className = "history-row";
        const image = document.createElement("img");
        image.src = result.image_url;
        image.alt = "Saved banana leaf scan";
        const details = document.createElement("div");
        const label = isUncertain(result) ? "Uncertain" : result.class;
        details.innerHTML = `<strong>${label}</strong><span>${(result.confidence * 100).toFixed(1)}% · ${Number(result.lat).toFixed(5)}, ${Number(result.lon).toFixed(5)}</span>`;
        row.append(image, details);
        card.appendChild(row);
      });
      if (mapList) {
        group.results.forEach((result) => {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "map-history-item";
          item.innerHTML = `<img src="${result.image_url}" alt=""><span><b>${isUncertain(result) ? "Uncertain" : result.class}</b><small>${new Date(result.timestamp).toLocaleString()} · ${(result.confidence * 100).toFixed(1)}%</small></span>`;
          item.addEventListener("click", () => {
            map.flyTo({ center: [result.lon, result.lat], zoom: 17 });
          });
          mapList.appendChild(item);
        });
      }
    });
  } catch (error) {
    if (mapList) mapList.innerHTML = `<p class="muted">${error.message}</p>`;
  }
}
loadHistoryPage();

// ---------------------------------------------------------------------------
// Chat widget (minimize / maximize / close, offline indicator, TTS)
// ---------------------------------------------------------------------------
chatFab.addEventListener("click", () => {
  chatWindow.classList.add("open");
  chatWindow.classList.remove("minimized");
  chatWindow.setAttribute("aria-hidden", "false");
  chatFab.setAttribute("aria-expanded", "true");
});
chatCloseBtn.addEventListener("click", () => {
  chatWindow.classList.remove("open");
  chatWindow.setAttribute("aria-hidden", "true");
  chatFab.setAttribute("aria-expanded", "false");
});
chatMinBtn.addEventListener("click", () => {
  const isMinimized = chatWindow.classList.toggle("minimized");
  chatWindow.setAttribute("aria-hidden", String(isMinimized));
  chatFab.setAttribute("aria-expanded", String(!isMinimized));
});

const SPEAK_ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/><path d="M16 8a5 5 0 010 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const LOADING_ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" stroke-dasharray="30" stroke-linecap="round"/></svg>`;

function clearEmptyState() {
  const empty = document.querySelector(".empty-state");
  if (empty) empty.remove();
}

function stripMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/`{1,3}(.*?)`{1,3}/g, "$1")
    .replace(/#{1,6}\s?/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\n{2,}/g, ". ")
    .trim();
}

function addMessage(text, sender) {
  clearEmptyState();

  const wrapper = document.createElement("div");
  wrapper.className = `msg ${sender}`;

  const displayText = sender === "bot" ? stripMarkdown(text) : text;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = displayText;
  wrapper.appendChild(bubble);

  if (sender === "bot") {
    const speakBtn = document.createElement("button");
    speakBtn.className = "speak-btn";
    speakBtn.innerHTML = SPEAK_ICON;
    speakBtn.title = "Play audio";
    speakBtn.addEventListener("click", () => playAudio(displayText, speakBtn));
    wrapper.appendChild(speakBtn);
  }

  chatLog.appendChild(wrapper);
  chatLog.scrollTop = chatLog.scrollHeight;
}

async function playAudio(text, btn) {
  btn.disabled = true;
  btn.innerHTML = LOADING_ICON;

  try {
    const res = await fetch("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) throw new Error("TTS request failed");

    const audioBlob = await res.blob();
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
    audio.onended = () => URL.revokeObjectURL(audioUrl);
    audio.onerror = () => {
      URL.revokeObjectURL(audioUrl);
      console.error("Audio playback failed");
    };
    await audio.play();
  } catch (err) {
    console.error(err);
  } finally {
    btn.innerHTML = SPEAK_ICON;
    btn.disabled = false;
  }
}

sendBtn.addEventListener("click", sendMessage);
userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});
document.querySelectorAll("[data-chat-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    userInput.value = button.dataset.chatPrompt;
    sendMessage();
  });
});

// ---------------------------------------------------------------------------
// Export / download
// ---------------------------------------------------------------------------
function getSummaryPayload() {
  const context = lastDetectionContext;
  const coordinateSource = context?.batch ? (context.results?.[0] || context) : context;
  const payload = {
    generated_at: new Date().toISOString(),
    coordinates: coordinateSource?.lat != null && coordinateSource?.lon != null
      ? { lat: coordinateSource.lat, lon: coordinateSource.lon }
      : null,
    weather: context?.weather || coordinateSource?.weather || null,
  };

  if (context?.batch) {
    payload.type = "batch";
    payload.summary = context.summary || {};
    payload.results = context.results || [];
    payload.high_confidence_results = payload.results.filter((result) => !isUncertain(result));
    payload.low_confidence_results = payload.results.filter(isUncertain);
  } else {
    payload.type = "single";
    payload.result = context;
    payload.high_confidence_results = isUncertain(context) ? [] : [context];
    payload.low_confidence_results = isUncertain(context) ? [context] : [];
  }

  return payload;
}

function formatCsv(payload) {
  const rows = [];
  if (payload.type === "batch") {
    rows.push(["Review category", "Class", "Confidence", "Review status", "Competing scores"]);
    payload.high_confidence_results.forEach((result) => rows.push([
      "High confidence", result.class, `${(result.confidence * 100).toFixed(1)}%`, result.review_status, predictionSummary(result),
    ]));
    payload.low_confidence_results.forEach((result) => rows.push([
      "Low confidence — unconfirmed", result.class, `${(result.confidence * 100).toFixed(1)}%`, result.review_status, predictionSummary(result),
    ]));
  } else {
    rows.push(["Field", "Value"]);
    rows.push(["Class", payload.result.class]);
    rows.push(["Confidence", `${(payload.result.confidence * 100).toFixed(1)}%`]);
    rows.push(["Severity", payload.result.severity_pct == null ? "N/A" : `${payload.result.severity_pct}%`]);
    rows.push(["Image URL", payload.result.image_url || ""]);
    rows.push(["Inference status", payload.result.inference_status || "confident"]);
    rows.push(["Review status", payload.result.review_status || "not_required"]);
    rows.push(["Competing scores", predictionSummary(payload.result)]);
  }
  if (payload.weather) {
    rows.push([]);
    rows.push(["Weather condition", payload.weather.conditions || "unknown"]);
    rows.push(["Temperature", payload.weather.temp ?? "N/A"]);
    rows.push(["Humidity", payload.weather.humidity ?? "N/A"]);
    rows.push(["Risk level", payload.weather.risk_level || "N/A"]);
    rows.push(["Risk note", payload.weather.risk_note || ""]);
  }
  if (payload.coordinates) {
    rows.push([]);
    rows.push(["Latitude", payload.coordinates.lat]);
    rows.push(["Longitude", payload.coordinates.lon]);
  }
  return rows.map((row) => row.map((cell) => {
    let value = String(cell);
    if (typeof cell === "string" && /^[=+\-@]/.test(value.trimStart())) value = `'${value}`;
    return `"${value.replace(/"/g, '""')}"`;
  }).join(",")).join("\n");
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildAreaAssessment(payload, doc, aiSummary = "") {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 18;
  const contentWidth = pageWidth - margin * 2;
  const forest = [24, 67, 43];
  const green = [74, 124, 89];
  const gold = [232, 185, 74];
  const ink = [35, 45, 39];
  const muted = [94, 108, 99];
  let y = 0;

  const clean = (value, fallback = "Not available") => value == null || value === "" ? fallback : String(value);
  const cleanAi = (value) => String(value || "")
    .replace(/\*{1,3}/g, "")
    .replace(/\s*\/\s*%/g, "%")
    .replace(/\b(\d+)\s+([23])\s+weeks\b/g, "$1–$2 weeks")
    // Groq can occasionally return OCR-like character spacing.
    .replace(/\b(?:[A-Za-z]\s+){2,}[A-Za-z]\b/g, (word) => word.replace(/\s+/g, ""))
    .replace(/\s+/g, " ")
    .replace(/\b(?:practical\s+next\s+steps|next\s+steps)\s*:?[^]*$/i, "")
    .trim();
  const titleCase = (value) => clean(value).replace(/\b\w/g, (char) => char.toUpperCase());
  const percentage = (value) => value == null ? "N/A" : `${Number(value).toFixed(1)}%`;
  const addPage = () => {
    doc.addPage();
    y = 20;
  };
  const ensureSpace = (height) => {
    if (y + height > pageHeight - 20) addPage();
  };
  const paragraph = (text, options = {}) => {
    doc.setFont("helvetica", options.bold ? "bold" : "normal");
    doc.setFontSize(options.size || 10);
    doc.setTextColor(...(options.color || ink));
    const lines = String(text).split(/\n+/).flatMap((line) =>
      doc.splitTextToSize(line.trim(), options.width || contentWidth));
    ensureSpace(lines.length * (options.leading || 5) + 3);
    doc.text(lines, margin, y);
    y += lines.length * (options.leading || 5) + (options.after ?? 4);
  };
  const section = (number, title) => {
    ensureSpace(14);
    doc.setDrawColor(...gold);
    doc.setLineWidth(0.8);
    doc.line(margin, y, margin + 8, y);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(...forest);
    doc.text(`${number}. ${title.toUpperCase()}`, margin + 12, y + 1.5);
    y += 10;
  };
  const table = (rows) => {
    const labelWidth = 55;
    rows.forEach(([label, value], index) => {
      const valueLines = doc.splitTextToSize(clean(value), contentWidth - labelWidth - 8);
      const rowHeight = Math.max(9, valueLines.length * 4.5 + 4);
      ensureSpace(rowHeight);
      doc.setFillColor(...(index % 2 ? [247, 249, 247] : [238, 244, 239]));
      doc.rect(margin, y, contentWidth, rowHeight, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(...green);
      doc.text(label.toUpperCase(), margin + 4, y + 6);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(...ink);
      doc.text(valueLines, margin + labelWidth, y + 6);
      y += rowHeight;
    });
    y += 7;
  };
  const bullets = (items) => {
    items.forEach((item) => {
      const lines = doc.splitTextToSize(item, contentWidth - 9);
      ensureSpace(lines.length * 5 + 3);
      doc.setFillColor(...gold);
      doc.circle(margin + 2, y - 1.2, 1.2, "F");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(...ink);
      doc.text(lines, margin + 7, y);
      y += lines.length * 5 + 3;
    });
    y += 3;
  };

  const results = payload.type === "batch" ? payload.results : [payload.result];
  const highConfidence = results.filter((result) => !isUncertain(result));
  const lowConfidence = results.filter(isUncertain);
  const affected = highConfidence.filter((result) => String(result.class).toLowerCase() !== "healthy");
  const dominant = payload.type === "batch"
    ? Object.entries(payload.summary || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || "undetermined"
    : payload.result.class;
  const averageConfidence = results.length
    ? results.reduce((sum, result) => sum + Number(result.confidence || 0), 0) / results.length
    : 0;
  const measuredSeverities = results.map((result) => result.severity_pct).filter((value) => value != null);
  const averageSeverity = measuredSeverities.length
    ? measuredSeverities.reduce((sum, value) => sum + Number(value), 0) / measuredSeverities.length
    : null;
  const diseaseRate = highConfidence.length ? affected.length / highConfidence.length * 100 : 0;
  const riskLevel = String(payload.weather?.risk_level || "not assessed").toLowerCase();
  const concern = diseaseRate >= 50 || (averageSeverity ?? 0) >= 25 || ["high", "severe", "critical"].includes(riskLevel);
  const assessment = concern
    ? `Findings indicate elevated crop-health concern. ${affected.length} of ${highConfidence.length} confident sample(s) showed disease. ${lowConfidence.length} low-confidence sample(s) remain unconfirmed.`
    : `Findings indicate generally stable crop health among ${highConfidence.length} confident sample(s). ${lowConfidence.length} low-confidence sample(s) remain unconfirmed and are excluded from disease rates.`;

  doc.setFillColor(...forest);
  doc.rect(0, 0, pageWidth, 62, "F");
  doc.setFillColor(...gold);
  doc.rect(0, 62, pageWidth, 2.5, "F");
  doc.setFont("helvetica", "bold");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(22);
  doc.text("BANANA CROP HEALTH", margin, 25);
  doc.setFontSize(15);
  doc.text("AREA ASSESSMENT REPORT", margin, 36);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(196, 218, 202);
  doc.text("SYMBIOSIS AI-ASSISTED LEAF DIAGNOSTICS", margin, 48);
  doc.text(`Report generated: ${new Date(payload.generated_at).toLocaleString()}`, margin, 55);
  y = 79;

  section("1", "Assessment identification");
  table([
    ["Assessment type", payload.type === "batch" ? "Multi-image area assessment" : "Single-image field observation"],
    ["Location", payload.coordinates ? `${Number(payload.coordinates.lat).toFixed(6)}, ${Number(payload.coordinates.lon).toFixed(6)}` : "Coordinates not recorded"],
    ["Samples assessed", results.length],
    ["Dominant finding", titleCase(dominant)],
    ["Mean confidence", percentage(averageConfidence * 100)],
  ]);

  section("2", "Executive assessment");
  paragraph(assessment);
  if (aiSummary) {
    section("3", "AI analyst explanation");
    paragraph(cleanAi(aiSummary));
  }

  section(aiSummary ? "4" : "3", "Diagnostic findings");
  if (payload.type === "batch") {
    table(Object.entries(payload.summary || {}).map(([classification, count]) => [titleCase(classification), `${count} sample(s) — ${percentage(count / results.length * 100)}`]));
    table([
      ["Disease-positive rate", percentage(diseaseRate)],
      ["Mean measured severity", percentage(averageSeverity)],
    ]);
  } else {
    table([
      ["Classification", isUncertain(payload.result) ? "Unknown — review needed" : titleCase(payload.result.class)],
      ["Model confidence", percentage(payload.result.confidence * 100)],
      ["Estimated severity", percentage(payload.result.severity_pct)],
      ["Model explanation", resultExplanation(payload.result)],
      ["Symptom location", payload.result.symptom_location || "Not determined from this model output"],
    ]);
  }

  section("3A", "Low-confidence review");
  if (lowConfidence.length) {
    lowConfidence.forEach((result) => table([
      ["Status", "Unknown — not confirmed"],
      ["Leading prediction", `${titleCase(result.class)} (${percentage(result.confidence * 100)})`],
      ["Threshold", percentage(result.confidence_threshold * 100)],
      ["Competing scores", predictionSummary(result) || "Not available"],
      ["Review status", titleCase(result.review_status)],
    ]));
    paragraph("Recapture closer, in even light, with sharp focus and the whole affected leaf visible before making treatment decisions.", { color: muted });
  } else paragraph("No low-confidence detections require review.", { color: muted });

  section("4", "Environmental context");
  const weather = payload.weather || {};
  const unavailable = "Not available for this scan";
  table([
    ["Conditions", weather.conditions ? titleCase(weather.conditions) : unavailable],
    ["Temperature", weather.temp == null ? unavailable : `${weather.temp} °C`],
    ["Relative humidity", weather.humidity == null ? unavailable : `${weather.humidity}%`],
    ["Weather-linked risk", weather.risk_level ? titleCase(weather.risk_level) : unavailable],
    ["Risk interpretation", weather.risk_note ? clean(weather.risk_note) : unavailable],
  ]);

  section("5", "Scope and limitations");
  paragraph("This report is an AI-assisted screening assessment based on submitted leaf imagery, recorded coordinates, and available weather data. It is not a laboratory diagnosis, pesticide prescription, or substitute for inspection by a qualified plant pathologist or agricultural extension officer. Confidence scores describe model certainty, not guaranteed biological accuracy.", { color: muted, size: 9 });

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setDrawColor(210, 220, 212);
    doc.line(margin, pageHeight - 14, pageWidth - margin, pageHeight - 14);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.setTextColor(...muted);
    doc.text("SYMBIOSIS • Banana Crop Health Area Assessment", margin, pageHeight - 8);
    doc.text(`Page ${page} of ${pageCount}`, pageWidth - margin, pageHeight - 8, { align: "right" });
  }
}

async function imageDataUrl(url) {
  const response = await fetch(new URL(url, window.location.href));
  if (!response.ok) throw new Error("Image unavailable");
  const blob = await response.blob();
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function downloadDetectionSummary() {
  if (!lastDetectionContext) return;

  const payload = getSummaryPayload();
  const format = exportFormatSelect?.value || "txt";
  const date = new Date().toISOString().slice(0, 10);
  let filename = `symbiosis_detection_${date}.${format}`;

  if (format === "json") {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    downloadBlob(blob, filename);
    return;
  }

  if (format === "txt") {
    let content = "SYMBIOSIS Detection Summary\n\n";
    if (payload.type === "batch") {
      content += "Batch results:\n";
      Object.entries(payload.summary).forEach(([cls, count]) => {
        content += `- ${count} image(s) classified as ${cls}\n`;
      });
    } else {
      content += `Latest result: ${payload.result.class} (${(payload.result.confidence * 100).toFixed(1)}% confidence)\n`;
      content += `Severity: ${payload.result.severity_pct == null ? "N/A" : `${payload.result.severity_pct}%`}\n`;
      if (payload.result.image_url) content += `Image: ${payload.result.image_url}\n`;
    }
    if (payload.weather) {
      content += `\nWeather:\n`;
      content += `Conditions: ${payload.weather.conditions || "unknown"}\n`;
      content += `Temp: ${payload.weather.temp ?? "N/A"}°C\n`;
      content += `Humidity: ${payload.weather.humidity ?? "N/A"}%\n`;
      content += `Risk: ${payload.weather.risk_level || "N/A"}\n`;
      if (payload.weather.risk_note) content += `Note: ${payload.weather.risk_note}\n`;
    }
    if (payload.coordinates) {
      content += `\nCoordinates: ${payload.coordinates.lat.toFixed(6)}, ${payload.coordinates.lon.toFixed(6)}\n`;
    }
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    downloadBlob(blob, filename);
    return;
  }

  if (format === "csv") {
    filename = `symbiosis_detection_${date}.csv`;
    const csv = formatCsv(payload);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, filename);
    return;
  }

  if (format === "pdf") {
    filename = `symbiosis_area_assessment_${date}.pdf`;
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) {
      renderError("PDF export is unavailable because the PDF library did not load. Try JSON, text, CSV, or Excel instead.");
      return;
    }
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const loadingModal = document.getElementById("export-loading-modal");
    const loadingStatus = document.getElementById("export-loading-status");
    loadingModal?.removeAttribute("hidden");
    let aiSummary = "";
    try {
      if (loadingStatus) loadingStatus.textContent = "Fetching environmental context and generating AI explanation…";
      const response = await fetch("/api/report-summary", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context: payload }) });
      const data = await response.json();
      aiSummary = data.summary || "";
    } catch (error) {
      aiSummary = "AI report explanation unavailable.";
    } finally {
      loadingModal?.setAttribute("hidden", "");
    }
    buildAreaAssessment(payload, doc, aiSummary);
    const images = (payload.type === "batch" ? payload.results : [payload.result])
      .filter((result) => result?.image_url)
      .slice(0, 6);
    for (const result of images) {
      try {
        const dataUrl = await imageDataUrl(result.image_url);
        doc.addPage();
        doc.setFont("helvetica", "bold");
        doc.setFontSize(14);
        doc.text(`Associated image — ${result.class}`, 18, 22);
        const imageFormat = dataUrl.startsWith("data:image/png") ? "PNG"
          : dataUrl.startsWith("data:image/webp") ? "WEBP" : "JPEG";
        doc.addImage(dataUrl, imageFormat, 18, 30, 174, 0, undefined, "FAST");
      } catch (error) {
        console.warn("Could not add report image:", error);
      }
    }
    downloadBlob(doc.output("blob"), filename);
    return;
  }

  if (format === "xlsx") {
    filename = `symbiosis_detection_${date}.xlsx`;
    if (!window.XLSX?.utils) {
      renderError("Excel export is unavailable because the spreadsheet library did not load. Try JSON, text, CSV, or PDF instead.");
      return;
    }
    const workbook = XLSX.utils.book_new();
    const sheetData = [];
    if (payload.type === "batch") {
      sheetData.push(["Class", "Count"]);
      Object.entries(payload.summary).forEach(([cls, count]) => sheetData.push([cls, count]));
    } else {
      sheetData.push(["Field", "Value"]);
      sheetData.push(["Class", payload.result.class]);
      sheetData.push(["Confidence", `${(payload.result.confidence * 100).toFixed(1)}%`]);
      sheetData.push(["Severity", payload.result.severity_pct == null ? "N/A" : `${payload.result.severity_pct}%`]);
      sheetData.push(["Image URL", payload.result.image_url || ""]);
    }
    if (payload.weather) {
      sheetData.push([]);
      sheetData.push(["Weather condition", payload.weather.conditions || "unknown"]);
      sheetData.push(["Temperature", payload.weather.temp ?? "N/A"]);
      sheetData.push(["Humidity", payload.weather.humidity ?? "N/A"]);
      sheetData.push(["Risk level", payload.weather.risk_level || "N/A"]);
      sheetData.push(["Risk note", payload.weather.risk_note || ""]);
    }
    if (payload.coordinates) {
      sheetData.push([]);
      sheetData.push(["Latitude", payload.coordinates.lat]);
      sheetData.push(["Longitude", payload.coordinates.lon]);
    }
    const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Summary");
    const wbout = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
    downloadBlob(new Blob([wbout], { type: "application/octet-stream" }), filename);
    return;
  }
}

// ---------------------------------------------------------------------------
// UI polish: mobile nav, scroll progress, header shrink, and scroll-reveal.
// ---------------------------------------------------------------------------
(function uiEnhancements() {
  const topbar = document.getElementById("topbar");
  const navToggle = document.getElementById("nav-toggle");
  const topNav = document.getElementById("top-nav");
  const progress = document.getElementById("scroll-progress");

  if (navToggle && topNav) {
    navToggle.addEventListener("click", () => {
      const isOpen = topNav.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", String(isOpen));
    });
    topNav.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", () => {
        topNav.classList.remove("open");
        navToggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  function onScroll() {
    const y = window.scrollY || document.documentElement.scrollTop;
    if (topbar) topbar.classList.toggle("scrolled", y > 10);
    if (progress) {
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      progress.style.width = max > 0 ? `${(y / max) * 100}%` : "0%";
    }
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );
    document.querySelectorAll(".reveal-once").forEach((el) => observer.observe(el));
  } else {
    document.querySelectorAll(".reveal-once").forEach((el) => el.classList.add("in-view"));
  }

  (function highlightStepDestination() {
    const cards = Array.from(document.querySelectorAll(".steps-grid .step-card"));
    let highlightTimeout = null;

    function targetFor(card) {
      const key = card.dataset.step;
      return key ? document.querySelector(`[data-step-panel="${key}"]`) : null;
    }

    cards.forEach((card) => {
      card.addEventListener("click", () => {
        clearTimeout(highlightTimeout);
        document.querySelectorAll(".step-target-active").forEach((target) => {
          target.classList.remove("step-target-active");
        });
        const target = targetFor(card);
        if (target) {
          target.classList.add("step-target-active");
          highlightTimeout = setTimeout(() => target.classList.remove("step-target-active"), 1500);
        }
      });
    });
  })();
})();

// ---------------------------------------------------------------------------
// GSAP motion system — native UI remains functional if CDN is unavailable.
// ---------------------------------------------------------------------------
(function initBananaModelFallback() {
  const model = document.querySelector(".banana-model");
  const fallback = document.querySelector(".banana-svg-fallback");
  if (!model || !fallback) return;
  model.addEventListener("error", () => {
    model.hidden = true;
    fallback.style.display = "block";
  });
})();

(function initLeafInteraction() {
  if (document.querySelector(".banana-model")) return;
  document.querySelectorAll(".banana-plant .plant-leaf").forEach((leaf) => {
    let startX = 0;
    let startY = 0;

    leaf.addEventListener("pointerdown", (event) => {
      startX = event.clientX;
      startY = event.clientY;
      leaf.setPointerCapture(event.pointerId);
      leaf.style.transition = "none";
    });

    leaf.addEventListener("pointermove", (event) => {
      if (!leaf.hasPointerCapture(event.pointerId)) return;
      const x = Math.max(-34, Math.min(34, (event.clientX - startX) * 0.55));
      const y = Math.max(-24, Math.min(24, (event.clientY - startY) * 0.4));
      leaf.style.transform = `translate(${x}px, ${y}px) rotate(${x * 0.18}deg) scale(1.03)`;
    });

    const release = (event) => {
      if (!leaf.hasPointerCapture(event.pointerId)) return;
      leaf.releasePointerCapture(event.pointerId);
      leaf.style.transition = "transform 650ms cubic-bezier(.2, 1.6, .3, 1)";
      leaf.style.transform = "translate(0, 0) rotate(0) scale(1)";
    };

    leaf.addEventListener("pointerup", release);
    leaf.addEventListener("pointercancel", release);
  });
})();

(function initMotionSystem() {
  if (!window.gsap || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const { gsap } = window;
  if (window.ScrollTrigger) gsap.registerPlugin(window.ScrollTrigger);

  gsap.timeline({ defaults: { ease: "power3.out" } })
    .from(".topbar", { y: -80, autoAlpha: 0, duration: 0.8 })
    .from(".hero .eyebrow", { y: 18, autoAlpha: 0, duration: 0.5 }, "-=0.25")
    .from(".hero-title", { y: 36, autoAlpha: 0, duration: 0.9 }, "-=0.25")
    .from(".hero-sub, .hero-actions, .hero-chips", { y: 24, autoAlpha: 0, duration: 0.65, stagger: 0.1 }, "-=0.5")
    .from(".agri-console", { scale: 0.76, rotationY: -12, autoAlpha: 0, duration: 1.2 }, "-=1.05")
    .from(".banana-plant .plant-leaf", { scale: 0.72, transformOrigin: "50% 80%", autoAlpha: 0, duration: 0.7, stagger: 0.1 }, "-=0.65")
    .from(".banana-bunch", { scale: 0, transformOrigin: "center", duration: 0.55, ease: "back.out(1.8)" }, "-=0.25")
    .from(".data-tag", { x: 18, autoAlpha: 0, duration: 0.5, stagger: 0.12 }, "-=0.45");

  gsap.to(".ring-outer", { rotation: 360, duration: 30, repeat: -1, ease: "none" });
  gsap.to(".ring-mid", { rotation: -360, duration: 22, repeat: -1, ease: "none" });
  if (!document.querySelector(".banana-model")) {
    gsap.to(".banana-plant", { y: -5, rotation: 1.5, transformOrigin: "50% 100%", duration: 3.2, repeat: -1, yoyo: true, ease: "sine.inOut" });
  }
  gsap.fromTo(".scan-line", { y: -100 }, { y: 100, duration: 2.8, repeat: -1, yoyo: true, ease: "sine.inOut" });
  gsap.to(".target-node circle:last-of-type", { scale: 1.5, opacity: 0, transformOrigin: "center", duration: 1.5, repeat: -1, ease: "power1.out" });
  gsap.to(".hero-scroll-cue span", { scaleX: 0.25, duration: 1.2, repeat: -1, yoyo: true, ease: "sine.inOut" });

  if (window.ScrollTrigger) {
    gsap.utils.toArray(".reveal-once").forEach((element) => {
      gsap.fromTo(element, { y: 34, autoAlpha: 0 }, {
        y: 0, autoAlpha: 1, duration: 0.8, ease: "power3.out",
        scrollTrigger: { trigger: element, start: "top 88%", once: true },
      });
    });
    gsap.to(".hero-grid", { yPercent: 18, ease: "none", scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: 1 } });
  }

  document.querySelectorAll(".step-card").forEach((card) => {
    card.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") return;
      const rect = card.getBoundingClientRect();
      gsap.to(card, { rotateX: ((event.clientY - rect.top) / rect.height - 0.5) * -5, rotateY: ((event.clientX - rect.left) / rect.width - 0.5) * 5, transformPerspective: 700, duration: 0.35 });
    });
    card.addEventListener("pointerleave", () => gsap.to(card, { rotateX: 0, rotateY: 0, duration: 0.55, ease: "power3.out" }));
  });
})();