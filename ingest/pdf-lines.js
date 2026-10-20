// Turn a PDF into rows of text, using pdf.js. County turnout reports are tables exported to PDF, so grouping
// text items that share a baseline gives one entry per table row, cells ordered left to right.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * @param {Uint8Array} pdfBytes
 * @param {{ rowTolerance?: number }} [options] items whose baselines differ by less than this (PDF units) share a row
 * @returns {Promise<Array<{ page: number, y: number, cells: Array<{ x: number, text: string }>, text: string }>>}
 *   rows top to bottom, page by page
 */
export async function pdfRows(pdfBytes, { rowTolerance = 2.5 } = {}) {
  const pdf = await getDocument({ data: pdfBytes, useSystemFonts: false, disableFontFace: true, verbosity: 0 }).promise;
  const rows = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const { items } = await page.getTextContent();
    const pageRows = [];
    for (const item of items) {
      const text = item.str.trim();
      if (!text) continue;
      const [, , , , x, y] = item.transform; // transform[4], transform[5] are the item's x and baseline y
      let row = pageRows.find((r) => Math.abs(r.y - y) < rowTolerance);
      if (!row) { row = { page: pageNumber, y, cells: [] }; pageRows.push(row); }
      row.cells.push({ x, text });
    }
    pageRows.sort((a, b) => b.y - a.y); // PDF y grows upward; read top to bottom
    for (const row of pageRows) { row.cells.sort((a, b) => a.x - b.x); row.text = row.cells.map((c) => c.text).join(" "); rows.push(row); }
  }
  await pdf.destroy();
  return rows;
}

/** Numbers in a row of text, commas removed: "1,542 0 0" → [1542, 0, 0]. Ignores dates and percentages. */
export function rowNumbers(text) {
  return [...String(text).matchAll(/(?<![\dA-Za-z/.%-])(\d{1,3}(?:,\d{3})+|\d+)(?![\d/%.]|-\d)/g)].map((m) => Number(m[1].replace(/,/g, "")));
}
