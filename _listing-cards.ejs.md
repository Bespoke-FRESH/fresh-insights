<%
// FRESH Insights — clustered listing card template.
// Shows relationships instead of a flat feed:
//   • multi-part SERIES (>=2 parts) -> one container, parts in reading order
//   • a COMPANION note -> nested beneath the article it belongs to
//   • everything else -> a standalone card
// Relationship fields (in each article's frontmatter):
//   series: "<name>"   part: <n>      -> grouped into a series cluster
//   companion: "<parent-slug>"        -> nested under that parent (match on folder slug)
// NOTE: the engine field is `fresh-engines` (plain `engines` is reserved by Quarto).
const engineClass = {
  "Meta-NPS":"eng-metanps", "Dietary Indices":"eng-indices",
  "Usual-Intake":"eng-intake", "Healthfulness Map":"eng-map",
  "Consumer-Expert Misalignment":"eng-misalign",
};
const norm = (s) => String(s).toLowerCase().trim();
const ENGINE_FROM_CAT = {
  "meta-nps":"Meta-NPS","nps":"Meta-NPS","meta-expert-panels":"Meta-NPS",
  "dietary-indices":"Dietary Indices","food-scoring":"Dietary Indices",
  "usual-intake":"Usual-Intake","surveys":"Usual-Intake","healthfulness-map":"Healthfulness Map",
};
const TOPIC_FROM_CAT = {
  "equity":"Equity","measurement":"Measurement","carbohydrate-quality":"Carb Quality",
  "health-gap":"Health Gap","nutrition":"Nutrition","methods":"Methods",
  "framework":"Framework","thought-leadership":"Perspective","food-scoring":"Food Scoring",
};
const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const smart = (s) => esc(s).replace(/---/g,"—").replace(/--/g,"–").replace(/\*([^*]+)\*/g,"<em>$1</em>");
const uniq = (a) => [...new Set(a)];
const slugOf = (p) => {
  p = String(p||"").replace(/\\/g,"/");           // Windows source paths -> posix
  p = p.replace(/\/?index\.(html?|qmd)$/i,"");     // drop trailing index.html / index.qmd
  p = p.replace(/^\.?\//,"").replace(/\/+$/,"");
  const seg = p.split("/"); return seg[seg.length-1];
};

function chipsHtml(item){
  let engines = Array.isArray(item['fresh-engines']) ? item['fresh-engines'].slice() : [];
  let topics  = Array.isArray(item.topics) ? item.topics.slice() : [];
  if(!engines.length && !topics.length && Array.isArray(item.categories)){
    for(const c of item.categories){
      const k = norm(c);
      if(ENGINE_FROM_CAT[k]) engines.push(ENGINE_FROM_CAT[k]);
      else if(TOPIC_FROM_CAT[k]) topics.push(TOPIC_FROM_CAT[k]);
    }
  }
  engines = uniq(engines); topics = uniq(topics);
  if(!engines.length && !topics.length) return "";
  let h = '<div class="fi-chips">';
  for(const e of engines) h += '<span class="fi-chip fi-chip--engine '+(engineClass[e]||'')+'">'+esc(e)+'</span>';
  for(const t of topics)  h += '<span class="fi-chip fi-chip--topic">'+esc(t)+'</span>';
  return h + '</div>';
}

// One card. variant: '' | 'part' | 'companion'
function cardHtml(item, variant, partNum){
  const sub = item['card-subtitle'] ? item['card-subtitle'] : item.subtitle;
  let cls = "fi-card";
  if(variant === 'companion') cls += " fi-card--companion";
  if(variant === 'part')      cls += " fi-card--part";
  let h = '<article class="'+cls+'"><a class="fi-card-link no-external" href="'+item.path+'">';
  if(variant === 'part'){
    h += '<div class="fi-part-badge">Part '+esc(String(partNum))+'</div>';
  } else if(variant === 'companion'){
    h += '<div class="fi-series fi-series--companion"><span class="fi-series-dot"></span>Companion notes</div>';
  }
  h += '<div class="fi-meta">';
  if(item.date) h += '<span class="fi-date">'+esc(item.date)+'</span>';
  if(item.date && item['reading-time']) h += '<span class="fi-meta-sep">&middot;</span>';
  if(item['reading-time']) h += '<span class="fi-rt">'+esc(item['reading-time'])+'</span>';
  h += '</div>';
  h += chipsHtml(item);
  if(item.title) h += '<h3 class="fi-title no-anchor">'+smart(item.title)+'</h3>';
  if(sub)        h += '<p class="fi-sub">'+smart(sub)+'</p>';
  return h + '</a></article>';
}

// Collaborators credited beneath a series cluster, keyed by series name.
// Logos live in resources/img/ (same assets as the Resources "collaborators" strip).
// Path is relative to the listing page (index.qmd / archive.qmd), both at the site root.
const SERIES_COLLABORATORS = {
  "Meta-NPS": [
    // Heights tuned so the WORDMARKS read at the same size: IAFNS's "iafns"
    // fills ~45% of its box (hexagon + padding), NORC's letters fill ~90%,
    // so IAFNS is set ~2x taller to match legibility.
    { name:"IAFNS", href:"https://iafns.org", img:"resources/img/logo_iafns.png",
      alt:"IAFNS — Institute for the Advancement of Food and Nutrition Sciences", h:32 },
    { name:"NORC", href:"https://www.norc.org", img:"resources/img/logo_norc.svg",
      alt:"NORC at the University of Chicago", h:16 },
  ],
};
function collaboratorsHtml(seriesName){
  const cols = SERIES_COLLABORATORS[seriesName];
  if(!cols || !cols.length) return "";
  let h = '<div class="fi-collab"><span class="fi-collab-label">In collaboration with</span>'
        + '<div class="fi-collab-logos">';
  for(const c of cols){
    h += '<a class="fi-collab-logo" href="'+c.href+'" target="_blank" rel="noopener" '
       + 'title="'+esc(c.name)+'"><img src="'+c.img+'" alt="'+esc(c.alt)+'" '
       + 'style="height:'+c.h+'px"></a>';
  }
  return h + '</div></div>';
}

// ---- build clusters from the (date-sorted) items ----
const all = items.slice();
const idx = new Map(); all.forEach((it,i)=>idx.set(it,i));   // original order = newest first
const companionsOf = {};
const mains = [];
for(const it of all){
  const parent = it.companion ? String(it.companion).trim() : "";
  if(parent){ (companionsOf[parent] = companionsOf[parent] || []).push(it); }
  else mains.push(it);
}
const seriesGroups = {};
const singles = [];
for(const it of mains){
  if(it.series){ (seriesGroups[String(it.series)] = seriesGroups[String(it.series)] || []).push(it); }
  else singles.push(it);
}
const clusters = [];
for(const name in seriesGroups){
  const parts = seriesGroups[name].slice().sort((a,b)=>(Number(a.part)||0)-(Number(b.part)||0));
  if(parts.length >= 2) clusters.push({type:'series', name, parts});
  else clusters.push({type:'single', item: parts[0]});
}
for(const it of singles) clusters.push({type:'single', item: it});
const recency = (c) => c.type==='series' ? Math.min(...c.parts.map(p=>idx.get(p))) : idx.get(c.item);
clusters.sort((a,b)=> recency(a)-recency(b));
const companionsFor = (it) => companionsOf[slugOf(it.path)] || [];
%>
```{=html}
<div class="fi-list">
<% for(const c of clusters){ %>
<% if(c.type === 'series'){ %>
  <section class="fi-cluster">
    <header class="fi-cluster-head">
      <span class="fi-series-dot"></span>
      <span class="fi-cluster-name"><%= esc(c.name) %> series</span>
      <span class="fi-cluster-count"><%= c.parts.length %> parts</span>
    </header>
    <%= collaboratorsHtml(c.name) %>
    <div class="fi-cluster-body">
<% for(const p of c.parts){ %>
      <%= cardHtml(p, 'part', p.part) %>
<% for(const comp of companionsFor(p)){ %>
      <div class="fi-companions"><%= cardHtml(comp, 'companion') %></div>
<% } %>
<% } %>
    </div>
  </section>
<% } else { %>
<% const comps = companionsFor(c.item); %>
  <div class="fi-group">
    <%= cardHtml(c.item, '') %>
<% if(comps.length){ %>
    <div class="fi-companions">
<% for(const comp of comps){ %><%= cardHtml(comp, 'companion') %><% } %>
    </div>
<% } %>
  </div>
<% } %>
<% } %>
</div>
```
