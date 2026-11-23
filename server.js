// FireWatch IA — backend sin dependencias (Node 20.6+)
// Recibe la consulta del usuario, se la pasa a la IA y la IA decide qué
// datos pedir (focos NASA FIRMS, ubicaciones, clima, imágenes satelitales).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleAuth, currentUser, sameOrigin, GOOGLE_CLIENT_ID, logActivity } from './auth.js';
import { initDatabase, hasPg } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const GROQ_KEY = process.env.GROQ_API_KEY;          // gratis: https://console.groq.com/keys
const XAI_KEY = process.env.XAI_API_KEY;            // Grok: https://console.x.ai
const GEMINI_KEY = process.env.GEMINI_API_KEY;      // https://aistudio.google.com/apikey
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;   // opcional
const FIRMS_KEY = process.env.FIRMS_MAP_KEY;
const KEYS = { groq: GROQ_KEY, grok: XAI_KEY, gemini: GEMINI_KEY, claude: CLAUDE_KEY };
const PROVIDER = process.env.AI_PROVIDER || (GROQ_KEY ? 'groq' : XAI_KEY ? 'grok' : GEMINI_KEY ? 'gemini' : CLAUDE_KEY ? 'claude' : null);
const AI_READY = !!(PROVIDER && KEYS[PROVIDER]);
const FALLBACK_MODEL = process.env.AI_FALLBACK_MODEL || 'gemini-3.5-flash-lite'; // solo Gemini: respaldo si está saturado
const DEFAULT_MODEL = { groq: 'openai/gpt-oss-120b', grok: 'grok-4.3', gemini: 'gemini-3.8-flash', claude: 'claude-sonnet-5-5' };
const MODEL = process.env.AI_MODEL || DEFAULT_MODEL[PROVIDER];

/* ───────────── 1. HERRAMIENTAS QUE LA IA PUEDE USAR ───────────── */

const bboxProps = {
  west: { type: 'number', description: 'Longitud oeste' },
  south: { type: 'number', description: 'Latitud sur' },
  east: { type: 'number', description: 'Longitud este' },
  north: { type: 'number', description: 'Latitud norte' },
};

const TOOLS = [
  {
    name: 'find_place',
    description: 'Busca un lugar (país, provincia, ciudad) y centra el mapa. Devuelve coordenadas y bounding box. Usalo antes de pedir focos si el usuario nombra un lugar.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'find_active_fires',
    description: 'Busca dónde hay focos de calor activos ahora (últimas 24 h) y lleva el mapa a la zona con más actividad. Usalo cuando el usuario pida que lo lleves a algún lugar con focos, o pregunte dónde hay incendios. Parámetro opcional: region (nombre de un país, provincia o continente). Sin parámetros busca en todo el mundo.',
    input_schema: { type: 'object', properties: { region: { type: 'string', description: 'Nombre del lugar, por ejemplo "Bolivia" o "Sudamérica". Omitir para todo el mundo.' } } },
  },
  {
    name: 'get_hotspots',
    description: 'Focos de calor satelitales reales (NASA FIRMS, sensor VIIRS) dentro de un rectángulo. Devuelve estadísticas y los dibuja en el mapa. Máximo 5 días por consulta.',
    input_schema: {
      type: 'object',
      properties: {
        ...bboxProps,
        days: { type: 'integer', minimum: 1, maximum: 5, description: 'Cantidad de días (por defecto 3)' },
        start_date: { type: 'string', description: 'YYYY-MM-DD, primer día. Si se omite, los días más recientes.' },
      },
      required: ['west', 'south', 'east', 'north'],
    },
  },
  {
    name: 'compare_periods',
    description: 'Compara dos fechas en una región: cantidad e intensidad de focos y activa en el mapa el deslizador de imágenes satelitales antes/después.',
    input_schema: {
      type: 'object',
      properties: {
        ...bboxProps,
        date_before: { type: 'string', description: 'YYYY-MM-DD' },
        date_after: { type: 'string', description: 'YYYY-MM-DD' },
        days: { type: 'integer', minimum: 1, maximum: 5, description: 'Días a contar desde cada fecha (por defecto 3)' },
      },
      required: ['west', 'south', 'east', 'north', 'date_before', 'date_after'],
    },
  },
  {
    name: 'get_weather',
    description: 'Clima actual y de los últimos 7 días (temperatura, humedad, viento, lluvia) más pronóstico de 3 días. Sirve para evaluar riesgo de incendio y para el simulador.',
    input_schema: {
      type: 'object',
      properties: { latitude: { type: 'number' }, longitude: { type: 'number' } },
      required: ['latitude', 'longitude'],
    },
  },
];

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(new Date(s)) && new Date(s) <= new Date();

async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': 'FireWatchIA/1.0', ...headers } });
  if (!r.ok) throw new Error(`${new URL(url).host} respondió ${r.status}`);
  return r.json();
}

/* ── NASA FIRMS ── */
// Suomi NPP dejó de entregar datos a FIRMS el 2/11/2026: se usan NOAA-20 y NOAA-21 (mismo sensor VIIRS).
// Datos "NRT" cubren los últimos ~2 meses; más atrás hay que usar el archivo "SP".
const LABEL = { VIIRS_NOAA20_NRT: 'NOAA-20', VIIRS_NOAA21_NRT: 'NOAA-21', VIIRS_NOAA20_SP: 'NOAA-20', VIIRS_NOAA21_SP: 'NOAA-21' };
function sourcesFor(startDate) {
  const old = startDate && (Date.now() - new Date(startDate)) / 864e5 > 50;
  return old ? ['VIIRS_NOAA20_SP', 'VIIRS_NOAA21_SP'] : ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT'];
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
const maxOf = (arr) => arr.reduce((m, v) => (v > m ? v : m), -Infinity);
const minOf = (arr) => arr.reduce((m, v) => (v < m ? v : m), Infinity);
const AREA_GRANDE = 3000; // grados cuadrados; por encima se consulta solo 1 día (y se muestran los focos más intensos)

// Cache de 5 minutos: mover el mapa no vuelve a gastar consultas a NASA
const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

async function getCsv(source, coords, isWorld, days, startDate) {
  let text = '';
  for (const area of isWorld ? [coords, 'world'] : [coords]) {
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${FIRMS_KEY}/${source}/${area}/${days}${startDate ? '/' + startDate : ''}`;
    text = await (await fetch(url, { signal: AbortSignal.timeout(60000) })).text();
    if (text.startsWith('latitude')) return text;
  }
  throw new Error(`${LABEL[source] || source}: ` + (text.trim().slice(0, 120) || 'respuesta vacía'));
}

function parseCsv(text) {
  const [head, ...lines] = text.trim().split('\n');
  const cols = head.trim().split(',');
  const ix = Object.fromEntries(['latitude', 'longitude', 'frp', 'confidence', 'acq_date', 'acq_time', 'daynight'].map((n) => [n, cols.indexOf(n)]));
  const rows = [];
  for (const l of lines) {
    if (!l) continue;
    const f = l.split(',');
    rows.push({
      latitude: +f[ix.latitude], longitude: +f[ix.longitude], frp: +f[ix.frp] || 0,
      confidence: (f[ix.confidence] || '').trim(), acq_date: f[ix.acq_date], acq_time: f[ix.acq_time], daynight: (f[ix.daynight] || '').trim(),
    });
  }
  return rows;
}

async function fetchHotspots(b, days = 3, startDate, { snap = 0 } = {}) {
  if (!FIRMS_KEY) throw new Error('Falta FIRMS_MAP_KEY en el servidor.');
  let west = clamp(b.west, -180, 180), east = clamp(b.east, -180, 180), south = clamp(b.south, -90, 90), north = clamp(b.north, -90, 90);
  if (snap) { // se redondea hacia afuera para reutilizar el cache al desplazar el mapa
    west = clamp(Math.floor(west / snap) * snap, -180, 180); south = clamp(Math.floor(south / snap) * snap, -90, 90);
    east = clamp(Math.ceil(east / snap) * snap, -180, 180); north = clamp(Math.ceil(north / snap) * snap, -90, 90);
  }
  if (![west, east, south, north].every(Number.isFinite) || east <= west || north <= south) throw new Error('Área inválida.');
  const big = (east - west) * (north - south) > AREA_GRANDE;
  if (big) days = 1;
  days = clamp(Math.round(days) || 3, 1, 5);
  const sources = sourcesFor(startDate);
  const coords = [west, south, east, north].join(',');
  const isWorld = east - west >= 359 && north - south >= 179;

  const key = [sources.join('+'), coords, days, startDate || ''].join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;

  // Se consultan los dos satélites a la vez; si uno falla se usa el otro
  const results = await Promise.allSettled(sources.map((src) => getCsv(src, coords, isWorld, days, startDate)));
  const okIdx = results.map((r, i) => (r.status === 'fulfilled' ? i : -1)).filter((i) => i >= 0);
  if (!okIdx.length) throw new Error('NASA FIRMS no entregó datos. ' + results[0].reason.message + ' (revisá FIRMS_MAP_KEY)');
  const rows = [];
  const detalle = results.map((r, i) => {
    if (r.status !== 'fulfilled') return `${LABEL[sources[i]]}: error (${r.reason.message.slice(0, 60)})`;
    const part = parseCsv(r.value);
    for (const x of part) rows.push(x);
    return `${LABEL[sources[i]]}: ${part.length}`;
  });
  const v = { rows, source: 'VIIRS ' + okIdx.map((i) => LABEL[sources[i]]).join(' + '), days, big, bbox: [west, south, east, north], detalle };
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  cache.set(key, { t: Date.now(), v });
  return v;
}

// Zonas (cuadrículas de 5°) con más focos: sirve para que la IA nombre dónde se concentran
function topZones(rows) {
  const c = {};
  for (const r of rows) {
    const k = Math.floor(r.latitude / 5) * 5 + ',' + Math.floor(r.longitude / 5) * 5;
    c[k] = (c[k] || 0) + 1;
  }
  return Object.entries(c).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, n]) => {
    const [la, lo] = k.split(',').map(Number);
    return { centro_lat: la + 2.5, centro_lon: lo + 2.5, focos: n };
  });
}

function summarize(rows) {
  const by = (k) => rows.reduce((a, r) => ((a[r[k]] = (a[r[k]] || 0) + 1), a), {});
  const frp = rows.map((r) => r.frp || 0);
  return {
    total_focos: rows.length,
    por_fecha: by('acq_date'),
    por_confianza: by('confidence'), // h = alta, n = nominal, l = baja
    dia_noche: by('daynight'),
    frp_total_MW: Math.round(frp.reduce((a, b) => a + b, 0)),
    frp_max_MW: Math.round(Math.max(0, maxOf(frp))),
  };
}

const toPoints = (rows, max = 400) =>
  [...rows]
    .sort((a, b) => b.frp - a.frp)
    .slice(0, max)
    .map((r) => [r.latitude, r.longitude, r.frp, r.confidence, r.acq_date, r.acq_time]);

/* ── Implementación de cada herramienta ── */
const IMPL = {
  async find_place({ query }, actions) {
    const d = await getJSON('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query));
    if (!d.length) throw new Error('No se encontró ese lugar.');
    const [s, n, w, e] = d[0].boundingbox.map(Number);
    actions.push({ type: 'fitBounds', bbox: [w, s, e, n] });
    return { nombre: d[0].display_name, lat: +d[0].lat, lon: +d[0].lon, bbox: { west: w, south: s, east: e, north: n } };
  },

  async find_active_fires({ region } = {}, actions) {
    let area = { west: -180, south: -90, east: 180, north: 90 };
    if (region && String(region).trim()) {
      const d = await getJSON('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(region));
      if (!d.length) throw new Error('No se encontró la región "' + region + '".');
      const [s, n, w, e] = d[0].boundingbox.map(Number);
      area = { west: w, south: s, east: e, north: n };
    }
    const width = area.east - area.west;
    const { rows, source, detalle } = await fetchHotspots(area, 1, undefined, { snap: width > 30 ? 5 : 1 });
    if (!rows.length) return { fuente: `NASA FIRMS ${source}`, periodo: 'últimas 24 horas', total_focos: 0, nota: 'No hay focos en esa región en este momento.' };
    const zones = topZones(rows);
    const best = zones[0];
    const inZone = rows.filter((r) => Math.abs(r.latitude - best.centro_lat) <= 2.5 && Math.abs(r.longitude - best.centro_lon) <= 2.5);
    const lats = inZone.map((r) => r.latitude), lons = inZone.map((r) => r.longitude);
    actions.push({ type: 'fitBounds', bbox: [minOf(lons) - 0.5, minOf(lats) - 0.5, maxOf(lons) + 0.5, maxOf(lats) + 0.5] });
    actions.push({ type: 'hotspots', points: toPoints(inZone), label: `${inZone.length} focos en la zona` });
    return {
      fuente: `NASA FIRMS ${source}`,
      periodo: 'últimas 24 horas',
      total_focos_en_el_area_consultada: rows.length,
      zona_elegida_con_mas_focos: best,
      otras_zonas_con_focos: zones.slice(1),
      nota: 'El mapa ya se movió a la zona elegida. Nombrá la región con palabras, sin coordenadas.',
    };
  },

  async get_hotspots({ days = 3, start_date, ...bbox }, actions) {
    if (start_date && !isDate(start_date)) throw new Error('Fecha inválida.');
    const { rows, source, days: usedDays, big, bbox: box } = await fetchHotspots(bbox, days, start_date);
    // Sin focos: igual se lleva el mapa a la zona. Con focos, el mapa se acerca a ellos.
    if (!rows.length && !big) actions.push({ type: 'fitBounds', bbox: box });
    const shown = Math.min(rows.length, 400);
    actions.push({ type: 'hotspots', points: toPoints(rows), label: rows.length > shown ? `${rows.length} focos (se muestran los ${shown} más intensos)` : `${rows.length} focos` });
    return {
      fuente: `NASA FIRMS ${source}`,
      dias: usedDays,
      desde: start_date || 'últimos días disponibles',
      ...(big ? { nota: 'Área muy grande: se consultó solo 1 día y se muestran los focos más intensos.', zonas_con_mas_focos: topZones(rows) } : {}),
      ...summarize(rows),
    };
  },

  async compare_periods({ date_before, date_after, days = 3, ...bbox }, actions) {
    if (!isDate(date_before) || !isDate(date_after)) throw new Error('Fechas inválidas (YYYY-MM-DD y no futuras).');
    const [a, b] = await Promise.all([fetchHotspots(bbox, days, date_before), fetchHotspots(bbox, days, date_after)]);
    if (a.big || b.big) throw new Error('Para comparar fechas hace falta una zona acotada (un país, provincia o región). Usá find_place para ubicar el lugar y volvé a llamar.');
    const sa = summarize(a.rows), sb = summarize(b.rows);
    actions.push({ type: 'compare', bbox: b.bbox, before: date_before, after: date_after });
    actions.push({ type: 'hotspots', points: toPoints(b.rows), label: `${b.rows.length} focos (período final)` });
    return {
      fuente: 'NASA FIRMS (focos) + NASA GIBS VIIRS (imágenes en el mapa)',
      antes: { desde: date_before, dias: days, ...sa },
      despues: { desde: date_after, dias: days, ...sb },
      variacion_focos: sa.total_focos ? Math.round(((sb.total_focos - sa.total_focos) / sa.total_focos) * 100) + '%' : 'sin base de comparación',
    };
  },

  async get_weather({ latitude, longitude }) {
    const d = await getJSON(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
        '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,precipitation' +
        '&daily=temperature_2m_max,precipitation_sum,wind_speed_10m_max&past_days=7&forecast_days=3&timezone=auto'
    );
    return { fuente: 'Open-Meteo', actual: d.current, diario: d.daily };
  },
};

/* ───────────── 2. AGENTE DE IA ───────────── */

const systemPrompt = () => `Sos FireWatch IA, un asistente en español rioplatense para monitorear incendios con datos satelitales. Tenés un mapa que se mueve solo hacia lo que mostrás.
Hoy es ${new Date().toISOString().slice(0, 10)}.
Reglas:
- ACTUÁ, no preguntes. Si podés resolver el pedido con las herramientas, hacelo directamente.
- Cuando el usuario nombra un lugar, llamá primero a find_place y después a get_hotspots con el bbox que te devuelve.
- Si pide que lo lleves a algún lugar con focos, o pregunta dónde hay incendios, llamá a find_active_fires (sin parámetros para todo el mundo, o con region="nombre del lugar").
- Usá solo las herramientas provistas: no navegues por internet ni ejecutes código.
- Si no nombra lugar pero quiere ver focos ("mostrame focos", "acá"), llamá a get_hotspots con el área visible del mapa que se te informa, aunque sea enorme: la herramienta lo maneja. Después decí en palabras dónde se concentran los focos.
- Si una herramienta da error, no repitas la misma llamada: explicale al usuario qué pasó con honestidad.
- NUNCA muestres coordenadas, latitudes, longitudes, bounding boxes ni nombres de herramientas. Hablá con nombres de lugares (país, provincia, región, ciudad). Para pasar de coordenadas a nombres usá tu conocimiento geográfico.
- Para cualquier dato real (focos, clima, ubicaciones) usá las herramientas. Nunca inventes cifras ni focos.
- Si no hay focos en esa zona y período, decilo claro y en una frase. No inventes alternativas.
- Un foco de calor es una anomalía térmica vista por satélite: NO es un incendio confirmado. Aclaralo una vez, brevemente.
- Mencioná la fuente (NASA FIRMS) y el período. Si una herramienta falla, decilo con honestidad.
- Prevención y simulador: explicá de forma educativa y cualitativa (con clima real si hay lugar). No es un pronóstico oficial; remití a las alertas oficiales de la zona.
- Nunca des instrucciones para combatir incendios: ante fuego o humo, alejarse y llamar a emergencias locales.
- Respondé corto: párrafos breves, y listas con "- " solo si ayudan. Sin tablas ni encabezados.`;

// Cada proveedor de IA tiene su "adaptador". Para sumar otro, copiá uno de estos.
// Adaptador para APIs con formato OpenAI (chat/completions): Groq, Grok/xAI, OpenRouter, Cerebras, etc.
const openaiLike = ({ label, url, key, keyVar, consoleUrl, preferred = [] }) => {
  let model = null; // modelo elegido automáticamente si el configurado ya no existe
  return {
  fromHistory: (h) => h.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 2000) })),
  appendToLastUser: (msgs, extra) => { msgs.at(-1).content += extra; },
  async call(msgs) {
    const ask = () => fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || MODEL,
        messages: [{ role: 'system', content: systemPrompt() }, ...msgs],
        tools: TOOLS.map(({ name, description, input_schema }) => ({ type: 'function', function: { name, description, parameters: input_schema } })),
      }),
    });
    let r = await ask();
    for (const wait of [1500, 3500, 6000]) {
      if (r.status !== 503 && r.status !== 500) break;
      await new Promise((ok) => setTimeout(ok, wait));
      r = await ask();
    }
    if (r.status === 400) {
      let t = await r.text();
      // Los modelos abiertos a veces arman mal la llamada a la herramienta: se reintenta (y se deja el detalle en la terminal)
      for (let k = 0; k < 2 && t.includes('tool_use_failed'); k++) {
        console.log(`[${label}] tool_use_failed:`, (t.match(/"failed_generation":\s*"(.{0,300})/) || [])[1] || t.slice(0, 300));
        r = await ask();
        if (r.status !== 400) break;
        t = await r.text();
      }
      if (r.status === 400) throw new Error(t.includes('tool_use_failed') ? 'La IA no pudo armar la consulta. Probá reformulando la pregunta.' : `${label} respondió 400: ${t.slice(0, 200)}`);
    }
    if (r.status === 401) throw new Error(`La clave de ${label} (${keyVar}) no es válida.`);
    if (r.status === 402 || r.status === 403) throw new Error(`Tu cuenta de ${label} no tiene créditos o permisos. Revisá ${consoleUrl}.`);
    if (r.status === 429) throw new Error(`Se alcanzó el límite de uso de ${label}. Esperá un minuto y probá de nuevo.`);
    if (r.status === 404) {
      // El modelo fue retirado o renombrado: se pide la lista de modelos y se prueba uno recomendado
      const list = await fetch(url.replace('/chat/completions', '/models'), { headers: { Authorization: 'Bearer ' + key } })
        .then((x) => x.json()).then((x) => (x.data || []).map((m) => m.id)).catch(() => []);
      const pick = preferred.find((p) => list.includes(p));
      if (pick && pick !== (model || MODEL)) {
        model = pick;
        console.log(`Modelo no disponible; usando "${pick}". Para fijarlo, poné AI_MODEL=${pick} en el .env`);
        r = await ask();
      }
      if (r.status === 404) throw new Error(`El modelo "${model || MODEL}" no existe en ${label}. Probá con AI_MODEL=` + (list.slice(0, 6).join(' / ') || 'nombre-del-modelo') + ' en el .env.');
    }
    if (!r.ok) throw new Error(`${label} respondió ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const m = (await r.json()).choices?.[0]?.message;
    if (!m) throw new Error('La IA no devolvió respuesta.');
    const calls = (m.tool_calls || []).map((t) => {
      let args = {};
      try { args = JSON.parse(t.function.arguments || '{}'); } catch {}
      return { id: t.id, name: t.function.name, args };
    });
    return {
      text: m.content || '',
      calls,
      assistantMsg: { role: 'assistant', content: m.content || null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) },
    };
  },
  // un mensaje por cada herramienta usada
  resultsMsg: (calls, outs) => calls.map((c, i) => ({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(outs[i].value) })),
  };
};

const ADAPTERS = {
  groq: openaiLike({ label: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_KEY, keyVar: 'GROQ_API_KEY', consoleUrl: 'console.groq.com', preferred: ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b'] }),
  grok: openaiLike({ label: 'xAI (Grok)', url: 'https://api.x.ai/v1/chat/completions', key: XAI_KEY, keyVar: 'XAI_API_KEY', consoleUrl: 'console.x.ai' }),

  gemini: {
    fromHistory: (h) => h.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content).slice(0, 2000) }] })),
    appendToLastUser: (msgs, extra) => { msgs.at(-1).parts[0].text += extra; },
    async call(msgs) {
      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt() }] },
        tools: [{ functionDeclarations: TOOLS.map(({ name, description, input_schema }) => ({ name, description, parameters: input_schema })) }],
        contents: msgs,
      });
      const ask = (model) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': GEMINI_KEY, 'Content-Type': 'application/json' }, body,
      });
      const busy = (r) => r.status === 503 || r.status === 500;

      // Gemini gratis se satura seguido: reintenta con espera y, si sigue, prueba un modelo de respaldo
      let r = await ask(MODEL);
      for (const wait of [1500, 3500, 6000]) {
        if (!busy(r)) break;
        await new Promise((ok) => setTimeout(ok, wait));
        r = await ask(MODEL);
      }
      if (busy(r) && FALLBACK_MODEL && FALLBACK_MODEL !== MODEL) {
        const r2 = await ask(FALLBACK_MODEL);
        if (r2.ok) r = r2;
      }
      if (busy(r)) throw new Error('Gemini está saturado en este momento (pasa seguido en el plan gratis). Probá de nuevo en unos minutos.');
      if (r.status === 429) throw new Error('Se alcanzó el límite gratuito de Gemini. Esperá un minuto y probá de nuevo.');
      if (!r.ok) throw new Error(`Gemini respondió ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const data = await r.json();
      const content = data.candidates?.[0]?.content;
      if (!content) throw new Error('La IA no devolvió respuesta (' + (data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'sin motivo') + ').');
      const parts = content.parts || [];
      return {
        text: parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('\n'),
        calls: parts.filter((p) => p.functionCall).map((p) => ({ id: p.functionCall.id, name: p.functionCall.name, args: p.functionCall.args || {} })),
        assistantMsg: { ...content, role: 'model' }, // se devuelve tal cual (incluye las firmas de razonamiento)
      };
    },
    resultsMsg: (calls, outs) => ({
      role: 'user',
      parts: calls.map((c, i) => ({
        functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response: outs[i].ok ? { result: outs[i].value } : { error: outs[i].value } },
      })),
    }),
  },

  claude: {
    fromHistory: (h) => h.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 2000) })),
    appendToLastUser: (msgs, extra) => { msgs.at(-1).content += extra; },
    async call(msgs) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: systemPrompt(), tools: TOOLS, messages: msgs }),
      });
      if (!r.ok) throw new Error(`Claude respondió ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const res = await r.json();
      return {
        text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
        calls: res.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input })),
        assistantMsg: { role: 'assistant', content: res.content },
      };
    },
    resultsMsg: (calls, outs) => ({
      role: 'user',
      content: calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(outs[i].value), is_error: !outs[i].ok })),
    }),
  },
};

async function runAgent(history, map) {
  const A = ADAPTERS[PROVIDER];
  const actions = [];
  const msgs = A.fromHistory(history.slice(-12));
  if (map?.bbox) A.appendToLastUser(msgs, `\n\n[Área visible del mapa: west ${map.bbox[0]}, south ${map.bbox[1]}, east ${map.bbox[2]}, north ${map.bbox[3]}]`);

  let lastErr = '';
  for (let i = 0; i < 8; i++) {
    const r = await A.call(msgs);
    msgs.push(r.assistantMsg);
    if (!r.calls.length) return { reply: r.text || '(La IA no devolvió texto, probá de nuevo.)', mapActions: actions };
    const outs = [];
    for (const c of r.calls) {
      try {
        if (!IMPL[c.name]) throw new Error('Herramienta desconocida: ' + c.name);
        outs.push({ ok: true, value: await IMPL[c.name](c.args, actions) });
        console.log(`[IA → ${c.name}] ok`);
      } catch (e) {
        lastErr = e.message;
        console.log(`[IA → ${c.name}] ERROR: ${e.message}`);
        outs.push({ ok: false, value: 'Error: ' + e.message });
      }
    }
    msgs.push(...[].concat(A.resultsMsg(r.calls, outs)));
  }
  return { reply: 'No pude completar la consulta' + (lastErr ? ` (último error: ${lastErr})` : '') + '. Probá de nuevo o con otra pregunta.', mapActions: actions };
}

/* ───────────── 3. SERVIDOR HTTP ───────────── */

const hits = new Map(); // límite simple: 15 consultas por minuto por IP (la IA cuesta plata)
const limited = (ip) => {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 15;
};

// Prueba real de NASA FIRMS al arrancar (Sudamérica, 24 h)
let firmsCheck = { ok: null, msg: 'probando…' };
async function checkFirms() {
  if (!FIRMS_KEY) { firmsCheck = { ok: false, msg: 'falta FIRMS_MAP_KEY en el .env' }; return; }
  try {
    const { rows, detalle } = await fetchHotspots({ west: -75, south: -20, east: -45, north: 5 }, 1);
    firmsCheck = { ok: true, msg: `responde bien (Sudamérica, 24 h → ${detalle.join(' · ')})` + (rows.length ? '' : ' · 0 focos: raro, revisá') };
  } catch (e) { firmsCheck = { ok: false, msg: e.message }; }
  console.log('NASA FIRMS:', firmsCheck.ok ? 'OK, ' : 'PROBLEMA: ', firmsCheck.msg);
}

const liveHits = new Map(); // el mapa en vivo no usa IA, pero igual se limita
const liveLimited = (ip) => {
  const now = Date.now();
  const arr = (liveHits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  liveHits.set(ip, arr);
  return arr.length > 90;
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    try {
      if (await handleAuth(req, res)) return; // /api/config, /api/me, /api/auth/*

      if (req.method === 'GET' && req.url === '/api/status') return send(res, 200, { ai: AI_READY, firms: !!FIRMS_KEY, firms_check: firmsCheck, provider: PROVIDER, model: MODEL, google: !!GOOGLE_CLIENT_ID, postgres: hasPg() });

      // Focos que se dibujan en el mapa al desplazarlo (sin IA: es solo la capa de datos)
      if (req.method === 'GET' && req.url.startsWith('/api/hotspots')) {
        const user = await currentUser(req);
        if (!user) return send(res, 401, { error: 'Iniciá sesión para ver los focos.' });
        if (liveLimited(user.id)) return send(res, 429, { error: 'Demasiadas consultas al mapa, esperá un momento.' });
        const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
        const width = Number(q.east) - Number(q.west);
        try {
          const { rows, source, days, big } = await fetchHotspots(q, Number(q.days) || 2, undefined, { snap: width > 30 ? 5 : width > 8 ? 1 : 0.5 });
          const points = toPoints(rows, 1500);
          return send(res, 200, { total: rows.length, shown: points.length, days, big, source, points });
        } catch (e) { return send(res, 502, { error: e.message }); }
      }

      if (req.method === 'POST' && req.url === '/api/chat') {
        const user = await currentUser(req);
        if (!user) return send(res, 401, { error: 'Iniciá sesión para usar el asistente.' });
        if (!sameOrigin(req)) return send(res, 403, { error: 'Origen no permitido.' });
        if (!AI_READY) return send(res, 503, { error: 'Falta la clave de IA en el servidor: completá GROQ_API_KEY en el archivo .env.' });
        if (limited(user.id)) return send(res, 429, { error: 'Demasiadas consultas, esperá un minuto.' });
        let raw = '';
        for await (const c of req) { raw += c; if (raw.length > 100000) return send(res, 413, { error: 'Mensaje muy largo.' }); }
        const { messages, map } = JSON.parse(raw || '{}');
        if (!Array.isArray(messages) || !messages.length) return send(res, 400, { error: 'Sin mensajes.' });
        await logActivity(user.email, 'chat_query', messages.at(-1)?.content || 'Consulta en chat');
        return send(res, 200, await runAgent(messages, map));
      }

      // Archivos estáticos de /public
      const file = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : path.normalize(req.url.split('?')[0]).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(path.join(__dirname, 'public'))) return send(res, 403, 'Prohibido', 'text/plain');
      send(res, 200, await fs.readFile(file), MIME[path.extname(file)] || 'application/octet-stream');
    } catch (e) {
      send(res, e.code === 'ENOENT' ? 404 : 500, { error: e.code === 'ENOENT' ? 'No encontrado' : e.message });
    }
  })
  .listen(PORT, async () => {
    try {
      const dbOk = await initDatabase();
      console.log('PostgreSQL:', dbOk ? 'conectado y tablas listas' : 'sin DATABASE_URL (modo archivos locales)');
    } catch (e) {
      console.log('PostgreSQL ERROR:', e.message);
    }
    checkFirms();
    if (!GOOGLE_CLIENT_ID) console.log('Aviso: falta GOOGLE_CLIENT_ID; el botón de Google no va a funcionar (ver README).');
    console.log(`FireWatch IA en http://localhost:${PORT}  (IA: ${AI_READY ? PROVIDER + ' / ' + MODEL : 'FALTA clave'} · FIRMS: ${FIRMS_KEY ? 'clave cargada' : 'FALTA clave'})`);
  });
