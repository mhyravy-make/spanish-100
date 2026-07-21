const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const api = async (url, opts) => {
  // never serve API reads from cache — a stale GET after a POST caused the
  // setup screen to reappear instead of advancing to the dashboard
  const res = await fetch(url, { cache: 'no-store', ...opts });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON (e.g. cold-start 502) */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
};

const RING_C = 2 * Math.PI * 52; // circumference of r=52 ring ≈ 326.7

const fmtClock = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function setRing(el, pct) {
  el.style.strokeDasharray = RING_C;
  el.style.strokeDashoffset = RING_C * (1 - Math.min(1, pct));
}

let timer = { person: null, seconds: 0, interval: null };

// ---------- toast ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3400);
}

// ---------- tabs ----------
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    $$('.view').forEach((v) => v.classList.remove('active'));
    tab.classList.add('active');
    $('#' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'dictionary') loadDictionary();
    if (tab.dataset.tab === 'progress') loadProgress();
  });
});

// ---------- modal helpers ----------
const show = (id) => ($('#' + id).hidden = false);
const hide = (id) => ($('#' + id).hidden = true);
$$('[data-close]').forEach((b) => b.addEventListener('click', () => (b.closest('.modal-overlay').hidden = true)));
$$('.modal-overlay').forEach((o) =>
  o.addEventListener('click', (e) => {
    if (e.target === o && o.id !== 'setupModal' && o.id !== 'timerModal') o.hidden = true;
  })
);

// ---------- dashboard ----------
async function loadDashboard() {
  const cfg = await api('/api/config');
  if (!cfg.challenge_start_date) {
    $('#setupDate').value = cfg.today;
    show('setupModal');
    return;
  }
  $('#dayNum').textContent = cfg.day;
  $('#daySub').textContent = `Started ${fmtDate(cfg.challenge_start_date)} · ${100 - cfg.day} days to go`;
  $('#challengeFill').style.width = (cfg.day / 100) * 100 + '%';

  const progress = await api('/api/progress');
  for (const person of ['Martin', 'Oliver']) {
    const today = await api('/api/today/' + person);
    const mins = Math.floor(today.daily_total / 60);
    $(`#${person}-mins`).textContent = mins;
    setRing($(`#${person}-ring`), today.daily_total / today.goal);
    const p = progress.people[person] || { streak: 0, completed: 0 };
    $(`#${person}-streak`).textContent = p.streak;
    $(`#${person}-completed`).textContent = p.completed;
    const card = document.querySelector(`.person-card[data-person="${person}"]`);
    const badge = $(`#${person}-badge`);
    if (today.completed) {
      card.classList.add('done');
      badge.textContent = 'Done for today 🎉';
    } else {
      card.classList.remove('done');
      badge.textContent = `${Math.max(0, 30 - mins)} min to go`;
    }
  }
}

// ---------- setup ----------
$('#setupToday').addEventListener('click', () => api('/api/config').then((c) => ($('#setupDate').value = c.today)));
$('#setupSave').addEventListener('click', async () => {
  const date = $('#setupDate').value;
  if (!date) return toast('Pick a start date first');
  const btn = $('#setupSave');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Setting up…';
  try {
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge_start_date: date }),
    });
  } catch (e) {
    if (e.status !== 409) {
      // 409 = start date already set; anything else is a real failure
      btn.disabled = false;
      btn.textContent = original;
      return toast('Could not save — check your connection and try again.');
    }
  }
  btn.disabled = false;
  btn.textContent = original;
  hide('setupModal');
  loadDashboard();
});

// ---------- timer flow ----------
$('#startSessionBtn').addEventListener('click', () => show('personModal'));

$$('[data-pick]').forEach((b) =>
  b.addEventListener('click', () => {
    hide('personModal');
    startTimer(b.dataset.pick);
  })
);

function startTimer(person) {
  timer.person = person;
  timer.seconds = 0;
  $('#timerPerson').textContent = person;
  const av = $('#timerAvatar');
  av.textContent = person[0];
  av.dataset.person = person;
  $('#timerDisplay').textContent = '0:00';
  $('#timerHint').textContent = 'goal 30:00';
  $('#timerHint').classList.remove('reached');
  setRing($('#timerRing'), 0);
  show('timerModal');
  timer.interval = setInterval(() => {
    timer.seconds++;
    $('#timerDisplay').textContent = fmtClock(timer.seconds);
    setRing($('#timerRing'), timer.seconds / 1800);
    if (timer.seconds >= 1800 && !$('#timerHint').classList.contains('reached')) {
      $('#timerHint').textContent = '🎉 goal reached!';
      $('#timerHint').classList.add('reached');
    }
  }, 1000);
}

$('#stopBtn').addEventListener('click', async () => {
  clearInterval(timer.interval);
  hide('timerModal');
  const secs = timer.seconds;
  const person = timer.person;
  if (secs < 1) return;
  let res;
  try {
    res = await api('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ person, duration_seconds: secs }),
    });
  } catch (e) {
    return toast(`⚠️ Couldn't log that ${fmtClock(secs)} session — connection issue. Try again.`);
  }
  if (res.should_reflect) {
    openReflection(person);
  } else {
    const mins = Math.floor(res.daily_total / 60);
    if (res.completed) toast(`✅ Logged! ${person} is at ${mins} min today`);
    else toast(`Logged ${fmtClock(secs)} — ${person}: ${mins}/30 min today`);
  }
  loadDashboard();
});

// ---------- reflection ----------
function openReflection(person) {
  $('#reflPerson').textContent = person;
  $('#reflLearned').value = '';
  $$('#reflectionModal .w-word, #reflectionModal .w-sentence').forEach((i) => (i.value = ''));
  show('reflectionModal');
}

$('#reflSubmit').addEventListener('click', async () => {
  const words = Array.from($$('#reflectionModal .word-row')).map((r) => ({
    word: r.querySelector('.w-word').value.trim(),
    sentence: r.querySelector('.w-sentence').value.trim(),
  }));
  const btn = $('#reflSubmit');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await api('/api/reflections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ person: $('#reflPerson').textContent, learned_text: $('#reflLearned').value.trim(), words }),
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    return toast('Could not save your reflection — try again.');
  }
  btn.disabled = false;
  btn.textContent = original;
  hide('reflectionModal');
  toast('🎉 Day complete! Words added to your dictionary.');
  loadDashboard();
});

// ---------- dictionary ----------
let dictPerson = '';
$('#dictSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  $$('#dictSeg .seg-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  dictPerson = btn.dataset.person;
  loadDictionary();
});

const esc = (s) => (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function loadDictionary() {
  const search = $('#dictSearch').value.trim();
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (dictPerson) params.set('person', dictPerson);
  const rows = await api('/api/dictionary?' + params);
  const grid = $('#dictGrid');
  $('#dictEmpty').hidden = rows.length > 0;
  grid.innerHTML = rows
    .map(
      (r, i) => `
      <div class="word-card" style="animation-delay:${Math.min(i * 30, 300)}ms">
        <div class="word">${esc(r.word)}</div>
        <div class="sentence">"${esc(r.sentence)}"</div>
        <div class="meta"><span class="avatar" data-person="${esc(r.person)}">${esc(r.person[0])}</span> ${esc(r.person)} · ${fmtDate(r.date)}</div>
      </div>`
    )
    .join('');
}
let dictDebounce;
$('#dictSearch').addEventListener('input', () => {
  clearTimeout(dictDebounce);
  dictDebounce = setTimeout(loadDictionary, 200);
});

// ---------- progress ----------
async function loadProgress() {
  const data = await api('/api/progress');
  const container = $('#progressPeople');
  if (!data.start_date) {
    container.innerHTML = '<div class="empty"><div class="empty-emoji">📅</div><p>Set your challenge start date on the dashboard first.</p></div>';
    return;
  }
  container.innerHTML = ['Martin', 'Oliver']
    .map((person) => {
      const p = data.people[person];
      const grid = p.cells
        .map((c) => `<div class="cell ${c.status}" title="Day ${c.day} · ${c.date} · ${c.status}"></div>`)
        .join('');
      return `
      <div class="progress-group">
        <div class="pg-head"><span class="avatar" data-person="${person}">${person[0]}</span><h2>${person}</h2></div>
        <div class="progress-summary">
          <span><b>${p.completed}</b> completed</span>
          <span>🔥 <b>${p.streak}</b> streak</span>
          <span><b>${p.missed}</b> missed</span>
        </div>
        <div class="grid100">${grid}</div>
        <div class="legend">
          <span><i class="dot completed"></i> Completed</span>
          <span><i class="dot missed"></i> Missed</span>
          <span><i class="dot"></i> Future</span>
          <span><i class="dot today"></i> Today</span>
        </div>
      </div>`;
    })
    .join('');
}

// ---------- init ----------
// Retry the first load: Render's free tier can be slow/erroring for a few
// seconds while the service wakes from idle (cold start).
async function initialLoad(attempt = 0) {
  try {
    await loadDashboard();
  } catch (e) {
    if (attempt < 6) {
      if (attempt === 0) toast('Waking up the server…');
      return setTimeout(() => initialLoad(attempt + 1), 2000);
    }
    toast('Having trouble reaching the server. Refresh in a moment.');
  }
}
initialLoad();
