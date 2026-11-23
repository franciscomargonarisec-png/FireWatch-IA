// El mapa y el chat arrancan recién cuando el usuario inició sesión (los llama main.js)
window.startFireWatch = function startFireWatch() {
  if (window.__fwStarted) return;
  window.__fwStarted = true;

const $ = (s) => document.querySelector(s);
const history = []; // conversación que se envía al backend

/* ───────── Mapa ───────── */
const map = L.map('map', { zoomControl: false }).setView([-18, -62], 5);
L.control.zoom({ position: 'topleft' }).addTo(map);
const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
const esri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery &copy; Esri' });

const liveLayer = L.layerGroup().addTo(map);   // focos de la vista actual (se actualiza al mover el mapa)
const aiLayer = L.layerGroup().addTo(map);     // focos que la IA destaca en el chat
const liveRenderer = L.canvas({ padding: 0.3 });
L.control.layers({ Calles: streets, Satélite: esri }, { '🔥 Focos en vivo': liveLayer, '✨ Resultados del chat': aiLayer }, { position: 'topleft' }).addTo(map);

const popup = ([lat, lon, frp, conf, date, time]) =>
  `<b>Foco de calor</b><br>${date} ${String(time).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1:$2')} UTC<br>Potencia: ${frp} MW<br>Confianza: ${{ h: 'alta', n: 'normal', l: 'baja' }[conf] || conf}`;

// Capa de resultados del chat: círculos más grandes con borde blanco
function drawHotspots({ points }) {
  aiLayer.clearLayers();
  points.forEach((p) =>
    L.circleMarker([p[0], p[1]], { radius: Math.min(11, 5 + Math.sqrt(p[2] || 1) / 2), color: '#fff', weight: 2, fillColor: '#e5201a', fillOpacity: 0.9 }).bindPopup(popup(p)).addTo(aiLayer)
  );
  // Lleva el mapa hasta los focos
  if (points.length) map.fitBounds(L.latLngBounds(points.map((p) => [p[0], p[1]])).pad(0.2), { maxZoom: 9, animate: false });
}

/* ── Focos en vivo: puntos rojos de la zona que estás mirando ── */
function setBadge(text, warn) {
  const b = $('#badge');
  b.textContent = text;
  b.classList.toggle('warn', !!warn);
  b.classList.remove('hidden');
}
function drawLive(points) {
  liveLayer.clearLayers();
  points.forEach((p) =>
    L.circleMarker([p[0], p[1]], {
      renderer: liveRenderer, radius: Math.min(7, 3 + Math.sqrt(p[2] || 1) / 3), color: '#7a0f0a', weight: 0.6,
      fillColor: '#ff2d1a', fillOpacity: p[3] === 'l' ? 0.45 : 0.85,
    }).bindPopup(popup(p)).addTo(liveLayer)
  );
}
let liveSeq = 0, liveTimer;
async function loadLive() {
  if (!map.hasLayer(liveLayer)) { $('#badge').classList.add('hidden'); return; }
  const b = map.getBounds();
  const w = Math.max(-180, b.getWest()), s = Math.max(-90, b.getSouth()), e = Math.min(180, b.getEast()), n = Math.min(90, b.getNorth());
  if ((e - w) * (n - s) > 9000) { liveSeq++; liveLayer.clearLayers(); setBadge('🔎 Acercate un poco para ver los focos en el mapa'); return; }
  const seq = ++liveSeq;
  setBadge('⏳ Buscando focos…');
  try {
    const r = await fetch('/api/hotspots?' + new URLSearchParams({ west: w, south: s, east: e, north: n, days: 2 }));
    if (r.status === 401) return location.reload();
    const d = await r.json();
    if (seq !== liveSeq) return; // llegó una respuesta vieja: se ignora
    if (!r.ok) throw new Error(d.error || 'Error al consultar NASA');
    drawLive(d.points);
    setBadge(`🔥 ${d.total.toLocaleString('es-AR')} focos en esta vista · últimas ${d.days * 24} h` + (d.total > d.shown ? ` (se muestran los ${d.shown} más intensos)` : ''));
  } catch (err) {
    if (seq !== liveSeq) return;
    liveLayer.clearLayers();
    setBadge('⚠ ' + err.message, true);
  }
}
map.on('moveend', () => { clearTimeout(liveTimer); liveTimer = setTimeout(loadLive, 700); });
map.on('overlayadd', (ev) => ev.layer === liveLayer && loadLive());
map.on('overlayremove', (ev) => ev.layer === liveLayer && ($('#badge').classList.add('hidden'), liveLayer.clearLayers()));
loadLive();

// Imágenes satelitales diarias de NASA GIBS (VIIRS NOAA-20, color real), sin clave
const gibs = (date) =>
  L.tileLayer(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`, {
    maxNativeZoom: 9, maxZoom: 12, attribution: 'Imagery: NASA GIBS',
  });

function startCompare({ bbox, before, after }) {
  closeCompare();
  cmp = { before: gibs(before).addTo(map), after: gibs(after).addTo(map) };
  map.fitBounds([[bbox[1], bbox[0]], [bbox[3], bbox[2]]]);
  $('#cmpBefore').textContent = 'Antes ' + before;
  $('#cmpAfter').textContent = 'Después ' + after;
  $('#cmpSlider').value = 100;
  cmp.after.setOpacity(1);
  $('#compareBar').classList.remove('hidden');
}
function closeCompare() {
  if (!cmp) return;
  map.removeLayer(cmp.before); map.removeLayer(cmp.after);
  cmp = null;
  $('#compareBar').classList.add('hidden');
}
$('#cmpSlider').addEventListener('input', (e) => cmp && cmp.after.setOpacity(e.target.value / 100));
$('#cmpClose').addEventListener('click', closeCompare);

function applyActions(actions = []) {
  actions.forEach((a) => {
    if (a.type === 'fitBounds') map.fitBounds([[a.bbox[1], a.bbox[0]], [a.bbox[3], a.bbox[2]]], { animate: false });
    if (a.type === 'hotspots') drawHotspots(a);
    if (a.type === 'compare') startCompare(a);
  });
}

/* ───────── Chat ───────── */
function render(text) {
  const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return esc
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n');
      if (lines.every((l) => /^\s*[-•*]\s+/.test(l))) return '<ul>' + lines.map((l) => '<li>' + l.replace(/^\s*[-•*]\s+/, '') + '</li>').join('') + '</ul>';
      return '<p>' + lines.join('<br>') + '</p>';
    })
    .join('');
}

function addMsg(text, cls) {
  const d = document.createElement('div');
  d.className = 'msg ' + cls;
  if (cls === 'ai') d.innerHTML = render(text); else d.textContent = text;
  $('#messages').append(d);
  $('#messages').scrollTop = 1e9;
  return d;
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#input').value.trim();
  if (!text) return;
  $('#input').value = '';
  addMsg(text, 'user');
  history.push({ role: 'user', content: text });
  const wait = addMsg('Analizando con datos satelitales…', 'ai');
  wait.classList.add('typing');
  $('#form button').disabled = true;

  try {
    const b = map.getBounds();
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history, map: { bbox: [Math.max(-180, b.getWest()), Math.max(-90, b.getSouth()), Math.min(180, b.getEast()), Math.min(90, b.getNorth())].map((n) => +n.toFixed(3)) } }),
    });
    if (r.status === 401) return location.reload();
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Error del servidor');
    wait.remove();
    addMsg(data.reply, 'ai');
    history.push({ role: 'assistant', content: data.reply });
    applyActions(data.mapActions);
  } catch (err) {
    wait.remove();
    history.pop(); // para no dejar dos mensajes seguidos del usuario
    addMsg(err.message, 'err');
  } finally {
    $('#form button').disabled = false;
    $('#input').focus();
  }
});

// Enter envía, Shift+Enter hace salto de línea; el campo crece solo
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form').requestSubmit(); }
});
$('#input').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; });

// Los botones solo arrancan la frase: igual se resuelve todo con la IA
document.querySelectorAll('.chips button').forEach((b) =>
  b.addEventListener('click', () => { $('#input').value = b.dataset.p; $('#input').focus(); })
);
$('#toggle').addEventListener('click', () => $('#panel').classList.toggle('min'));

/* ───────── Estado de conexión ───────── */
function checkStatus() {
  fetch('/api/status').then((r) => r.json()).then((s) => {
    const missing = [!s.ai && 'GROQ_API_KEY', !s.firms && 'FIRMS_MAP_KEY'].filter(Boolean);
    const el = $('#status');
    if (missing.length) el.textContent = '⚠ falta configurar: ' + missing.join(', ');
    else if (s.firms_check?.ok === false) el.textContent = '⚠ NASA FIRMS: ' + s.firms_check.msg;
    else if (s.firms_check?.ok === null) { el.textContent = '● IA conectada · probando NASA…'; setTimeout(checkStatus, 2500); }
    else el.textContent = '● IA y NASA FIRMS conectados';
  }).catch(() => ($('#status').textContent = '⚠ servidor no disponible'));
}
checkStatus();

// Funciones que usa el menú (main.js)
window.FW = {
  invalidate: () => map.invalidateSize(),
  prefill: (text) => { $('#input').value = text; $('#input').focus(); $('#input').dispatchEvent(new Event('input')); $('#panel').classList.remove('min'); },
};

};
