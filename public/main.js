// Ingreso / registro / Google, menú y navegación entre vistas
const $ = (s) => document.querySelector(s);
let mode = 'login'; // 'login' | 'register'

async function api(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Ocurrió un error. Probá de nuevo.');
  return d;
}

function showError(msg) {
  const el = $('#authError');
  el.textContent = msg || '';
  el.hidden = !msg;
}

function setMode(m) {
  mode = m;
  $('#tabLogin').classList.toggle('on', m === 'login');
  $('#tabRegister').classList.toggle('on', m === 'register');
  $('#nameRow').hidden = m !== 'register';
  $('#authSubmit').textContent = m === 'login' ? 'Ingresar' : 'Crear cuenta';
  $('#fPass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  showError('');
}
$('#tabLogin').addEventListener('click', () => setMode('login'));
$('#tabRegister').addEventListener('click', () => setMode('register'));

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showError('');
  const email = $('#fEmail').value.trim();
  const password = $('#fPass').value;
  const name = $('#fName').value.trim();
  if (!email || !password) return showError('Completá tu email y tu contraseña.');
  if (mode === 'register' && password.length < 8) return showError('La contraseña debe tener al menos 8 caracteres.');
  $('#authSubmit').disabled = true;
  try {
    const d = await api(mode === 'login' ? '/api/auth/login' : '/api/auth/register', { name, email, password });
    $('#fPass').value = '';
    enter(d.user);
  } catch (err) {
    showError(err.message);
  } finally {
    $('#authSubmit').disabled = false;
  }
});

/* ───────── Menú ───────── */
function showView(v) {
  document.body.classList.toggle('view-info', v === 'info');
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  if (v === 'map') setTimeout(() => window.FW && window.FW.invalidate(), 50); // el mapa necesita recalcular su tamaño al volver
  if (v === 'info') $('#viewInfo').scrollTop = 0;
}
document.querySelectorAll('.nav button').forEach((b) => {
  b.title = b.textContent.trim();
  b.addEventListener('click', () => showView(b.dataset.view));
});

// Botones "Preguntale a la IA": llevan al mapa con la pregunta lista
document.querySelectorAll('[data-ask]').forEach((b) =>
  b.addEventListener('click', () => {
    showView('map');
    setTimeout(() => window.FW.prefill(b.dataset.ask), 80);
  })
);

$('#logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout'); } catch {}
  if (window.google?.accounts?.id) google.accounts.id.disableAutoSelect();
  location.reload();
});

/* ───────── Entrar a la app ───────── */
function enter(user) {
  document.body.classList.add('authed');
  $('#userName').textContent = user.name;
  const img = $('#avatar');
  if (user.picture) { img.src = user.picture; img.hidden = false; } else img.hidden = true;
  showView('map');
  window.startFireWatch();
}

/* ───────── Google ───────── */
async function setupGoogle() {
  let cfg = {};
  try { cfg = await (await fetch('/api/config')).json(); } catch {}
  if (!cfg.googleClientId) { $('#googleNote').hidden = false; return; }
  for (let i = 0; i < 60 && !(window.google && google.accounts && google.accounts.id); i++) await new Promise((r) => setTimeout(r, 100));
  if (!(window.google && google.accounts && google.accounts.id)) {
    $('#googleNote').textContent = 'No se pudo cargar el ingreso con Google. Revisá tu conexión.';
    $('#googleNote').hidden = false;
    return;
  }
  google.accounts.id.initialize({
    client_id: cfg.googleClientId,
    callback: async (resp) => {
      showError('');
      try { enter((await api('/api/auth/google', { credential: resp.credential })).user); }
      catch (err) { showError(err.message); }
    },
  });
  google.accounts.id.renderButton($('#googleBtn'), { type: 'standard', theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', locale: 'es', width: 300 });
}

/* ───────── Inicio: ¿ya hay sesión? ───────── */
(async function init() {
  try {
    const r = await fetch('/api/me');
    if (r.ok) enter((await r.json()).user);
  } catch {}
  document.body.classList.add('ready');
  if (!document.body.classList.contains('authed')) setupGoogle();
})();
