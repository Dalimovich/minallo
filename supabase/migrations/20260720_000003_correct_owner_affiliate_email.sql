-- Correct the owner email used by the preceding grant migration.
update public.profiles
   set status = 'affiliate'
 where id in (
   select id
     from auth.users
    where lower(email) = 'medalimariam@gmail.com'
 );
