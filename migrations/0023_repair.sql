-- sanctum-mind v2: belief repair. When a node is superseded or retired, the nodes that depended on it are not touched; the
-- deterministic daemon pass notice.repair proposes that the mind look at each of them. The proposal is a noticing of a new
-- kind, 'repair', and inherits every rule of the noticing machinery (migration 0021): it is made in the mind's own scope,
-- decided only by the mind's own mind_notice call, and never applies itself. See CONTRACTS.md, "Belief repair".
--
-- What this file does:
--   1. noticings.kind: the check constraint of 0021 admits link, pattern and distillation. It is dropped and added again
--      with 'repair'. No row changes (kind stays immutable after insert, by the 0021 decision guard), and the insert and
--      decision guards of 0021 apply unchanged: a repair is decided by a notice.accepted event (payload decision: keep,
--      rethink or retire) that the noticing references, with the repair.kept / repair.rethought / repair.retired event as a
--      second event.
--   2. extractor_runs.pass: the check constraint of 0022 admits notice.extract and notice.train. It is replaced to admit
--      notice.repair, which records where its window stopped.
-- Nothing else changes: the new pass reads the graph and writes noticings, notice.proposed events and extractor_runs rows.

alter table noticings drop constraint noticings_kind_check;
alter table noticings add constraint noticings_kind_check check (kind in ('link', 'pattern', 'distillation', 'repair'));

alter table extractor_runs drop constraint extractor_runs_pass_check;
alter table extractor_runs add constraint extractor_runs_pass_check check (pass in ('notice.extract', 'notice.train', 'notice.repair'));

comment on table extractor_runs is 'One row per run of notice.extract, notice.train or notice.repair: when, whether it completed, and counts, a cursor or a short reason in notes. Bookkeeping, not memory.';

comment on table noticings is 'Proposals from the extractor and the repair pass. Never memory: only a verb call by the mind turns one into a node or edge, or a decision about a dependant. After insert only status, decided_event_id and decided_at change, together, once; a decision needs the mind''s own verb call (accept, reject) or the daemon (expire).';
