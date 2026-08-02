# LinkedIn — "We Measure Harm, We Mean Benefit"

*Health Gap Part 2. Live: https://insights.freshfoodrecs.com/we-measure-harm-we-mean-benefit/*

*(Rewritten 2026-08-01. The previous draft was written against the abandoned
standalone framing — "How Do You Know It Mattered?", opening on AI peer review,
pointing at a `_drafts/grade-the-decision/` slug that no longer exists. It
contradicted the published essay and was unpostable.)*

**Share image:** `we-measure-harm-we-mean-benefit/img/measurement-gauge.png`

---

## Main post (paste-ready, ~2,150 chars)

There is a weight-loss drug whose FDA label tells the prescriber when to give up on it.

Contrave. Evaluate at 12 weeks. If the patient hasn't lost 5% of their body weight, discontinue — "as it is unlikely that the patient will achieve and sustain clinically meaningful weight loss with continued treatment."

That's a stopping rule. Written by the regulator, printed in the label.

Now put berberine next to it — the supplement marketed for two years as "nature's Ozempic." Same goal. Often the same person, the same month. There is no such sentence anywhere on it, and no mechanism that would ever produce one.

I've spent this month mapping the organizations sitting between published evidence and somebody acting on it, looking for who says stop.

📌 I got this wrong on the first pass, and it's worth saying how.

I wrote that nothing records in advance what would make you stop. That's false, and a careful reader would have caught it. Rheumatology has treat-to-target. Oncology has RECIST. Critical care has the time-limited trial — sixteen specified elements, including what deterioration will look like, agreed before you start.

Medicine says stop all the time. It says it exactly where it has a validated surrogate to say it with.

Which turns the question into an arithmetic one:

🔹 The FDA lists 200+ surrogate endpoints it has accepted as a basis for approval.
🔹 Its Biomarker Qualification Program — the formal route to establishing a new one — has qualified single digits since it began.

The stock of ways to measure benefit is large and essentially fixed. The pipeline for adding to it is closed.

So "stop" is available precisely where somebody already agreed what better means. That covers a great deal of medicine and almost none of health. If you're below the diagnostic threshold, taking something that never sat on an approval pathway, chasing something no biomarker was ever qualified for — energy, sleep, aging well — there is nothing to write a stopping rule against.

Nobody decided that. It's just what got measured.

And I'm standing in it too: FRESH scores foods, and it cannot currently tell you to stop doing what it told you six months ago.

👉 If you're building anywhere near this, the question that separates the serious from the rest isn't how accurate your model is. It's:

**What would your product have to observe to tell someone to stop using it?**

Most can't answer. A few say they never would, which is at least honest.

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

The essay carries its own corrections in the footnotes, including this one — it published with the claim that no stopping rules exist, which was wrong, and the correction is on the page rather than quietly edited.

---

## Notes for posting

- **Lead is the concrete pair, not the abstraction.** The Contrave/berberine
  contrast is the practical example the essays were missing; it does the work
  three paragraphs of framing were doing before.
- **The correction is in the post on purpose.** Publicly owning a wrong claim is
  the voice, and it pre-empts the obvious reply ("treat-to-target exists").
  Burying it would invite the correction to arrive from a stranger instead.
- **Do not lead with the AI/benchmark material.** It's in the essay and it is not
  the hook — this is a health-measurement argument first.
- **The berberine line says "marketed as," not "is."** Keep it that way.
- Numbers are exact and verified: 5%/12 weeks is quoted from the label PDF;
  74,719 is the FY2026 billable-code count from the CMS `icd10cm_order` file.
