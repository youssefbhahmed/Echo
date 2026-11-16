-- Allow "unlike" (undo a like) as a feedback type.
alter table public.interactions drop constraint if exists interactions_type_check;
alter table public.interactions add constraint interactions_type_check
  check (type in ('like', 'unlike', 'dislike', 'save', 'unsave', 'skip', 'rate', 'consumed', 'open', 'play'));
