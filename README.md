# 100 Days of Spanish 🇪🇸

A two-person accountability app for Martin & Oliver. Log 30 min/day, build a shared
Spanish dictionary from daily reflections, and keep each other honest.

## Run locally

```bash
cd spanish-100
npm install
cp .env.example .env   # then fill in your Supabase URL + service_role key
npm start
```

Open http://localhost:3000. On first load you'll set the challenge start date (defaults
to today). Data lives in **Supabase** (hosted Postgres). Run `schema.sql` once in the
Supabase SQL Editor to create the tables.

## How it works

- **Dashboard** — "Day N / 100", one card per person (today's minutes/30, streak, days done), and a big Start Session button.
- **Timer** — pick Martin or Oliver, a stopwatch counts up, hit Stop to log the session.
- **Reflection** — the first time a person crosses 30 min in a day, a modal pops up: "what's new today?" + 3 words with example sentences. Bonus time after that just logs, no re-prompt.
- **Dictionary** — searchable/filterable table of every word both of you added.
- **Progress** — two 100-cell grids (green = done, red = missed, gray = future, outlined = today) plus streak/completed/missed counts.

## Tech

Node + Express, **Supabase** (hosted Postgres via `@supabase/supabase-js`), plain
HTML/CSS/JS frontend (no build step). Config in `.env` (`SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `PORT`).

## API

| Method | Endpoint | Body / Query |
|---|---|---|
| POST | `/api/sessions` | `{person, duration_seconds}` |
| GET | `/api/today/:person` | — |
| POST | `/api/reflections` | `{person, learned_text, words:[{word,sentence}×3]}` |
| GET | `/api/dictionary` | `?search=&person=` |
| GET | `/api/progress` | — |
| GET / POST | `/api/config` | `{challenge_start_date, reset?}` |

## Deployment

The database is on Supabase, so the app itself is stateless — deploy it anywhere and it
keeps all data. On **Render** (free tier):

- Build command: `npm install`
- Start command: `npm start`
- Environment variables: `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (from Supabase →
  Project Settings → API). Render sets `PORT` automatically.

No persistent disk needed — data lives in Supabase, not on the server's filesystem.
