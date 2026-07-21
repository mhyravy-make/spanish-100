-- Migration 2: add translation + part-of-speech to the dictionary.
-- Paste into the Supabase SQL Editor and click "Run". Safe to re-run.

alter table dictionary_entries add column if not exists translation text;
alter table dictionary_entries add column if not exists part_of_speech text;
