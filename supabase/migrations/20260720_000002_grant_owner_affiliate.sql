-- Grant the requested owner account access to the promoter dashboard.
-- The API still verifies profiles.status = 'affiliate' on every request.
-- Keep this migration safe when it is run manually before the main affiliate
-- migration, which also creates this column idempotently.
alter table public.profiles
  add column if not exists status text not null default 'user';

update public.profiles
   set status = 'affiliate'
 where id in (
   select id
     from auth.users
    where lower(email) = 'medalimariam@gmail.com'
 );
