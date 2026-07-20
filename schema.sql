-- 100 Days of Spanish — Supabase schema
-- Paste this whole block into the Supabase SQL Editor and click "Run".
-- Safe to re-run: uses "if not exists".

create table if not exists sessions (
  id bigint generated always as identity primary key,
  person text check (person in ('Martin','Oliver')),
  date text,
  duration_seconds integer,
  created_at timestamptz default now()
);

create table if not exists reflections (
  id bigint generated always as identity primary key,
  person text,
  date text,
  learned_text text,
  created_at timestamptz default now()
);

create table if not exists dictionary_entries (
  id bigint generated always as identity primary key,
  reflection_id bigint references reflections(id) on delete cascade,
  person text,
  date text,
  word text,
  sentence text,
  created_at timestamptz default now()
);

create table if not exists config (
  key text primary key,
  value text
);

create index if not exists idx_sessions_person_date on sessions(person, date);
create index if not exists idx_reflections_person_date on reflections(person, date);
create index if not exists idx_dict_word on dictionary_entries(word);
