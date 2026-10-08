-- sanctum-mind v2: a mind may retire an identity core (a cooled, withdrawable declaration with no replacement).
-- Settlement invalidates the core node; nothing is deleted.

alter table proposals
  add column action text not null default 'rewrite' check (action in ('rewrite', 'retire'));
comment on column proposals.action is 'What a declaration does to its target core when it settles: rewrite (supersede it with content) or retire (invalidate it, no replacement).';

comment on column proposals.content is 'The proposed content. For a retire declaration (action = retire) it holds the retired core''s content at declaration time, copied so the declaration is readable.';
