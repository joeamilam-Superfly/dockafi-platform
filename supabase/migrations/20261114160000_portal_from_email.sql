-- Draft sender is aquaease.creations@gmail.com.
-- Production already has this column default. Running this again is safe.

alter table public.email_drafts
  alter column from_address set default 'aquaease.creations@gmail.com';

update public.email_drafts
  set from_address = 'aquaease.creations@gmail.com'
  where from_address = 'support@dockafi.com';

do $rewrite$
declare
  r record;
begin
  for r in
    select pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prokind = 'f'
      and position('support@dockafi.com' in p.prosrc) > 0
  loop
    execute replace(r.def, 'support@dockafi.com', 'aquaease.creations@gmail.com');
  end loop;
end
$rewrite$;
