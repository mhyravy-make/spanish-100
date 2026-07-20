import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { supabase } from './supabase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const DAILY_GOAL = 1800; // 30 minutes in seconds
const PEOPLE = ['Martin', 'Oliver'];

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ---------- date helpers (server-local calendar days) ----------
function todayStr() {
  const d = new Date();
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d - off).toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00');
  const dbb = new Date(b + 'T00:00:00');
  return Math.round((dbb - da) / 86400000);
}

// ---------- config helpers ----------
async function getStartDate() {
  const { data, error } = await supabase.from('config').select('value').eq('key', 'challenge_start_date').maybeSingle();
  if (error) throw error;
  return data ? data.value : null;
}

function currentDayNumber(start) {
  if (!start) return null;
  const n = daysBetween(start, todayStr()) + 1;
  return Math.max(1, Math.min(100, n));
}

// ---------- data helpers ----------
async function dailyTotal(person, date) {
  const { data, error } = await supabase
    .from('sessions')
    .select('duration_seconds')
    .eq('person', person)
    .eq('date', date);
  if (error) throw error;
  return data.reduce((sum, r) => sum + (r.duration_seconds || 0), 0);
}

async function reflectionDone(person, date) {
  const { data, error } = await supabase
    .from('reflections')
    .select('id')
    .eq('person', person)
    .eq('date', date)
    .limit(1);
  if (error) throw error;
  return data.length > 0;
}

// wrap async handlers so thrown errors become 500s instead of hanging
const h = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: 'Server error', detail: err.message });
});

// ---------- API ----------

app.get('/api/config', h(async (req, res) => {
  const start = await getStartDate();
  res.json({ challenge_start_date: start, day: currentDayNumber(start), today: todayStr() });
}));

app.post('/api/config', h(async (req, res) => {
  const existing = await getStartDate();
  const { challenge_start_date, reset } = req.body || {};
  if (existing && !reset) {
    return res.status(409).json({ error: 'Start date already set', challenge_start_date: existing });
  }
  const start = challenge_start_date || todayStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return res.status(400).json({ error: 'Invalid date, expected YYYY-MM-DD' });
  }
  const { error } = await supabase.from('config').upsert({ key: 'challenge_start_date', value: start });
  if (error) throw error;
  res.json({ challenge_start_date: start, day: currentDayNumber(start), today: todayStr() });
}));

app.post('/api/sessions', h(async (req, res) => {
  const { person, duration_seconds } = req.body || {};
  if (!PEOPLE.includes(person)) return res.status(400).json({ error: 'Invalid person' });
  const secs = Math.round(Number(duration_seconds));
  if (!Number.isFinite(secs) || secs <= 0) return res.status(400).json({ error: 'Invalid duration' });

  const date = todayStr();
  const before = await dailyTotal(person, date);
  const alreadyDone = await reflectionDone(person, date);

  const { error } = await supabase.from('sessions').insert({ person, date, duration_seconds: secs });
  if (error) throw error;

  const after = before + secs;
  const crossedThreshold = before < DAILY_GOAL && after >= DAILY_GOAL;
  const shouldReflect = crossedThreshold && !alreadyDone;

  res.json({
    person,
    date,
    daily_total: after,
    goal: DAILY_GOAL,
    completed: after >= DAILY_GOAL,
    reflection_done: alreadyDone,
    should_reflect: shouldReflect,
  });
}));

app.get('/api/today/:person', h(async (req, res) => {
  const { person } = req.params;
  if (!PEOPLE.includes(person)) return res.status(400).json({ error: 'Invalid person' });
  const date = todayStr();
  const total = await dailyTotal(person, date);
  res.json({
    person,
    date,
    daily_total: total,
    goal: DAILY_GOAL,
    completed: total >= DAILY_GOAL,
    reflection_done: await reflectionDone(person, date),
  });
}));

app.post('/api/reflections', h(async (req, res) => {
  const { person, learned_text, words } = req.body || {};
  if (!PEOPLE.includes(person)) return res.status(400).json({ error: 'Invalid person' });
  const date = todayStr();
  if (await reflectionDone(person, date)) {
    return res.status(409).json({ error: 'Reflection already submitted today' });
  }

  const { data: refl, error: rErr } = await supabase
    .from('reflections')
    .insert({ person, date, learned_text: learned_text || '' })
    .select('id')
    .single();
  if (rErr) throw rErr;

  const rows = (Array.isArray(words) ? words : [])
    .filter((w) => w && (w.word || w.sentence))
    .map((w) => ({ reflection_id: refl.id, person, date, word: w.word || '', sentence: w.sentence || '' }));
  if (rows.length) {
    const { error: dErr } = await supabase.from('dictionary_entries').insert(rows);
    if (dErr) throw dErr;
  }
  res.json({ ok: true, reflection_id: refl.id });
}));

app.get('/api/dictionary', h(async (req, res) => {
  const { search, person } = req.query;
  let q = supabase
    .from('dictionary_entries')
    .select('id, word, sentence, person, date')
    .order('date', { ascending: false })
    .order('id', { ascending: false });
  if (person && PEOPLE.includes(person)) q = q.eq('person', person);
  if (search) q = q.ilike('word', `%${search}%`);
  const { data, error } = await q;
  if (error) throw error;
  res.json(data);
}));

app.get('/api/progress', h(async (req, res) => {
  const start = await getStartDate();
  if (!start) return res.json({ start_date: null, day: null, people: {} });

  const today = todayStr();
  const day = currentDayNumber(start);

  const { data: sessions, error } = await supabase.from('sessions').select('person, date, duration_seconds');
  if (error) throw error;

  // Sum per person+date, then keep those that reached the goal
  const totals = new Map();
  for (const s of sessions) {
    const k = s.person + '|' + s.date;
    totals.set(k, (totals.get(k) || 0) + (s.duration_seconds || 0));
  }
  const completedSet = new Set([...totals.entries()].filter(([, t]) => t >= DAILY_GOAL).map(([k]) => k));

  const people = {};
  for (const person of PEOPLE) {
    const cells = [];
    let completedCount = 0;
    let missedCount = 0;
    for (let i = 0; i < 100; i++) {
      const date = addDays(start, i);
      const diff = daysBetween(today, date);
      const isDone = completedSet.has(person + '|' + date);
      let status;
      if (isDone) {
        status = 'completed';
        completedCount++;
      } else if (diff > 0) {
        status = 'future';
      } else if (diff === 0) {
        status = 'today';
      } else {
        status = 'missed';
        missedCount++;
      }
      cells.push({ day: i + 1, date, status });
    }

    // Streak: consecutive completed days ending today or yesterday
    let streak = 0;
    let cursor = completedSet.has(person + '|' + today) ? today : addDays(today, -1);
    if (completedSet.has(person + '|' + cursor)) {
      while (completedSet.has(person + '|' + cursor) && daysBetween(start, cursor) >= 0) {
        streak++;
        cursor = addDays(cursor, -1);
      }
    }

    people[person] = { cells, completed: completedCount, missed: missedCount, streak };
  }

  res.json({ start_date: start, day, today, goal: DAILY_GOAL, people });
}));

app.listen(PORT, () => {
  console.log(`100 Days of Spanish running on http://localhost:${PORT}`);
});
