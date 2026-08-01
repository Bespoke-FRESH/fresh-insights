# LinkedIn — "How Do You Know It Mattered?"

Companion to `_drafts/grade-the-decision/index.qmd`.
Share image: `_drafts/grade-the-decision/img/measurement-gauge.png`.

**Do not post before** the tool-count citation in `NOTES.md` is verified and the
essay is promoted with a live URL.

---

## Main post (paste-ready, ~1,900 chars)

Two things happened in AI-for-science this year.

An AI system generated peer reviews for all 22,977 full-review submissions to a
major conference. In under a day. Participants rated them favourably.

A separate team then raised AI reviewer scores by 1.21 points out of 10, with a
75% success rate, by rewriting a paper's presentation. Not the methods. Not the
results. Not one figure, equation, or number.

📌 The field's answer has been better benchmarks. The benchmarks are good.

AstaBench (Allen Institute for AI): 2,400+ problems, 57 agents, public
leaderboard, costs frozen so nobody buys their way up the table. Best agent
scores 53.0. Best score anyone gets on data analysis is 33.7.

Nobody is pretending this is finished. That's real work, honestly reported.

👉 Then look at what all eleven of those benchmarks actually score.

Whether the agent found the right papers. Whether the code ran. Whether the
analysis was correct. Whether the reproduction matched.

Every one scores an artifact the machine produced. Across 88 pages, the words
𝗱𝗼𝘄𝗻𝘀𝘁𝗿𝗲𝗮𝗺, 𝘂𝘀𝗲𝗿 𝘀𝘁𝘂𝗱𝘆 and 𝗱𝗲𝗰𝗶𝘀𝗶𝗼𝗻 𝗾𝘂𝗮𝗹𝗶𝘁𝘆 never appear.

🧭 One team got closer. Posit's bluffbench2 asks whether an agent will tell you
something is wrong with your data when you didn't ask — a stuck sensor, a bad
join, swapped columns, imputed points sitting neatly on a fitted line.

Best models: around 16%.

The finding underneath is sharper. Models often added a fitted line without
being asked — reasonable, idiomatic, defensible — and doing it made them 𝗹𝗲𝘀𝘀
likely to spot the artifact.

The smoother made the picture look like a relationship. The model believed its
own chart.

⚠️ Now ask what happens after.

Did the result change what anyone did? Did the outcome move? Six months on, was
it still true?

For drugs that machinery is enormous. FDA's Sentinel network: ~138.7M members
actively accruing data. WHO's VigiBase: 40M+ reports from 180+ countries.
Running machine learning in production since 2014.

For deployed models there is no equivalent. No VigiBase. No FAERS. And the
failure mode doesn't transfer — a model's performance degrades silently, with no
adverse event for anyone to report. Nobody files a report because an AUC slid
from 0.82 to 0.71.

The Coalition for Health AI tried to build a pre-deployment assurance network.
It collapsed. Their CEO called centralised pre-deployment testing a "misstep,"
and they pivoted to monitoring models 𝗮𝗳𝘁𝗲𝗿 deployment instead.

✅ So if you're doing AI in science, four questions:

🔹 What's your number on a leaderboard you didn't build?
🔹 Can I export the provenance — every assertion traced to a source?
🔹 Has this been tested prospectively, against what we do now?
🔹 Who wrote the questions, and who paid the raters?

None of those is hostile. They're what any of us would want a reviewer to ask,
applied one layer up — to the tool instead of the study.

👉 If you're doing AI in science: how do you know it mattered?

💡 Information can be health. But only after somebody checks whether it changed
anything.

Full essay: [URL]

---

## First comment — citation thread (~1,050 chars)

📚 Sources, in order:

🔹 AAAI-26 AI review pilot (22,977 reviews)
arxiv.org/abs/2604.13940

🔹 Gaming AI review with presentation-only revisions
arxiv.org/abs/2606.13044

🔹 AstaBench — Allen Institute for AI, ICLR 2026
arxiv.org/abs/2510.21652 · leaderboard: allenai.org/asta/leaderboard

🔹 Posit bluffbench2 — will the agent flag the artifact?
github.com/posit-dev/bluffbench2

🔹 METR: developers 19% slower with AI, believed 20% faster
arxiv.org/abs/2507.09089

🔹 Cochrane / Campbell / JBI / CEE joint position statement on AI in
evidence synthesis, and the RAISE recommendations
doi.org/10.1002/14651858.ED000178

🔹 FDA Sentinel scale
sentinelinitiative.org

---

## Second comment — the map + the ask (~600 chars)

🕳️ This came out of maintaining a living map of who's building what across
discovery to translation. Seven categories currently have no entry at all:
systematic review and synthesis, guideline development, provenance
infrastructure, computational reproducibility, open-source research agents,
post-publication integrity, and AI-in-evidence governance.

None of those is an empty field. Cochrane, GRADE, Crossref, CODECHECK, PubPeer
and Retraction Watch are all doing the work — they're just missing from my draft.

If you build in one of these, or I've put you in the wrong box, tell me and I'll
fix it in the next refresh. The map is dated for exactly that reason.

[MAP URL]

---

## Posting notes

- The second comment generates the inbound. Post it right after the first.
- Expect two fair objections: (a) the tool-count gradient is a census of tools,
  not of effort — concede it; (b) RAISE fences off the interpretation step on
  purpose — concede fully, the essay already does, and it sharpens the close
  rather than weakening it.
- Do NOT let the post drift toward "nobody is verifying this." That claim is
  false, it was killed in review, and the essay's credibility rests on citing
  the benchmarks rather than denying them.
- The bluffbench2 `geom_smooth` detail is the most shareable single fact here.
  If the post gets cut for length, cut elsewhere.
