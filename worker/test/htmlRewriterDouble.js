// A test double for the Workers runtime's HTMLRewriter, which Node does not have. It supports exactly
// what src/invitePreview.js uses: selectors of the forms `tag`, `tag[attr="v"]` and `tag[attr^="v"]`,
// and the element operations remove(), prepend(html) and append(html) with { html: true }.
//
// What it does not prove: lol-html's own parsing. The escaping under test is the Worker's (every value is
// escaped before it reaches the rewriter, and inserted as raw HTML), so a test here checks the exact
// bytes the Worker hands the real rewriter. The PR also records one run under `wrangler dev` (workerd).

function parseSelector(sel) {
  const m = /^([a-z]+)(?:\[([a-z:-]+)(\^?=)"([^"]*)"\])?$/.exec(sel);
  if (!m) throw new Error(`double does not support selector ${sel}`);
  const [, tag, attr, op, val] = m;
  return { tag, attr, op, val };
}

function attrOf(tagText, name) {
  const m = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tagText);
  return m ? m[1] : null;
}

function matches(sel, tagText) {
  if (!sel.attr) return true;
  const v = attrOf(tagText, sel.attr);
  if (v === null) return false;
  return sel.op === "=" ? v === sel.val : v.startsWith(sel.val);
}

export class HTMLRewriterDouble {
  constructor() { this.rules = []; }
  on(selector, handlers) { this.rules.push({ sel: parseSelector(selector), handlers }); return this; }
  transform(res) {
    const rules = this.rules;
    const body = res.text().then(html => {
      for (const { sel, handlers } of rules) {
        if (sel.tag === "head") {
          const open = /<head(\s[^>]*)?>/i.exec(html);
          if (!open) continue;
          let before = "", after = "";
          handlers.element({
            prepend: (c, o) => { if (!o?.html) throw new Error("double: text insert"); before = c + before; },
            append: (c, o) => { if (!o?.html) throw new Error("double: text insert"); after += c; },
            remove: () => { throw new Error("double: head remove"); },
          });
          const at = open.index + open[0].length;
          html = html.slice(0, at) + before + html.slice(at);
          html = html.replace(/<\/head>/i, after + "</head>");
        } else {
          const re = sel.tag === "title"
            ? /<title\b[^>]*>[\s\S]*?<\/title>/gi
            : new RegExp(`<${sel.tag}\\b[^>]*>`, "gi");
          html = html.replace(re, tagText => {
            if (!matches(sel, tagText)) return tagText;
            let removed = false;
            handlers.element({ remove: () => { removed = true; } });
            return removed ? "" : tagText;
          });
        }
      }
      return html;
    });
    const stream = new ReadableStream({
      async start(c) { c.enqueue(new TextEncoder().encode(await body)); c.close(); },
    });
    return new Response(stream, { status: res.status, headers: res.headers });
  }
}
