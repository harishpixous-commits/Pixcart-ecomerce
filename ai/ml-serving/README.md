# ml-serving — recommendation serving
FR-AI-003 serving platform enforcing the FR-CUS-013 product rules. Pure domain; the learned
ranker is INJECTED as a scorer function so models can be swapped or shadowed without
touching this logic, and the fallback chain is testable with no model at all.

Two stages + business re-rank:
1. candidate generation — co-visitation / embedding / popularity / personalised pools merged
   with source union; personalised-only candidates DROPPED without consent (BRU-12), and a
   surviving item loses its personalised attribution so the explanation cannot leak history.
2. pre-ranking filters (FR-AI-003 VALIDATION) — LIVE + in-stock + serviceable only, never
   the seed, never an excluded category, fail-closed on unknown ids.
3. ranking with the fallback chain model -> heuristic -> curated, always yielding a slate.
4. business re-rank — per-vendor cap ceil(size/3) forces >=3 distinct vendors in a 10-rail
   whenever the pool allows, with a second pass that backfills to keep the slate full and
   diversityMet reporting the truth; top-1 epsilon guard so the re-rank cannot depress the
   best relevance by more than the configured epsilon.
5. sponsored blend <=20% of the rail, each labelled, never at position 1.

Every organic item carries a "why this" explanation. 21/21 vitest.
The p95-under-60ms target is an infrastructure property of the serving path, not of this
module; what is enforced here are the correctness rules.
