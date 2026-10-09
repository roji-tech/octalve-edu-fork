// A small RFC 4180 CSV reader and writer (plan "Build design — Phase 1.2", decision P8). Written here, and unit-tested, instead of adding a dependency to
// the one path that takes a file from a stranger's spreadsheet. Pure: no I/O, no limits — the caller applies the size and row caps it states in its error.

export type CsvParse = { ok: true; rows: string[][] } | { ok: false; line: number; message: string };

/// Reads CSV text into rows of cells. A leading byte-order mark is dropped; cells may be quoted (`"a,b"`, with `""` for a quote and newlines allowed inside);
/// rows end at LF, CRLF or a lone CR; a row that is empty (one empty cell) is skipped, which also swallows the final newline. Unquoted text after a closing
/// quote, or a quote that is never closed, is an error naming the line it began on (1-based, counted in physical lines).
export function parseCsv(text: string): CsvParse {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let quoteLine = 1;
  let line = 1;
  let afterQuote = false; // just closed a quoted cell: only , or a line end may follow

  const endCell = () => {
    row.push(cell);
    cell = "";
    afterQuote = false;
  };
  const endRow = () => {
    endCell();
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (cell !== "" || afterQuote)
        return { ok: false, line, message: "A quote appears in the middle of a value; put the whole value in quotes." };
      inQuotes = true;
      quoteLine = line;
    } else if (ch === ",") {
      endCell();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      endRow();
      line++;
    } else if (afterQuote) {
      return { ok: false, line, message: "Text follows a closing quote; separate values with commas." };
    } else {
      cell += ch;
    }
  }
  if (inQuotes) return { ok: false, line: quoteLine, message: "A quoted value is never closed." };
  if (cell !== "" || row.length > 0 || afterQuote) endRow();
  return { ok: true, rows };
}

/// A cell a spreadsheet would run as a formula starts with one of these (OWASP "CSV injection"). Exported text is prefixed with `'` so it stays text.
const FORMULA_START = /^[=+\-@\t\r]/;

export const neutraliseCell = (value: string): string => (FORMULA_START.test(value) ? `'${value}` : value);

/// One cell as CSV: neutralised, then quoted if it holds a comma, quote, CR or LF.
export function csvCell(value: string | null | undefined): string {
  const text = neutraliseCell(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/// Rows as CSV text, CRLF-terminated (what spreadsheets expect), every cell through `csvCell`.
export const toCsv = (rows: ReadonlyArray<ReadonlyArray<string | null | undefined>>): string =>
  rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + (rows.length ? "\r\n" : "");
