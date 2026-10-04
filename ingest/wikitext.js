// Minimal MediaWiki wikitext helpers: section lookup, table parsing (with rowspan carry-down), and cell cleanup.

/** Find the body of the LAST section whose heading matches `headingRegex`, searching after `afterIndex`. */
export function findSection(wikitext, headingRegex, { afterIndex = 0, last = true } = {}) {
  const headingPattern = /^(={2,5})\s*(.*?)\s*=+\s*$/gm;
  const headings = [];
  let match;
  while ((match = headingPattern.exec(wikitext))) {
    headings.push({ start: match.index, end: match.index + match[0].length, level: match[1].length, title: match[2] });
  }
  const candidates = headings.filter((h) => h.start >= afterIndex && headingRegex.test(h.title));
  if (candidates.length === 0) return null;
  const heading = last ? candidates[candidates.length - 1] : candidates[0];
  const next = headings.find((h) => h.start > heading.start && h.level <= heading.level);
  return { title: heading.title, start: heading.end, body: wikitext.slice(heading.end, next ? next.start : undefined) };
}

/** Return the raw text of every `{| ... |}` table in `text`, in order (nested tables are not supported). */
export function extractTables(text) {
  const tables = [];
  const openPattern = /^\{\|.*$/gm;
  let open;
  while ((open = openPattern.exec(text))) {
    const closePattern = /^\|\}/gm; // `|}` may share a line with trailing markup such as <section end=.../>
    closePattern.lastIndex = open.index;
    const close = closePattern.exec(text);
    if (!close) break;
    tables.push(text.slice(open.index, close.index + close[0].length));
    openPattern.lastIndex = close.index + close[0].length;
  }
  return tables;
}

/** Strip `<ref>...</ref>` and `<ref .../>` and HTML comments. */
export function stripRefs(text) {
  return text
    .replace(/<ref[^>/]*\/>/g, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/** Remove `{{...}}` templates (nested-aware) while optionally keeping the first argument of a few. */
export function stripTemplates(text, { keep = {} } = {}) {
  let output = "";
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("{{", index)) {
      let depth = 0;
      let cursor = index;
      while (cursor < text.length) {
        if (text.startsWith("{{", cursor)) { depth += 1; cursor += 2; continue; }
        if (text.startsWith("}}", cursor)) { depth -= 1; cursor += 2; if (depth === 0) break; continue; }
        cursor += 1;
      }
      const template = text.slice(index + 2, cursor - 2);
      const [name, ...args] = template.split("|");
      const replacer = keep[name.trim().toLowerCase()];
      if (replacer) output += replacer(args.map((a) => a.trim()));
      index = cursor;
      continue;
    }
    output += text[index];
    index += 1;
  }
  return output;
}

/** Collapse wikilinks `[[target|label]]` -> label, bold/italic markers, and HTML tags. */
export function plainText(text) {
  return stripTemplates(stripRefs(text), {
    keep: {
      nbsp: () => " ",
      sdash: () => "–",
      "–": () => "–",
      small: (args) => args.join("|"),
      abbr: (args) => args[0] ?? "",
      sortname: (args) => `${args[0] ?? ""} ${args[1] ?? ""}`.trim(),
    },
  })
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, "$1")
    .replace(/'{2,5}/g, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a wikitable into header cells and body rows of RAW cell text (attributes stripped, markup kept).
 * Rowspans are carried down so every row has the same logical columns. Colspans duplicate the cell.
 */
export function parseTable(tableText) {
  // HTML comments (e.g. `<!--Cook--> | {{USRaceRating|...}}`) would otherwise read as cell continuations.
  const lines = tableText.replace(/<!--[\s\S]*?-->/g, "").split("\n").slice(1); // drop the `{|` line
  const rows = [];
  let current = null;
  const pushRow = () => { if (current && current.cells.length) rows.push(current); };
  for (const rawLine of lines) {
    const line = rawLine.trim(); // MediaWiki ignores leading whitespace before `|` / `!`
    if (/^\|\}/.test(line)) break;
    if (/^\|-/.test(line)) { pushRow(); current = { cells: [] }; continue; }
    if (/^\|\+/.test(line)) continue; // caption
    if (!current) current = { cells: [] };
    if (/^[!|]/.test(line)) {
      const isHeader = line.startsWith("!");
      const content = line.slice(1);
      const splitPattern = isHeader ? /\s*(?:!!|\|\|)\s*/ : /\s*\|\|\s*/;
      for (const piece of content.split(splitPattern)) current.cells.push({ ...splitAttributes(piece), header: isHeader });
    } else if (current.cells.length) {
      current.cells[current.cells.length - 1].text += `\n${line}`;
    }
  }
  pushRow();
  return applySpans(rows);
}

/** Split `attr="x" style=".." | content` into attributes and content, tolerating templates in attributes. */
function splitAttributes(cellText) {
  // The attribute/content separator is the first single `|` that is not inside `{{ }}` or `[[ ]]`.
  let depthBrace = 0;
  let depthBracket = 0;
  for (let i = 0; i < cellText.length; i += 1) {
    const two = cellText.slice(i, i + 2);
    if (two === "{{") { depthBrace += 1; i += 1; continue; }
    if (two === "}}") { depthBrace -= 1; i += 1; continue; }
    if (two === "[[") { depthBracket += 1; i += 1; continue; }
    if (two === "]]") { depthBracket -= 1; i += 1; continue; }
    if (cellText[i] === "|" && depthBrace === 0 && depthBracket === 0) {
      const attributes = cellText.slice(0, i);
      // Attribute strings contain `=`; a leading template like {{party shading/Democratic}} also counts.
      if (/=/.test(attributes) || /^\s*\{\{[^}]*\}\}\s*$/.test(attributes)) {
        return { attributes: attributes.trim(), text: cellText.slice(i + 1).trim() };
      }
      return { attributes: "", text: cellText.trim() };
    }
  }
  return { attributes: "", text: cellText.trim() };
}

function applySpans(rows) {
  const pending = new Map(); // column index -> { cell, remaining }
  const output = [];
  for (const row of rows) {
    const cells = [];
    let column = 0;
    let source = 0;
    while (source < row.cells.length || [...pending.keys()].some((k) => k >= column && pending.get(k).remaining > 0)) {
      if (pending.has(column) && pending.get(column).remaining > 0) {
        const span = pending.get(column);
        cells.push({ ...span.cell, carried: true });
        span.remaining -= 1;
        if (span.remaining === 0) pending.delete(column);
        column += 1;
        continue;
      }
      if (source >= row.cells.length) break;
      const cell = row.cells[source];
      source += 1;
      const rowspan = Number((cell.attributes.match(/rowspan\s*=\s*"?(\d+)/i) || [])[1] || 1);
      const colspan = Number((cell.attributes.match(/colspan\s*=\s*"?(\d+)/i) || [])[1] || 1);
      for (let c = 0; c < colspan; c += 1) {
        cells.push(cell);
        if (rowspan > 1) pending.set(column, { cell, remaining: rowspan - 1 });
        column += 1;
      }
    }
    output.push(cells);
  }
  return output;
}

/** Parse `{{USRaceRating|Lean|D|flip}}` / `{{USRaceRating|Tossup}}` into a normalized label like "Lean D". */
export function parseRaceRating(cellText) {
  const match = cellText.match(/\{\{\s*(?:USRaceRating|US political race rating)\s*\|([^}]*)\}\}/i);
  if (!match) return null;
  const parts = match[1].split("|").map((p) => p.trim()).filter(Boolean);
  const [level, party, flag] = parts;
  if (!level) return null;
  if (/^toss/i.test(level)) return { label: "Tossup", flip: false };
  const normalizedLevel = level[0].toUpperCase() + level.slice(1).toLowerCase();
  const normalizedParty = (party || "").toUpperCase().startsWith("D") ? "D" : (party || "").toUpperCase().startsWith("R") ? "R" : party || "";
  return { label: `${normalizedLevel} ${normalizedParty}`.trim(), flip: /flip/i.test(flag || "") };
}

/** Parse `{{Shading PVI|R|55.7}}` -> +55.7 for D, -55.7 for R (Democratic-positive margin). */
export function parsePviMargin(cellText) {
  const match = cellText.match(/\{\{\s*shading PVI\s*\|\s*([DR])\s*\|\s*([\d.]+)/i);
  if (!match) return null;
  const value = Number(match[2]);
  return match[1].toUpperCase() === "D" ? value : -value;
}

/** Detect the party a cell's shading template or `party color` reference indicates. */
export function parsePartyShading(cellText) {
  if (/Party shading\/(Democratic|DFL)|Democratic Party \(United States\)/i.test(cellText)) return "D";
  if (/Party shading\/Republican|Republican Party \(United States\)/i.test(cellText)) return "R";
  if (/Party shading\/Independent|Independent \(United States\)|Independent politician/i.test(cellText)) return "I";
  return null;
}

/** Parse "September 21–30, 2026" / "Sep 28 – Oct 1, 2026" / "through September 30, 2026" into ISO end date and start date. */
export function parseDateRange(text) {
  const cleaned = plainText(text).replace(/–|—/g, "-").replace(/\s+/g, " ").trim();
  const yearMatch = cleaned.match(/(\d{4})/);
  if (!yearMatch) return null;
  const year = Number(yearMatch[1]);
  const monthDay = /([A-Za-z]{3,9})\.?\s+(\d{1,2})/g;
  const found = [];
  let m;
  while ((m = monthDay.exec(cleaned))) {
    const month = monthIndex(m[1]);
    if (month !== null) found.push({ month, day: Number(m[2]) });
  }
  // "September 21-30": second day without month
  const sameMonth = cleaned.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*-\s*(\d{1,2})/);
  if (found.length === 1 && sameMonth && monthIndex(sameMonth[1]) !== null) {
    found.push({ month: monthIndex(sameMonth[1]), day: Number(sameMonth[3]) });
  }
  if (found.length === 0) return null;
  const toIso = ({ month, day }) => `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const start = toIso(found[0]);
  const end = toIso(found[found.length - 1]);
  return { start: start <= end ? start : end, end: end >= start ? end : start };
}

function monthIndex(name) {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const index = months.indexOf(name.slice(0, 3).toLowerCase());
  return index === -1 ? null : index;
}

/** Parse "47%" / "'''49.6%'''" -> 49.6; returns null for dashes or empty. */
export function parsePercent(cellText) {
  const text = plainText(cellText);
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (match) return Number(match[1]);
  const bare = text.match(/^(\d+(?:\.\d+)?)$/);
  return bare ? Number(bare[1]) : null;
}
