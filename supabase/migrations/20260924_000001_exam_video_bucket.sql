-- Private storage bucket for exam video assets (e.g. TestDaF Hören video tasks).
-- Infrastructure only: no rows are inserted here and nothing generates video.
-- Access is service-role only (signed URLs are minted server-side), like generated-audio.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('generated-video', 'generated-video', false, 209715200, array['video/mp4', 'video/webm'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
