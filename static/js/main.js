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
  style: "https://tiles.openfreemap.org/styles/dark",
  center: [125.1716, 6.1164],
  zoom: 12,
  pitch: 35,
  bearing: -8,
  attributionControl: false,
});
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

map.on("click", (event) => setCoords(event.lngLat.lat, event.lngLat.lng));

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

function addResultMarker(r, layer) {
  const dot = document.createElement("button");
  dot.type = "button";
  dot.className = "map-result-marker";
  dot.style.setProperty("--marker-color", r.color);
  dot.setAttribute("aria-label", `${r.class} detection`);
  const severityText = r.severity_pct === null || r.severity_pct === undefined
    ? "N/A (classification model)"
    : `${r.severity_pct}%`;
  const popup = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = r.class;
  popup.appendChild(title);
  const details = document.createElement("div");
  details.textContent = `Confidence: ${(r.confidence * 100).toFixed(1)}% · Severity: ${severityText}`;
  popup.appendChild(details);
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
    if (set.id === activeSetId) {
      setLayerVisible(set.markerLayer, true);
    } else setLayerVisible(set.markerLayer, false);
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
    addResultMarker(data, savedSet.markerLayer);
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
      addResultMarker(r, savedSet.markerLayer);
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
  card.className = "result-card";
  card.dataset.setId = setId;
  card.style.borderLeftColor = r.color;
  const image = document.createElement("img");
  image.src = r.image_url;
  image.alt = "Uploaded banana leaf";
  const meta = document.createElement("div");
  meta.className = "result-meta";
  const className = document.createElement("div");
  className.className = "result-class";
  className.textContent = r.class;
  const confidence = document.createElement("div");
  confidence.className = "result-sub";
  confidence.textContent = `Confidence ${(r.confidence * 100).toFixed(1)}% · severity ${severityText}`;
  meta.append(className, confidence);
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
  } else {
    payload.type = "single";
    payload.result = {
      class: context.class,
      confidence: context.confidence,
      severity_pct: context.severity_pct,
      image_url: context.image_url,
      color: context.color,
    };
  }

  return payload;
}

function formatCsv(payload) {
  const rows = [];
  if (payload.type === "batch") {
    rows.push(["Class", "Count"]);
    Object.entries(payload.summary).forEach(([cls, count]) => rows.push([cls, count]));
  } else {
    rows.push(["Field", "Value"]);
    rows.push(["Class", payload.result.class]);
    rows.push(["Confidence", `${(payload.result.confidence * 100).toFixed(1)}%`]);
    rows.push(["Severity", payload.result.severity_pct == null ? "N/A" : `${payload.result.severity_pct}%`]);
    rows.push(["Image URL", payload.result.image_url || ""]);
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

function buildAreaAssessment(payload, doc) {
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
    const lines = doc.splitTextToSize(text, options.width || contentWidth);
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
  const affected = results.filter((result) => String(result.class).toLowerCase() !== "healthy");
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
  const diseaseRate = results.length ? affected.length / results.length * 100 : 0;
  const riskLevel = String(payload.weather?.risk_level || "not assessed").toLowerCase();
  const concern = diseaseRate >= 50 || (averageSeverity ?? 0) >= 25 || ["high", "severe", "critical"].includes(riskLevel);
  const assessment = concern
    ? `Findings indicate elevated crop-health concern in the assessed area. ${affected.length} of ${results.length} sampled image(s) showed a disease classification, with ${titleCase(dominant)} as the dominant observation. Prompt field verification and targeted management are advised.`
    : `Findings indicate a generally stable crop-health condition within the sampled area. ${affected.length} of ${results.length} image(s) showed a disease classification. Continue routine scouting because this report represents only submitted imagery and current weather context.`;

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

  section("3", "Diagnostic findings");
  if (payload.type === "batch") {
    table(Object.entries(payload.summary || {}).map(([classification, count]) => [titleCase(classification), `${count} sample(s) — ${percentage(count / results.length * 100)}`]));
    table([
      ["Disease-positive rate", percentage(diseaseRate)],
      ["Mean measured severity", percentage(averageSeverity)],
    ]);
  } else {
    table([
      ["Classification", titleCase(payload.result.class)],
      ["Model confidence", percentage(payload.result.confidence * 100)],
      ["Estimated severity", percentage(payload.result.severity_pct)],
    ]);
  }

  section("4", "Environmental context");
  if (payload.weather) {
    table([
      ["Conditions", titleCase(payload.weather.conditions)],
      ["Temperature", payload.weather.temp == null ? "Not available" : `${payload.weather.temp} °C`],
      ["Relative humidity", payload.weather.humidity == null ? "Not available" : `${payload.weather.humidity}%`],
      ["Weather-linked risk", titleCase(payload.weather.risk_level)],
      ["Risk interpretation", clean(payload.weather.risk_note)],
    ]);
  } else paragraph("Weather observations were unavailable when this report was generated.", { color: muted });

  section("5", "Recommended actions");
  const actions = [
    "Conduct an on-site inspection around the recorded coordinates and verify symptoms on multiple plants before treatment.",
    concern
      ? "Isolate or mark symptomatic plants, sanitize tools between plants, and prioritize affected blocks for follow-up assessment."
      : "Maintain scheduled scouting and capture repeat images from the same area to identify changes over time.",
    affected.length
      ? `Review disease-specific control guidance for ${titleCase(dominant)} with a qualified agricultural officer before applying chemical treatment.`
      : "Maintain balanced nutrition, drainage, and canopy sanitation to reduce future disease pressure.",
    "Repeat image assessment after field intervention or within 7–14 days, using consistent lighting and close, unobstructed leaf images.",
  ];
  bullets(actions);

  section("6", "Scope and limitations");
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

function downloadDetectionSummary() {
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
    buildAreaAssessment(payload, doc);
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