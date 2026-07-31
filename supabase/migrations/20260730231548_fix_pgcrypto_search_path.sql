-- pgcrypto is installed in the Supabase `extensions` schema.  The account
-- and pairing SECURITY DEFINER functions intentionally use an empty search
-- path, so extension functions must be made visible explicitly.
alter function private.photoslive_next_code(text)
  set search_path = extensions, pg_catalog;

alter function private.photoslive_unique_public_code(text, text, text)
  set search_path = extensions, pg_catalog;

alter function public.photoslive_bootstrap_account(uuid, text, text, text)
  set search_path = extensions, pg_catalog;

alter function public.photoslive_claim_machine(uuid, uuid, text, text, text, text, text, text)
  set search_path = extensions, pg_catalog;
