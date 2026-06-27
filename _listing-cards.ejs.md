<%
// FRESH Insights — custom listing card.
// Layout: meta row (date · reading-time) -> chip strip (engines filled, topics outline) -> title -> subtitle.
// NOTE: the engine field is `fresh-engines` (plain `engines` is a reserved Quarto key and gets polluted).
const engineClass = {
  "Meta-NPS":          "eng-metanps",
  "Dietary Indices":   "eng-indices",
  "Usual-Intake":      "eng-intake",
  "Healthfulness Map": "eng-map",
};
// Fallback: derive chips from `categories` when explicit fields are absent.
const norm = (s) => String(s).toLowerCase().trim();
const ENGINE_FROM_CAT = {
  "meta-nps": "Meta-NPS", "nps": "Meta-NPS", "meta-expert-panels": "Meta-NPS",
  "dietary-indices": "Dietary Indices", "food-scoring": "Dietary Indices",
  "usual-intake": "Usual-Intake", "surveys": "Usual-Intake",
  "healthfulness-map": "Healthfulness Map",
};
const TOPIC_FROM_CAT = {
  "equity": "Equity", "measurement": "Measurement", "carbohydrate-quality": "Carb Quality",
  "health-gap": "Health Gap", "nutrition": "Nutrition", "methods": "Methods",
  "framework": "Framework", "thought-leadership": "Perspective", "food-scoring": "Food Scoring",
};
const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
// Match Pandoc smart punctuation + simple emphasis inside the raw-HTML block.
const smart = (s) => esc(s).replace(/---/g,"—").replace(/--/g,"–").replace(/\*([^*]+)\*/g,"<em>$1</em>");
const uniq = (a) => [...new Set(a)];
%>
```{=html}
<div class="fi-list">
<% for (const item of items) {
  let engines = Array.isArray(item['fresh-engines']) ? item['fresh-engines'].slice() : [];
  let topics  = Array.isArray(item.topics) ? item.topics.slice() : [];
  if (!engines.length && !topics.length && Array.isArray(item.categories)) {
    for (const c of item.categories) {
      const k = norm(c);
      if (ENGINE_FROM_CAT[k]) engines.push(ENGINE_FROM_CAT[k]);
      else if (TOPIC_FROM_CAT[k]) topics.push(TOPIC_FROM_CAT[k]);
    }
  }
  engines = uniq(engines); topics = uniq(topics);
  const series = item.series ? String(item.series) : "";
  const part = (item.part !== undefined && item.part !== null) ? String(item.part) : "";
  const companion = item.companion ? String(item.companion) : "";
  const sub = item['card-subtitle'] ? item['card-subtitle'] : item.subtitle;
%>
  <article class="fi-card<%= companion ? ' fi-card--companion' : '' %>">
    <a class="fi-card-link no-external" href="<%- item.path %>">
      <% if (series) { %>
      <div class="fi-series"><span class="fi-series-dot"></span><%= esc(series) %> series<% if (part) { %> &middot; Part <%= esc(part) %><% } %></div>
      <% } else if (companion) { %>
      <div class="fi-series fi-series--companion"><span class="fi-series-dot"></span>Companion notes</div>
      <% } %>
      <div class="fi-meta">
        <% if (item.date) { %><span class="fi-date"><%= esc(item.date) %></span><% } %>
        <% if (item.date && item['reading-time']) { %><span class="fi-meta-sep">&middot;</span><% } %>
        <% if (item['reading-time']) { %><span class="fi-rt"><%= esc(item['reading-time']) %></span><% } %>
      </div>
      <% if (engines.length || topics.length) { %>
      <div class="fi-chips">
        <% for (const e of engines) { %><span class="fi-chip fi-chip--engine <%= engineClass[e] || '' %>"><%= esc(e) %></span><% } %>
        <% for (const t of topics) { %><span class="fi-chip fi-chip--topic"><%= esc(t) %></span><% } %>
      </div>
      <% } %>
      <% if (item.title) { %><h3 class="fi-title no-anchor"><%= smart(item.title) %></h3><% } %>
      <% if (sub) { %><p class="fi-sub"><%= smart(sub) %></p><% } %>
    </a>
  </article>
<% } %>
</div>
```
