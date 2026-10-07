import "../support/env";
import { test, expect } from "@playwright/test";
import { csvCell, neutraliseCell, parseCsv, toCsv } from "@/lib/people/csv";

// Plan "Build design — Phase 1.2", decision P8: the CSV reader and writer.

const rows = (text: string) => {
  const parsed = parseCsv(text);
  if (!parsed.ok) throw new Error(`unexpected parse error at line ${parsed.line}: ${parsed.message}`);
  return parsed.rows;
};

test.describe("reading", () => {
  test("plain rows, LF, CRLF and a lone CR all end a row; the final newline adds no empty row", () => {
    expect(rows("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(rows("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(rows("a,b\r1,2\r")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(rows("a,b\n\n1,2\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]); // blank lines are skipped
    expect(rows("")).toEqual([]);
    expect(rows("\n\n")).toEqual([]);
  });

  test("a byte-order mark at the start is dropped", () => {
    expect(rows("﻿first_name,last_name\nA,B")[0]).toEqual(["first_name", "last_name"]);
  });

  test("quoted cells: commas, doubled quotes and newlines inside", () => {
    expect(rows('"a,b","say ""hi""","line1\nline2"')).toEqual([["a,b", 'say "hi"', "line1\nline2"]]);
    expect(rows('"",x')).toEqual([["", "x"]]);
    expect(rows('x,""')).toEqual([["x", ""]]);
  });

  test("empty cells are kept, including a trailing one", () => {
    expect(rows("a,,c\n,,\nx,y,")).toEqual([
      ["a", "", "c"],
      ["", "", ""],
      ["x", "y", ""],
    ]);
  });

  test("a quote in the middle of an unquoted value is an error naming the line", () => {
    const parsed = parseCsv('a,b\nx"y,2');
    expect(parsed).toMatchObject({ ok: false, line: 2 });
  });

  test("text after a closing quote is an error", () => {
    expect(parseCsv('"a"b,c')).toMatchObject({ ok: false, line: 1 });
    expect(parseCsv('"a" ,c')).toMatchObject({ ok: false, line: 1 });
  });

  test("a quote that is never closed names the line where it began", () => {
    expect(parseCsv('a,b\n1,"never closed\nstill open')).toMatchObject({ ok: false, line: 2, message: "A quoted value is never closed." });
  });

  test("spaces around unquoted values are kept as typed (the importer trims)", () => {
    expect(rows(" a , b ")).toEqual([[" a ", " b "]]);
  });
});

test.describe("writing", () => {
  test("cells with a comma, quote, CR or LF are quoted, quotes doubled", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  test("a cell that would run as a spreadsheet formula is prefixed with an apostrophe", () => {
    for (const cell of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) expect(neutraliseCell(cell), JSON.stringify(cell)).toBe(`'${cell}`);
    for (const cell of ["a=1", "1+1", "x-y", "name@example.com", "", " =1"]) expect(neutraliseCell(cell), JSON.stringify(cell)).toBe(cell);
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
  });

  test("rows end with CRLF and read back to the same values", () => {
    const data = [
      ["first_name", "note"],
      ["Amina", 'likes "maths", reads'],
      ["Ade", "line1\nline2"],
    ];
    const text = toCsv(data);
    expect(text.endsWith("\r\n")).toBe(true);
    expect(rows(text)).toEqual(data);
    expect(toCsv([])).toBe("");
  });
});
