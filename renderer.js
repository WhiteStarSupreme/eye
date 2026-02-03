const { ipcRenderer } = require("electron");

/* ======================
   PDF.js
====================== */
if (!window.pdfjsLib) {
  document.body.innerHTML =
    "<pre style='color:#fff;padding:16px'>ERREUR: pdfjsLib introuvable. Vérifie index.html : <script src='./vendor/pdf.min.js'></script> AVANT renderer.js</pre>";
  throw new Error("pdfjsLib introuvable");
}

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "./vendor/pdf.worker.min.js",
  window.location.href
).toString();

const url = new URL("./public/Chopin_Preludes_Op28.pdf", window.location.href).toString();

/* ======================
   DOM
====================== */
const viewer = document.getElementById("viewer");
const content = document.getElementById("content");

if (!viewer || !content) {
  document.body.innerHTML =
    "<pre style='color:#fff;padding:16px'>ERREUR: #viewer / #content introuvables. Vérifie index.html</pre>";
  throw new Error("viewer/content introuvables");
}

/* ======================
   STATE
====================== */
let pdfDoc = null;

let fitMode = "width"; // "width" | "height"
let doublePage = false;
let zoom = 1.0;

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3.5;
const PAGE_GAP = 24;

const pageCache = new Map();  // pageNumber -> PDFPageProxy
const pageStates = new Map(); // pageNumber -> state

let observer = null;
let renderVersion = 0;

/* ======================
   HUD + TOOLBAR
====================== */
let hudTimer = null;

function showHUD(text) {
  let hud = document.getElementById("hud");
  if (!hud) {
    hud = document.createElement("div");
    hud.id = "hud";
    hud.style.position = "fixed";
    hud.style.top = "12px";
    hud.style.right = "12px";
    hud.style.zIndex = "9999";
    hud.style.padding = "8px 10px";
    hud.style.borderRadius = "10px";
    hud.style.background = "rgba(0,0,0,0.55)";
    hud.style.border = "1px solid rgba(255,255,255,0.12)";
    hud.style.color = "rgba(255,255,255,0.92)";
    hud.style.fontFamily = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
    hud.style.fontSize = "12px";
    hud.style.backdropFilter = "blur(8px)";
    hud.style.pointerEvents = "none";
    document.body.appendChild(hud);
  }
  hud.textContent = text;
  hud.style.opacity = "1";
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => (hud.style.opacity = "0"), 900);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function pagesInRow() {
  return doublePage ? 2 : 1;
}

function getInnerSize() {
  const cs = getComputedStyle(viewer);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);

  return {
    w: Math.max(1, viewer.clientWidth - padX),
    h: Math.max(1, viewer.clientHeight - padY),
  };
}

function computeScaleFromUnscaled(unscaledW, unscaledH) {
  const { w: vw, h: vh } = getInnerSize();
  const margin = 0.96;

  if (fitMode === "width") {
    const availableWidth = Math.max(
      1,
      (vw * margin) - (pagesInRow() - 1) * PAGE_GAP
    );
    const base = (availableWidth / pagesInRow()) / unscaledW;
    return base * zoom;
  } else {
    const base = (vh * margin) / unscaledH;
    return base * zoom;
  }
}

function isCancelError(err) {
  return (
    err &&
    (err.name === "RenderingCancelledException" ||
      String(err.message || "").toLowerCase().includes("cancel"))
  );
}

function cancelTask(state) {
  if (!state || !state.task) return;
  try { state.task.cancel(); } catch (_) {}
  state.task = null;
}

/* ======================
   Scroll anchor (fix décalage/centre)
   - on garde la page visible + position relative + centre horizontal
====================== */
function captureViewportAnchor() {
  const scrollTop = viewer.scrollTop;
  const scrollW = Math.max(1, viewer.scrollWidth);

  const centerX = viewer.scrollLeft + viewer.clientWidth / 2;
  const xRatio = centerX / scrollW;

  const slots = Array.from(content.querySelectorAll(".page-slot"));
  for (const slot of slots) {
    const top = slot.offsetTop;
    const h = slot.offsetHeight || 1;
    const bottom = top + h;

    if (bottom > scrollTop) {
      const page = Number(slot.dataset.page);
      const relY = clamp((scrollTop - top) / h, 0, 1);
      return { page, relY, xRatio };
    }
  }
  return { page: 1, relY: 0, xRatio: 0.5 };
}

function restoreViewportAnchor(anchor) {
  const slot = content.querySelector(`.page-slot[data-page="${anchor.page}"]`);
  if (!slot) return;

  const maxTop = Math.max(0, viewer.scrollHeight - viewer.clientHeight);
  const maxLeft = Math.max(0, viewer.scrollWidth - viewer.clientWidth);

  // Vertical : même page + même position relative dans la page
  const top = slot.offsetTop + anchor.relY * (slot.offsetHeight || 1);
  viewer.scrollTop = clamp(top, 0, maxTop);

  // Horizontal : on conserve le centre visuel (évite le "part à gauche")
  const desiredCenterX = anchor.xRatio * Math.max(1, viewer.scrollWidth);
  const left = desiredCenterX - viewer.clientWidth / 2;
  viewer.scrollLeft = clamp(left, 0, maxLeft);
}

/* ======================
   UI toolbar
====================== */
function createToolbar() {
  const bar = document.createElement("div");
  bar.id = "toolbar";
  bar.style.position = "fixed";
  bar.style.left = "12px";
  bar.style.top = "12px";
  bar.style.zIndex = "9999";
  bar.style.display = "flex";
  bar.style.gap = "8px";
  bar.style.alignItems = "center";
  bar.style.padding = "10px";
  bar.style.borderRadius = "14px";
  bar.style.background = "rgba(0,0,0,0.55)";
  bar.style.border = "1px solid rgba(255,255,255,0.12)";
  bar.style.backdropFilter = "blur(8px)";
  bar.style.color = "rgba(255,255,255,0.92)";
  bar.style.fontFamily = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto";
  bar.style.fontSize = "12px";

  const mkBtn = (label, onClick) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cursor = "pointer";
    b.style.border = "1px solid rgba(255,255,255,0.14)";
    b.style.background = "rgba(255,255,255,0.06)";
    b.style.color = "rgba(255,255,255,0.92)";
    b.style.padding = "6px 10px";
    b.style.borderRadius = "10px";
    b.onmouseenter = () => (b.style.background = "rgba(255,255,255,0.10)");
    b.onmouseleave = () => (b.style.background = "rgba(255,255,255,0.06)");
    b.onclick = onClick;
    return b;
  };

  const status = document.createElement("span");
  status.id = "status";
  status.style.opacity = "0.85";
  status.style.marginLeft = "6px";

  const updateStatus = () => {
    status.textContent = `${doublePage ? "2p" : "1p"} | fit:${fitMode} | zoom:${Math.round(zoom * 100)}%`;
  };

  const btnLayout = mkBtn("2 pages", () => {
    // comportement attendu : 2 pages => on repart en zoom 100% (sinon tu vois que la gauche)
    commitViewChange("layout", () => {
      doublePage = !doublePage;
      zoom = 1.0;
      btnLayout.textContent = doublePage ? "1 page" : "2 pages";
      applyLayout();
      markAllDirty();
    });
    updateStatus();
  });

  bar.appendChild(mkBtn("Fit W", () => {
    commitViewChange("fit width", () => {
      fitMode = "width";
      zoom = 1.0; // important : fit ignore le zoom manuel
      markAllDirty();
    });
    updateStatus();
  }));

  bar.appendChild(mkBtn("Fit H", () => {
    commitViewChange("fit height", () => {
      fitMode = "height";
      zoom = 1.0; // important : fit ignore le zoom manuel
      markAllDirty();
    });
    updateStatus();
  }));

  bar.appendChild(btnLayout);

  bar.appendChild(mkBtn("−", () => { zoomOut(); updateStatus(); }));
  bar.appendChild(mkBtn("+", () => { zoomIn(); updateStatus(); }));
  bar.appendChild(mkBtn("Reset", () => { zoomReset(); updateStatus(); }));

  updateStatus();
  bar.appendChild(status);
  document.body.appendChild(bar);
}

/* ======================
   Layout + Dirty
====================== */
function applyLayout() {
  content.classList.toggle("double", doublePage);
}

function markAllDirty() {
  renderVersion++;

  for (const st of pageStates.values()) {
    cancelTask(st);
    st.renderedScale = null;

    const w = st.unscaledW ?? st.defaultW;
    const h = st.unscaledH ?? st.defaultH;
    const s = computeScaleFromUnscaled(w, h);

    st.slot.style.width = `${Math.floor(w * s)}px`;
    st.slot.style.height = `${Math.floor(h * s)}px`;
  }
}

/* ======================
   Lazy render
====================== */
async function getPageCached(n) {
  if (pageCache.has(n)) return pageCache.get(n);
  const p = await pdfDoc.getPage(n);
  pageCache.set(n, p);
  return p;
}

async function renderPageIfNeeded(pageNumber) {
  const st = pageStates.get(pageNumber);
  if (!st) return;

  const w = st.unscaledW ?? st.defaultW;
  const h = st.unscaledH ?? st.defaultH;
  const targetScale = computeScaleFromUnscaled(w, h);

  if (st.renderedScale && Math.abs(st.renderedScale - targetScale) < 0.0005) return;

  cancelTask(st);
  const myVersion = renderVersion;

  try {
    const page = await getPageCached(pageNumber);

    if (!st.unscaledW || !st.unscaledH) {
      const unscaled = page.getViewport({ scale: 1 });
      st.unscaledW = unscaled.width;
      st.unscaledH = unscaled.height;
    }

    const scale = computeScaleFromUnscaled(st.unscaledW, st.unscaledH);
    const viewport = page.getViewport({ scale });

    st.slot.style.width = `${Math.floor(viewport.width)}px`;
    st.slot.style.height = `${Math.floor(viewport.height)}px`;

    const canvas = st.canvas;
    const ctx = canvas.getContext("2d", { alpha: false });

    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));

    const task = page.render({ canvasContext: ctx, viewport });
    st.task = task;

    await task.promise;
    if (myVersion !== renderVersion) return;

    st.task = null;
    st.renderedScale = scale;
  } catch (err) {
    if (isCancelError(err)) return;
    console.error("Erreur render page", pageNumber, err);
  }
}

function setupObserver() {
  if (observer) observer.disconnect();

  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const pageNumber = Number(e.target.dataset.page);
        renderPageIfNeeded(pageNumber);
      }
    },
    {
      root: viewer,
      rootMargin: "900px",
      threshold: 0.01,
    }
  );

  for (const st of pageStates.values()) observer.observe(st.slot);
}

function renderVisibleNow() {
  const rect = viewer.getBoundingClientRect();
  const slots = content.querySelectorAll(".page-slot");
  for (const slot of slots) {
    const r = slot.getBoundingClientRect();
    const near = r.bottom > rect.top - 600 && r.top < rect.bottom + 600;
    if (near) renderPageIfNeeded(Number(slot.dataset.page));
  }
}

let renderTimer = null;
function renderVisibleSoon(reason = "") {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    showHUD(`${reason} | ${doublePage ? "2p" : "1p"} | fit:${fitMode} | zoom:${Math.round(zoom * 100)}%`);
    renderVisibleNow();
  }, 40);
}

/* ======================
   Commit view change (anchor safe)
====================== */
function commitViewChange(reason, fn) {
  if (!pdfDoc) return;

  const anchor = captureViewportAnchor();
  fn();

  // restore après que le DOM ait pris les nouvelles tailles
  requestAnimationFrame(() => {
    restoreViewportAnchor(anchor);
    renderVisibleSoon(reason);
  });
}

/* ======================
   Build slots fast
====================== */
async function buildSlots() {
  content.innerHTML = "";
  pageStates.clear();

  const first = await getPageCached(1);
  const firstUnscaled = first.getViewport({ scale: 1 });
  const defaultW = firstUnscaled.width;
  const defaultH = firstUnscaled.height;

  const frag = document.createDocumentFragment();

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const slot = document.createElement("div");
    slot.className = "page-slot";
    slot.dataset.page = String(i);

    const canvas = document.createElement("canvas");
    canvas.className = "page-canvas";
    slot.appendChild(canvas);

    const s = computeScaleFromUnscaled(defaultW, defaultH);
    slot.style.width = `${Math.floor(defaultW * s)}px`;
    slot.style.height = `${Math.floor(defaultH * s)}px`;

    frag.appendChild(slot);

    pageStates.set(i, {
      slot,
      canvas,
      task: null,
      renderedScale: null,
      defaultW,
      defaultH,
      unscaledW: null,
      unscaledH: null,
    });
  }

  content.appendChild(frag);

  applyLayout();
  setupObserver();
  renderVisibleNow();
}

/* ======================
   Zoom API (anchor safe)
====================== */
function setZoom(next, reason = "zoom") {
  const clamped = clamp(next, ZOOM_MIN, ZOOM_MAX);
  if (Math.abs(clamped - zoom) < 0.0001) return;

  commitViewChange(reason, () => {
    zoom = clamped;
    markAllDirty();
  });
}

function zoomIn() { setZoom(zoom * 1.12, "zoom+"); }
function zoomOut() { setZoom(zoom / 1.12, "zoom-"); }

function zoomReset() {
  commitViewChange("reset", () => {
    zoom = 1.0;
    markAllDirty();
  });
}

/* ======================
   Load PDF
====================== */
createToolbar();

content.innerHTML = `<div style="color:#fff;opacity:.85;padding:16px;font-family:monospace">
  Chargement du PDF…
</div>`;

pdfjsLib.getDocument(url).promise
  .then(async (pdf) => {
    pdfDoc = pdf;
    showHUD(`PDF OK: ${pdfDoc.numPages} pages`);
    await buildSlots();
  })
  .catch((err) => {
    console.error("Erreur chargement PDF:", err);
    content.innerHTML = `<pre style="color:#fff;padding:16px;white-space:pre-wrap">${String(err)}</pre>`;
  });

/* ======================
   Inputs (AZERTY friendly)
====================== */
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;

  const tag = e.target?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea") return;

  const k = (e.key || "").toLowerCase();

  if (k === "c") {
    ipcRenderer.send("toggle-fullscreen");
    return;
  }

  if (k === "b") {
    commitViewChange("fit toggle", () => {
      fitMode = fitMode === "width" ? "height" : "width";
      zoom = 1.0;
      markAllDirty();
    });
    return;
  }

  if (k === "p") {
    commitViewChange("layout toggle", () => {
      doublePage = !doublePage;
      zoom = 1.0;
      applyLayout();
      markAllDirty();
      const btns = document.querySelectorAll("#toolbar button");
      if (btns[2]) btns[2].textContent = doublePage ? "1 page" : "2 pages";
    });
    return;
  }

  if (e.code === "NumpadAdd" || e.key === "+" || e.key === "=") zoomIn();
  if (e.code === "NumpadSubtract" || e.key === "-" || e.key === "_") zoomOut();
  if (e.code === "Numpad0" || e.key === "0") zoomReset();
});

// Ctrl + wheel = zoom
viewer.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (e.deltaY > 0) zoomOut();
    else zoomIn();
  },
  { passive: false }
);

// Resize / viewport
window.addEventListener("resize", () => {
  if (!pdfDoc) return;
  commitViewChange("resize", () => markAllDirty());
});

ipcRenderer.on("viewport-changed", () => {
  if (!pdfDoc) return;
  commitViewChange("viewport", () => markAllDirty());
});
