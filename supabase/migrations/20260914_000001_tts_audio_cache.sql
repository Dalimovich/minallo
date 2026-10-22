-- Cache for generated Hören (listening) segment audio. One row per unique
-- (provider, voice, language, text) synthesis — see backend/python-ai/app/
-- services/tts_cache.py, which mirrors the ai_answer_cache hashing/upsert
-- pattern (sha256 of modelVersion+voiceVersion+language+normalizedText).
-- Reordering questions or changing an answer never touches this table;
-- only new spoken text does.
create table if not exists public.tts_audio_cache (
  id uuid primary key default gen_random_uuid(),
  text_hash text not null unique,
  provider text not null,
  voice text not null,
  language text not null,
  storage_path text not null,
  duration_ms integer,
  usage_count integer not null default 1,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);

comment on table public.tts_audio_cache is
  'Content-addressed cache of generated TTS audio (Hören segments). storage_path points into the generated-audio Supabase Storage bucket.';

-- Service-role only — this table is never queried directly by browser
-- clients, same as ai_answer_cache.
alter table public.tts_audio_cache enable row level security;
