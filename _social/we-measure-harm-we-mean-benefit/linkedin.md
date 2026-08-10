# LinkedIn — "We Measure Harm, We Mean Benefit"

*Health Gap Part 2. Live: https://insights.freshfoodrecs.com/we-measure-harm-we-mean-benefit/*

*(Rewritten 2026-08-01. The previous draft was written against the abandoned
standalone framing — "How Do You Know It Mattered?", opening on AI peer review,
pointing at a `_drafts/grade-the-decision/` slug that no longer exists. It
contradicted the published essay and was unpostable.)*

**Share image:** `we-measure-harm-we-mean-benefit/img/measurement-gauge.png`

---

## Main post (paste-ready, 2,971 chars / 2,978 counting emoji as surrogate pairs — the 3,000 limit is tight, so re-count after any edit)

There is a weight-loss drug whose FDA label tells the prescriber when to give up on it.

Contrave. Evaluate at 12 weeks. If the patient hasn't lost 5% of body weight, discontinue — "as it is unlikely that the patient will achieve and sustain clinically meaningful weight loss."

A stopping rule, written by the regulator, printed in the label.

Now put berberine next to it, marketed for two years as "nature's Ozempic." No such sentence anywhere on it, and no mechanism that would ever produce one.

Weight loss just makes it easy to see: the same person often chooses between those two in the same month. Swap in sleep, joints, energy, aging, gut health. The shape doesn't change.

So I spent this month mapping everyone between published evidence and somebody acting on it, from discovery to the person actually deciding, looking for who says stop.

📌 The obvious objection: medicine does this all the time. It does.

Rheumatology has treat-to-target. Oncology has RECIST. Critical care has the time-limited trial — sixteen elements, including what deterioration will look like, agreed before you start.

Medicine says stop all the time. It says it exactly where it has a validated surrogate to say it with. And a surrogate isn't a committee agreeing what better means. It's prior trials showing a treatment's effect on some marker carries through to the outcome you cared about.

Which makes the boundary visible:

🔹 FDA's table of accepted surrogate endpoints runs past 200 and grows every six months. Every entry got there because a sponsor wanted an approval.
🔹 The route Congress built for measures anyone could reuse has qualified zero surrogates, ever. It was never tied to user fees or given staff.

So it isn't that benefit turned out to be unmeasurable. New measures arrive where somebody is seeking an approval, and the route built for everyone else was left running on nothing.

Which leaves you, below the diagnostic threshold, taking something that never sat on an approval pathway, chasing something no biomarker was ever qualified for. Nothing to write a stopping rule against.

And I'm standing in it too. Everything I build is designed to tell you what's worth starting. None of it can tell you to stop doing what it told you six months ago.

👉 If you're building anywhere near this, accuracy is the wrong thing to ask first. Ask what the model is accurate about.

A model that knew whether you were better off would tell you to stop, on accuracy alone. Nobody can build it, because there's nothing validated to be accurate against. So we measure what has a ground truth: what's in the food, whether you stayed on it. None of which produces the Contrave sentence.

**What would your product have to observe to tell someone to stop using it?**

Most can't answer. A few say they never would, which is honest.

💡 Information can be health. But only if something is watching for the part that goes right.

📄 Full essay + sources in the comments 👇

[ATTACH IMAGE: measurement-gauge.png — C:/GitHub/fresh-insights/we-measure-harm-we-mean-benefit/img/measurement-gauge.png]

---

## First comment — sources

Part 2 of the Health Gap series. Part 1 counted 74,719 codes in ICD-10-CM for what's wrong with you, against no agreed metric for whether you're healthy.

📄 Part 2: https://insights.freshfoodrecs.com/we-measure-harm-we-mean-benefit/
📄 Part 1: https://insights.freshfoodrecs.com/the-health-gap/

Sources for the specifics above:

• Contrave label (stopping rule, §2.1) — https://www.accessdata.fda.gov/drugsatfda_docs/label/2014/200063s000lbl.pdf
• FDA table of surrogate endpoints accepted for approval — https://www.fda.gov/drugs/development-resources/table-surrogate-endpoints-were-basis-drug-approval-or-licensure
• FDA Biomarker Qualification Program — https://www.fda.gov/drugs/drug-development-tool-ddt-qualification-programs/biomarker-qualification-program
• Treat-to-target in RA (Smolen et al., Ann Rheum Dis 2016;75:3) — https://doi.org/10.1136/annrheumdis-2015-207524
• ATS time-limited trial consensus (Kruser et al., Ann Am Thorac Soc 2024;21:187) — https://doi.org/10.1513/AnnalsATS.202310-925ST
• FDA Sentinel — https://www.sentinelinitiative.org/
• WHO VigiBase (Uppsala Monitoring Centre) — https://who-umc.org/vigibase/

• Biomarker Qualification Program timelines and outcomes (Collins et al., Ther Innov Regul Sci 2026;60:302) — https://doi.org/10.1007/s43441-025-00889-6
• Why the qualification route stalls (Friends of Cancer Research) — https://friendsofcancerresearch.org/blog/data-driven-insights-the-biomarker-qualification-program-takeaways-and-recommendations/

The essay footnotes every number above, and carries its corrections on the page rather than quietly edited.

---

## Notes for posting

- **Lead is the concrete pair, not the abstraction.** The Contrave/berberine
  contrast is the practical example the essays were missing; it does the work
  three paragraphs of framing were doing before.
- **Pre-empt "treat-to-target exists" without confessing to it.** The post has to
  raise the objection itself or a stranger will, but it is a new message and does
  not need to re-litigate what an earlier draft of the essay got wrong. State the
  counter-examples as the obvious objection, answer it, move on. The essay keeps
  its own corrections in its footnotes; the post does not carry them.
- **Do not lead with the AI/benchmark material.** It's in the essay and it is not
  the hook — this is a health-measurement argument first.
- **The berberine line says "marketed as," not "is."** Keep it that way.
- Numbers are exact and verified: 5%/12 weeks is quoted from the label PDF;
  74,719 is the FY2026 billable-code count from the CMS `icd10cm_order` file.
- **Do not reinstate the old "the pipeline is closed" framing.** It read the 200+
  surrogate table against the single-digit qualification count as stock versus
  flow. They are different routes. Surrogates reach acceptance through individual
  drug approval review, so the table keeps growing (updated every six months);
  the Biomarker Qualification Program is the separate general-use route, and it
  has qualified 8 biomarkers, none under its current process, and zero surrogate
  endpoints ever. That near-zero is a funding and incentive failure, not evidence
  that benefit is unmeasurable. Sources are in the essay's `[^biomarker]` note.
