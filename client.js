// markdown_note, markdown as a note, a sign, or an e-ink shelf label.
//
// Four decisions worth knowing about:
//
//  - The markdown parser lives here, not on the server. Inline text has to
//    render even when the server has nothing to add, and one renderer for both
//    modes means the preview in the editor is the tag on the shelf.
//
//  - Auto-fit measures rather than guesses. A shelf tag is small and the text
//    is arbitrary ("Pantry" vs a six-line inventory), so a fixed clamp() is
//    either tiny or clipped. We seed a size from the cell's area and the text
//    length, then binary-search the largest size that doesn't overflow. If the
//    host isn't laid out yet (clientHeight 0) the cqmin clamp stands, so the
//    widget never renders blank.
//
//  - Rotation is a real transform on a swapped-dimension stage, not a CSS
//    writing-mode trick, because label tags get mounted sideways on a shelf lip
//    and the whole composition (frame included) has to turn with the text.
//
//  - A leading heading with something under it gets a hairline rule under it.
//    That one move is the difference between "text on a panel" and something
//    that reads as a made label.

// Private-use sentinel: code spans park behind it while emphasis is applied,
// so `**not bold**` inside backticks survives.
const SENTINEL = String.fromCharCode(0xe000);
const NBSP = String.fromCharCode(0x00a0);

const SIZE_SCALE = { xs: 3.4, sm: 4.6, md: 6.2, lg: 8.4, xl: 12 };
const PAD = { tight: 3, normal: 6.5, roomy: 11 };
const VALIGN = { top: "flex-start", middle: "center", bottom: "flex-end" };

const RULE_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const IMG_ONLY_RE = /^!\[([^\]]*)\]\(([^)\s]+)[^)]*\)$/;
const TABLE_SEP_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const SEPARATOR_RE = / ([·•–—|]) /g;
// Whichever heading leads the note is its title: a section pulled out of a
// shared document usually starts at "##", not "#".
const TITLED_RE = /^<h([12])>[\s\S]*?<\/h\1>[\s\S]+$/;
const SOLO_RE = /^<h([12])>[\s\S]*?<\/h\1>$/;

function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// Inline spans, over already-escaped text. Newlines survive as newlines: the
// caller turns them into breaks afterwards, so **bold that spans a typed line
// break** still closes.
function inline(src) {
  const codes = [];
  let t = escapeHtml(src);
  t = t.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `${SENTINEL}${codes.length - 1}${SENTINEL}`;
  });
  t = t.replace(
    /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g,
    (_, alt, url) => `<img class="inl" src="${url}" alt="${alt}">`,
  );
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, "$1");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*\w])\*([^*]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>");
  t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  t = t.replace(/(^|\s)==([^=\n]+)==/g, "$1<mark>$2</mark>");
  t = t.replace(
    new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, "g"),
    (_, i) => `<code>${codes[+i]}</code>`,
  );
  // Glue a separator to the word before it. "Rice · Pasta · Flour" wrapped by
  // the browser can otherwise start the second line with a lone "·", which
  // reads as a mistake on a two-line label.
  t = t.replace(SEPARATOR_RE, `${NBSP}$1 `);
  return t;
}

function buildList(items, from, indent) {
  const ordered = items[from].ordered;
  let html = ordered ? "<ol>" : "<ul>";
  let i = from;
  while (i < items.length && items[i].indent >= indent) {
    if (items[i].indent > indent) {
      const [sub, next] = buildList(items, i, items[i].indent);
      html = html.replace(/<\/li>$/, `${sub}</li>`);
      i = next;
      continue;
    }
    if (items[i].ordered !== ordered) break;
    const it = items[i];
    const tick =
      it.task === null
        ? ""
        : `<span class="tick${it.task ? " on" : ""}">${it.task ? "✓" : ""}</span>`;
    html += `<li class="${it.task === null ? "" : "task"}">${tick}${inline(it.text)}</li>`;
    i += 1;
  }
  html += ordered ? "</ol>" : "</ul>";
  return [html, i];
}

function parseTable(lines, start) {
  const rows = [];
  let i = start;
  while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
    rows.push(lines[i]);
    i += 1;
  }
  const cells = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  const th = head.map((c) => `<th>${inline(c)}</th>`).join("");
  const tb = body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
  return [`<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`, i];
}

function isBlockStart(line) {
  return (
    RULE_RE.test(line) ||
    HEADING_RE.test(line) ||
    LIST_RE.test(line) ||
    QUOTE_RE.test(line) ||
    FENCE_RE.test(line)
  );
}

function mdToHtml(src, hardBreaks = true) {
  const lines = String(src ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  let html = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const marker = fence[1][0];
      const buf = [];
      i += 1;
      while (i < lines.length && !(lines[i].match(FENCE_RE) || [])[1]?.startsWith(marker)) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1;
      html += `<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`;
      continue;
    }

    if (RULE_RE.test(line)) {
      html += "<hr>";
      i += 1;
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      const level = Math.min(6, heading[1].length);
      html += `<h${level}>${inline(heading[2])}</h${level}>`;
      i += 1;
      continue;
    }

    const img = line.trim().match(IMG_ONLY_RE);
    if (img) {
      html +=
        `<figure><img class="blk" src="${escapeHtml(img[2])}" ` +
        `alt="${escapeHtml(img[1])}"></figure>`;
      i += 1;
      continue;
    }

    // Quote lines only, no lazy continuation: a tag author who drops back to
    // an unprefixed line means the quote ended.
    if (QUOTE_RE.test(line)) {
      const buf = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buf.push(lines[i].match(QUOTE_RE)[1]);
        i += 1;
      }
      html += `<blockquote>${mdToHtml(buf.join("\n"), hardBreaks)}</blockquote>`;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const [table, next] = parseTable(lines, i);
      html += table;
      i = next;
      continue;
    }

    if (LIST_RE.test(line)) {
      const items = [];
      while (i < lines.length && LIST_RE.test(lines[i])) {
        const m = lines[i].match(LIST_RE);
        let text = m[3];
        let task = null;
        const box = text.match(/^\[([ xX])\]\s+(.*)$/);
        if (box) {
          task = box[1].toLowerCase() === "x";
          text = box[2];
        }
        items.push({
          indent: Math.floor(m[1].replace(/\t/g, "  ").length / 2),
          ordered: /\d/.test(m[2]),
          task,
          text,
        });
        i += 1;
      }
      html += buildList(items, 0, items[0].indent)[0];
      continue;
    }

    // Paragraph. The whole run is inlined in one pass so emphasis can span the
    // line breaks a label author typed; the breaks are re-inserted after. By
    // default a typed newline breaks, because that is what someone writing a
    // shelf tag means. Prose pasted from an 80-column document wants the
    // opposite, hence the option.
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      buf.push(lines[i].trim());
      i += 1;
    }
    html += `<p>${inline(buf.join("\n")).replace(/\n/g, hardBreaks ? "<br>" : " ")}</p>`;
  }

  return html;
}

function stripHeading(src) {
  const lines = String(src ?? "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    if (HEADING_RE.test(lines[i])) return lines.slice(i + 1).join("\n");
    break;
  }
  return src;
}

function firstHeading(src) {
  for (const line of String(src ?? "").split("\n")) {
    const m = line.match(HEADING_RE);
    if (m) return m[2];
    if (line.trim()) return "";
  }
  return "";
}

// Seed size: solve "how many characters fit" for the font size, treating the
// average glyph as roughly half an em on a 1.3em line. Headings weigh more
// than their character count, so they carry a multiplier.
function seedSize(src, w, h) {
  let weight = 0;
  for (const line of String(src ?? "").split("\n")) {
    const m = line.match(HEADING_RE);
    const mult = m ? [2.2, 1.8, 1.4, 1.2, 1.1, 1][m[1].length - 1] : 1;
    const len = m ? m[2].length : line.trim().length;
    weight += len * mult * mult;
  }
  return Math.sqrt((w * h * 1.48) / Math.max(weight, 4));
}

// Largest font size whose content still fits the stage. Reading scrollHeight
// forces a synchronous reflow each step, which is why this binary-searches in
// 12 steps rather than walking down a pixel at a time.
function fitToBox(box, ink, have, wide, seed) {
  const search = () => {
    let lo = 5;
    let hi = Math.max(seed * 1.9, 14);
    let best = 0;
    for (let n = 0; n < 12; n += 1) {
      const mid = (lo + hi) / 2;
      ink.style.fontSize = `${mid}px`;
      if (ink.scrollHeight <= have + 0.5 && ink.scrollWidth <= wide + 0.5) {
        best = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return best;
  };
  let best = search();
  if (!best) {
    ink.classList.add("brk");
    best = search();
  }
  ink.style.fontSize = `${best || 5}px`;
}

// Fit, then fit again once the page's webfont has actually arrived. The first
// pass measures in the fallback face, whose metrics are not the ones that get
// screenshotted.
function fit(shadow, token, text) {
  if (shadow.mdFitToken !== token) return;
  const stage = shadow.querySelector(".stage");
  const ink = shadow.querySelector(".ink");
  if (!stage || !ink) return;
  // clientWidth/Height include the stage's padding, the ink's scroll sizes
  // don't: comparing them directly lets the text overflow by exactly the
  // margin, which is how the last line of a label goes missing.
  const cs = getComputedStyle(stage);
  const w = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const h = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (!(w > 0 && h > 0)) return; // not laid out yet: the cqmin clamp stands
  ink.classList.remove("brk");
  fitToBox(stage, ink, h, w, seedSize(text, w, h));
}

export default function render(shadow, ctx) {
  const data = ctx?.data ?? {};
  const o = (ctx?.cell && ctx.cell.options) || {};
  const fragment = (ctx?.cell && ctx.cell.fragment) || "full";

  const layout = o.layout === "page" ? "page" : "label";
  const align = ["left", "center", "right"].includes(o.align) ? o.align : "left";
  const valign = VALIGN[o.valign] ? o.valign : "middle";
  const rotate = ["0", "90", "180", "270"].includes(String(o.rotate)) ? String(o.rotate) : "0";
  const basePad = PAD[o.density] ?? PAD.normal;
  const pad = layout === "page" ? basePad * 1.35 : basePad;
  const frame = ["hairline", "bold"].includes(o.frame) ? o.frame : "none";
  const auto = !SIZE_SCALE[o.text_size];
  const scale = SIZE_SCALE[o.text_size] || SIZE_SCALE.md;

  let source = data.markdown ?? o.text ?? "";
  if (fragment === "body") source = data.body ?? stripHeading(source);
  if (fragment === "heading") source = `# ${data.title || firstHeading(source)}`;

  const css = `<link rel="stylesheet" href="/static/style/spectra-widgets.css">`;
  const styles = `
    <style>
      .w { position: relative; width: 100%; height: 100%;
           container-type: size; container-name: mdcell;
           padding: 0; gap: 0; overflow: hidden;
           background: var(--paper); color: var(--ink);
           --ink: var(--text-primary); --paper: var(--surface);
           --dim: var(--text-secondary); --hair: var(--edge, var(--text-muted));
           /* Glyphs drawn ON an ink fill (a ticked box, a highlight). NOT
              --surface: a widget on a canvas has a transparent surface so it
              blends with the page, and transparent ink is invisible ink.
              --on-accent is the one token every theme defines as the opposite
              of --text-primary, dark themes included. */
           --counter: var(--on-accent, var(--bg)); }
      /* Inversion swaps tokens rather than filtering: e-ink wants two flat
         inks, and a filter would drag the images along with the type. */
      .w.inv { --ink: var(--on-accent, var(--bg)); --paper: var(--text-primary);
               --dim: var(--ink); --hair: var(--ink); --counter: var(--paper); }
      .stage { position: absolute; inset: 0; display: flex; overflow: hidden;
               box-sizing: border-box; padding: ${pad}cqmin;
               align-items: ${VALIGN[valign]}; justify-content: center; }
      /* Turned tags: the stage takes the container's dimensions swapped, then
         rotates back over it, so the frame and padding turn with the text. */
      .rot-90 .stage, .rot-270 .stage { inset: auto; width: 100cqh; height: 100cqw; }
      .rot-90 .stage { transform-origin: top left; transform: rotate(90deg) translate(0, -100%); }
      .rot-270 .stage { transform-origin: top left; transform: rotate(-90deg) translate(-100%, 0); }
      .rot-180 .stage { transform-origin: center; transform: rotate(180deg); }
      /* The frame is an inset pseudo-element, not a border on the stage: a rule
         drawn right at the panel edge gets eaten by the bezel and reads as a
         crop rather than a frame. It lives inside the stage, so it turns with
         rotation. Both weights use --ink, never the grey edge token: a grey
         hairline dithers to a dotted line on a 1-bit panel. */
      .fr-hairline .stage::before, .fr-bold .stage::before {
        content: ""; position: absolute; inset: ${(pad * 0.34).toFixed(2)}cqmin;
        pointer-events: none; }
      .fr-hairline .stage::before { border: max(1px, 0.25cqmin) solid var(--ink); }
      .fr-bold .stage::before { border: clamp(2px, 1.8cqmin, 12px) solid var(--ink); }

      /* The typeface is the page's, not the widget's: the dashboard's
         data-style axis owns that choice across every cell. */
      .ink { width: 100%; font-family: var(--font-family);
             font-size: ${auto ? "clamp(7px, 6cqmin, 90px)" : `clamp(7px, ${scale}cqmin, 130px)`};
             line-height: 1.22; text-align: ${align};
             font-kerning: normal; hyphens: none; }
      /* Words stay whole while auto-fit searches, so "Winter" shrinks to fit
         instead of splitting into "Wint / er". Only a word that can't fit the
         cell at the minimum size earns a mid-word break. */
      .ink.brk { overflow-wrap: anywhere; }
      .ink > :first-child { margin-top: 0; }
      .ink > :last-child { margin-bottom: 0; }

      .ink h1 { font-size: 1.72em; font-weight: var(--fw-black, 800);
                line-height: 1.02; letter-spacing: -0.025em;
                text-wrap: balance; margin: 0 0 0.26em; }
      .ink h2 { font-size: 1.28em; font-weight: var(--fw-black, 800);
                line-height: 1.08; letter-spacing: -0.014em;
                text-wrap: balance; margin: 0.62em 0 0.2em; }
      .ink h3 { font-size: 1.06em; font-weight: var(--fw-bold, 700);
                line-height: 1.16; text-wrap: balance; margin: 0.58em 0 0.16em; }
      .ink h4, .ink h5, .ink h6 {
                font-size: 0.82em; font-weight: var(--fw-bold, 700);
                letter-spacing: 0.09em; text-transform: uppercase;
                color: var(--dim); margin: 0.6em 0 0.14em; }
      /* Bold inside a heading has nothing louder to reach for unless the face
         carries a heavier weight, so ask for one. */
      .ink h1 strong, .ink h2 strong, .ink h3 strong { font-weight: 900; }
      /* A title with something under it gets the filing-label rule, but only
         when it leads the note: a mid-document heading is structure, not a
         title, and ruling every one of them turns a note into a form. */
      .ink.titled > h1:first-child, .ink.titled > h2:first-child {
        padding-bottom: 0.2em; margin-bottom: 0.32em;
        border-bottom: max(1px, 0.055em) solid var(--ink); }
      /* Nothing but a name on the tag: tighten it and let it fill. */
      .ink.solo h1, .ink.solo h2 { letter-spacing: -0.035em; line-height: 0.98; }

      /* Balance on a label (short lines, no orphan word alone on the last
         line), pretty on a page (long copy, keep the ragged edge even). */
      .ink p { margin: 0 0 0.5em; text-wrap: ${layout === "page" ? "pretty" : "balance"}; }
      .ink strong { font-weight: var(--fw-black, 800); }
      .ink em { font-style: italic; }

      .ink ul { list-style: square; }
      .ink ol { list-style: decimal; }
      .ink ul, .ink ol { margin: 0 0 0.5em; padding-inline-start: 1.05em; }
      .ink li { margin: 0 0 0.18em; padding-inline-start: 0.08em; }
      .ink li::marker { color: var(--dim); }
      .ink ol li::marker { color: var(--ink); font-weight: var(--fw-bold, 700);
                           font-variant-numeric: tabular-nums; }
      .ink li > ul, .ink li > ol { margin: 0.18em 0 0; }
      .ink li:last-child { margin-bottom: 0; }
      .ink li.task { list-style: none; margin-inline-start: -1.05em;
                     display: flex; align-items: baseline; gap: 0.42em;
                     text-align: start; }
      .ink .tick { flex: none; display: inline-grid; place-items: center;
                   width: 0.82em; height: 0.82em; line-height: 1;
                   font-size: 0.78em; font-weight: var(--fw-black, 800);
                   translate: 0 0.08em;
                   border: max(1px, 0.085em) solid var(--ink);
                   border-radius: 0.14em; }
      .ink .tick.on { background: var(--ink); color: var(--counter); }

      .ink blockquote { margin: 0 0 0.5em; padding-inline-start: 0.62em;
                        border-inline-start: max(1px, 0.13em) solid var(--hair);
                        color: var(--dim); }
      .ink blockquote > :last-child { margin-bottom: 0; }

      .ink code { font-size: 0.86em; letter-spacing: 0.005em;
                  background: var(--surface-sunken, transparent);
                  padding: 0.06em 0.28em; border-radius: 0.2em; }
      .ink pre { margin: 0 0 0.5em; padding: 0.45em 0.6em; overflow: hidden;
                 line-height: 1.34; text-align: start;
                 background: var(--surface-sunken, transparent); border-radius: 0.28em; }
      .ink pre code { background: none; padding: 0; font-size: 0.84em; }

      .ink hr { border: none; height: max(1px, 0.06em); background: var(--hair);
                margin: 0.6em 0; opacity: 1; }

      .ink table { border-collapse: collapse; width: 100%; margin: 0 0 0.5em;
                   font-variant-numeric: tabular-nums; }
      .ink thead tr { border-bottom: max(1px, 0.07em) solid var(--ink); }
      .ink th { text-align: ${align === "center" ? "center" : "start"};
                font-size: 0.76em; font-weight: var(--fw-black, 800);
                letter-spacing: 0.09em; text-transform: uppercase; color: var(--dim);
                padding: 0 0.5em 0.18em 0; }
      .ink td { text-align: ${align === "center" ? "center" : "start"};
                padding: 0.2em 0.5em 0.2em 0;
                border-bottom: max(1px, 0.04em) solid var(--hair); }
      .ink tbody tr:last-child td { border-bottom: none; }
      .ink td:first-child { font-weight: var(--fw-bold, 700); }
      .ink th:last-child, .ink td:last-child { padding-inline-end: 0; }

      .ink mark { background: var(--ink); color: var(--counter); padding: 0 0.15em; }
      .ink del { text-decoration-thickness: max(1px, 0.06em); }
      .ink figure { margin: 0 0 0.5em; }
      .ink img.blk { display: block; max-width: 100%;
                     margin-inline: ${align === "center" ? "auto" : "0"}; }
      .ink img.inl { height: 1em; vertical-align: -0.12em; }

      .empty { color: var(--text-muted); font-weight: var(--fw-bold, 700);
               letter-spacing: 0.02em; text-align: center; text-wrap: balance;
               font-size: clamp(9px, 4.5cqmin, 22px); }
    </style>`;

  const classes = ["w", `rot-${rotate}`, `fr-${frame}`, o.invert ? "inv" : ""]
    .filter(Boolean)
    .join(" ");

  const text = String(source).trim();
  const html = text ? mdToHtml(text, o.line_breaks !== "reflow") : "";
  const inkClass = [
    "ink",
    auto ? "" : "brk",
    TITLED_RE.test(html) ? "titled" : "",
    SOLO_RE.test(html) ? "solo" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const body = data.error
    ? `<div class="empty">${escapeHtml(data.error)}</div>`
    : html
      ? `<div class="${inkClass}">${html}</div>`
      : `<div class="empty">Write some markdown.</div>`;

  shadow.innerHTML = `${css}${styles}
    <div class="${classes}" data-widget="markdown_note">
      <div class="stage">${body}</div>
    </div>`;

  if (!auto || data.error || !text) return;
  const token = (shadow.mdFitToken || 0) + 1;
  shadow.mdFitToken = token;
  fit(shadow, token, text);
  const fonts = typeof document !== "undefined" ? document.fonts : null;
  if (fonts && fonts.ready) fonts.ready.then(() => fit(shadow, token, text));
}
