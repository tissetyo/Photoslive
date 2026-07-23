alter table public.migration_shadow_events
  drop constraint if exists migration_shadow_events_entity_type_check;

alter table public.migration_shadow_events
  add constraint migration_shadow_events_entity_type_check
  check (entity_type in ('audit', 'booth', 'config', 'voucher', 'voucher_event', 'asset', 'session', 'user', 'payment', 'ledger'));

comment on constraint migration_shadow_events_entity_type_check on public.migration_shadow_events is
  'Allowlisted legacy entities accepted by the server-only migration shadow journal.';
