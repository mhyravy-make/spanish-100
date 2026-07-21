import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from './supabase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Optional: AI-assisted dictionary entries. Works without it — the manual
// "add word" form and everything else run fine when the key is absent.
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const DAILY_GOAL = 1800; // 30 minutes in seconds
const PEOPLE = ['Martin', 'Oliver'];

app.use(express.json());

// API responses must never be cached (browsers were serving stale reads)
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

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
    .select('id, word, translation, part_of_speech, sentence, person, date')
    .order('date', { ascending: false })
    .order('id', { ascending: false });
  if (person && PEOPLE.includes(person)) q = q.eq('person', person);
  if (search) q = q.ilike('word', `%${search}%`);
  const { data, error } = await q;
  if (error) throw error;
  res.json(data);
}));

// Manually add a word to the shared dictionary
const POS = ['noun', 'verb', 'adjective', 'adverb', 'phrase', 'expression', 'other'];
app.post('/api/dictionary', h(async (req, res) => {
  const { person, word, translation, part_of_speech, sentence } = req.body || {};
  if (!PEOPLE.includes(person)) return res.status(400).json({ error: 'Invalid person' });
  if (!word || !word.trim()) return res.status(400).json({ error: 'Word is required' });
  const pos = POS.includes(part_of_speech) ? part_of_speech : 'other';
  const { data, error } = await supabase
    .from('dictionary_entries')
    .insert({
      reflection_id: null,
      person,
      date: todayStr(),
      word: word.trim(),
      translation: (translation || '').trim(),
      part_of_speech: pos,
      sentence: (sentence || '').trim(),
    })
    .select('id, word, translation, part_of_speech, sentence, person, date')
    .single();
  if (error) throw error;
  res.json(data);
}));

// AI: given a Spanish word, return translation + part-of-speech + example sentence
app.post('/api/generate', h(async (req, res) => {
  const word = (req.body && req.body.word ? String(req.body.word) : '').trim();
  if (!word) return res.status(400).json({ error: 'Word is required' });
  if (!anthropic) return res.status(503).json({ error: 'AI is not configured (missing ANTHROPIC_API_KEY)' });

  let msg;
  try {
    msg = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 400,
      system:
        'You help two friends learning Spanish. Given a Spanish word or short phrase, respond with its most common English translation, its part of speech, and one very simple example sentence in Spanish (A1/A2 level, max ~10 words) that naturally uses the word. If the input is a phrase or idiom, use part_of_speech "phrase". Keep it beginner-friendly.',
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              translation: { type: 'string' },
              part_of_speech: { type: 'string', enum: POS },
              sentence: { type: 'string' },
            },
            required: ['translation', 'part_of_speech', 'sentence'],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: 'user', content: `Spanish word or phrase: "${word}"` }],
    });
  } catch (err) {
    console.error('AI generate failed:', err.message);
    const status = err.status === 429 ? 429 : 502;
    return res.status(status).json({ error: 'AI is temporarily unavailable — fill the fields in manually.' });
  }

  const textBlock = msg.content.find((b) => b.type === 'text');
  let out = {};
  try {
    out = JSON.parse(textBlock ? textBlock.text : '{}');
  } catch {
    return res.status(502).json({ error: 'AI returned an unexpected response' });
  }
  res.json({
    translation: out.translation || '',
    part_of_speech: POS.includes(out.part_of_speech) ? out.part_of_speech : 'other',
    sentence: out.sentence || '',
  });
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
