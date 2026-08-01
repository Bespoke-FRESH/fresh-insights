# Map certification — snapshot 2026-08-01

**Verdict: DO NOT PUBLISH.** One or more checks failed.

31 organizations · 27 developments · 60 sources


Mechanical checks only. Conceptual validation — whether these are the right categories, and whether each tag is defensible — needs a reviewer working from `VALIDATION-RUBRIC.md`.


## FAIL


**[E1] 32 of 60 sources (53%) carry no date. Staleness becomes undetectable by construction, and any maturity label resting on them is unauditable.**

- K-Dense | AI Agents for Real Research
- Traverse Science
- Technology | Potato
- Reviewer3: AI Peer Review
- Consensus
- Elicit
- Scite
- Platform | BenchSci

**[E6] 2 entries dated on the snapshot date are the map re-tagging its own cards, counted alongside events in the world. Move to a separate classification_changes array.**

- Reviewer3: Classification change
- ReviewerZero: Classification addition

## WARN


**[S3] 31 of 31 organizations have no stable id. Month-over-month diffs fall back to name matching, which cannot distinguish a rename from a removal plus an addition.**

- K-Dense
- Traverse Science
- Claude Science
- Potato
- Reviewer3
- Consensus
- Elicit
- Scite

**[T1] 15 organizations share 5 identical stage tuples. Identical tag sets across functionally different products suggest a template was applied rather than each entry assessed.**

- BenchSci EMET + Schrodinger Bunsen + Lila Sciences -> Clinical / regulatory translation, Discovery & literature grounding, Execution / lab translation, Experiment design, Summary & synthesis, Trusted evidence generation
- CuspAI + Insilico Medicine -> Clinical / regulatory translation, Discovery & literature grounding, Execution / lab translation, Experiment design, Production, Summary & synthesis, Trusted evidence generation
- ReviewerZero + SciScore + DataSeer + Proofig + ImageTwin -> Peer review, Production, Submission readiness, Trusted evidence generation
- Paperpal + Writefull + Trinka -> Authoring, Production, Submission readiness
- Editorial Manager + OpenReview -> Peer review, Production, Submission readiness

**[T2] Mean 4.81 stages per organization out of 10. The average entry is claimed to occupy a third or more of the lifecycle, which means the taxonomy is not discriminating.**


**[T3] 4 organizations are tagged into more than 60% of all stages. Usually a placeholder for 'large incumbent, not researched'.**

- CuspAI (7)
- Insilico Medicine (7)
- Clarivate (7)
- Digital Science (8)

**[T4] Stage 'Trusted evidence generation' holds 23/31 organizations (74%). A stage most entries qualify for is measuring label elasticity, not market structure. Do not publish this count as a finding.**


**[E4] 25 of 31 organizations (81%) have no corroborating source beyond their own domain.**

- K-Dense
- Traverse Science
- Claude Science
- Potato
- Reviewer3
- Elicit
- Scite
- BenchSci EMET
- Schrodinger Bunsen
- Lila Sciences

**[E7] 19 of 27 developments (70%) fall in 2026-07. That is a recency-weighted search pass, not a trend — the export cannot support any claim that the field is accelerating.**


**[G1] 7 gap claims with no declared coverage block. A gap asserted over territory the map never surveyed is an artifact of omission, and it is the first thing a specialist reader attacks.**

- End-to-end provenance
- Independent scientific-agent benchmarks
- Protocol-to-publication consistency
- Evidence-grade calibration
- Lab interoperability
- Adversarial peer-review evaluation
- Outcome evidence

## INFO


**[T5] 31 organizations carry stage tags with no per-stage justification. Once the generator emits these, this becomes the strongest defence of the taxonomy.**


**[T6] No separation of vendor self-description from assigned stages. Collapsing them is what makes a tag count look like a finding about the world.**


**[E3] 46 of 60 sources (77%) are organizations describing themselves. Defensible for 'what does this product claim to do', not for 'does it work' — tag which question each source answers before quoting the ratio.**

