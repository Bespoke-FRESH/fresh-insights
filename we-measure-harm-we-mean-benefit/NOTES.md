# Draft notes — verification status and open items

Working file for the `grade-the-decision` draft. Delete before promoting.

## Status

The essay's load-bearing claims were verified against primary sources on
2026-08-01. The thesis survived an independent seven-question rigor gate that
**killed an earlier version** — see "What was killed" below, because the
history matters for not walking back into it.

## Verified, safe to publish

| Claim | Status |
|---|---|
| AstaBench: 2,404 problems, 11 benchmarks, 57 agents, 22 agent classes | Verified against the PDF, string-matched |
| AstaBench is Allen Institute for AI (35 of 39 authors) | Verified. **Not Anthropic** — an agent mis-attributed this mid-session; it is a live trap |
| Best overall 53.0 ± 2.4; best Data Analysis 33.7 ± 5.1 | Verified, Table 4 |
| All 11 AstaBench benchmarks score the output artifact | Verified exhaustively. The paper partitions all 11 into LLM-judge-vs-rubric or program-vs-reference. "downstream", "user study", "decision quality" appear nowhere in 88pp |
| CORE-Bench follow-up: 2.11× speedup | Verified, arXiv 2606.26158 |
| METR: 19% slower, believed 20% faster | Verified, arXiv 2507.09089 |
| GRADE human IRR kappa 0.66–0.72 (vs 0.27–0.31 intuitive) | Verified, PMID 23623694 |
| URSE-automated: 63.2% agreement, kappa 0.44, 115 Cochrane reviews | Verified, PMID 40194821 |
| EvidenceGrade exists, launched 9–10 Jul 2026, GRADE-derived ladder | Verified, incl. reading the announcement page directly |
| No calibration study for EvidenceGrade | Verified by exhaustive negative search across arXiv, PubMed, Europe PMC, OpenAlex, Crossref, company site |
| Joint Cochrane/Campbell/JBI/CEE position statement | Verified, DOI 10.1002/14651858.ED000178 |
| RAISE fences off cross-study interpretation | Verified |
| Map contains zero nutrition/diet/food entries | Verified by full read of all 31 cards, 27 developments, 60 sources |
| Cochrane Nutrition site states it is no longer maintained | Verified |

## Must fix before promoting

1. **`[^jmir]` and `[^scoping]` need exact citations.** The tool-count gradient
   (18/20/10/1) and the Ismaila scoping review were reported by a research
   agent but I did not personally verify either against the source. The
   18/20/10/1 figure is the essay's arithmetic spine — **do not publish it
   unverified.** If it does not hold up, the section survives without it but
   loses its best line.

2. **Decide on the Traverse Science question.** The map assigns it six of ten
   stages on the strength of one self-authored homepage, and nobody has
   established what it actually does. If it turns out to be a nutrition
   company, the essay's "zero nutrition entries" line needs rewording to "one,
   and the map describes it generically."

3. **Fix "FutureHouse / Edison" on the map.** The Nature paper (s41586-026-10652-y)
   describes a system called **Robin**, not Edison. Edison is FutureHouse's
   commercial spinout. The figure already says Robin; the source map does not.

4. **Link the map** in the "go deeper" list once it has a public URL.

## Known caveats to keep in the text

- The 53.0 figure is a macro-average of incommensurable sub-metrics. Never
  describe it as "solved 53% of problems."
- URSE-automated is **not** EvidenceGrade. The essay compares constructs, not
  products, and says so. Do not let an edit collapse that.
- The Feng et al. clinical evaluation has a real COI (OpenEvidence supplied the
  questions, implemented collection, paid raters) **and** real safeguards
  (independent statistician, pre-specified analysis, no OE-affiliated authors).
  If it goes in a future draft, both halves go in.
- The "29 of 31 make a paper, 2 help someone act" count is our own coding, and
  the essay concedes this in the paragraph where it appears. Keep the concession.

## What was killed, and why

The first thesis was: *trust is the most-claimed and least-verified property in
AI for science — 23 of 31 organizations claim "trusted evidence generation"
while the verification work is nobody's product.*

An independent rigor evaluation returned REVISE-bordering-KILL. Three reasons,
all fatal:

- **The central factual claim was false.** Independent benchmarks are not
  scarce. AstaBench, PaperBench, CORE-Bench, LAB-Bench 2, BixBench,
  ReplicationBench and others are public, several with leaderboards. Asserting
  their absence would have put an arithmetic-branded author on record denying a
  literature one search away.
- **The framing was already published.** Lovén, arXiv:2605.02566 (May 2026),
  argues that what AI made cheap is "a counterfeit of judgment itself," with a
  sharper mechanism. It is also broadly the ICML 2026 position-track consensus.
- **The headline number was a coding artifact.** "23 of 31" measures the map's
  own tagging vocabulary. Four organizations carry byte-identical stage sets;
  image-forensics tools are tagged "trusted evidence generation." The average
  organization is tagged into 4.81 of 10 stages.

The surviving essay cites the benchmarks as evidence rather than denying them,
and moves the claim to what they measure rather than whether they exist.

## Sensitivity check

Clean. No patent material, no undisclosed methodology, no pre-publication
manuscript content. Every claim rests on a public source. FRESH appears only in
the closing line and the site footer.
