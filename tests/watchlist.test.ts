/**
 * tests/watchlist.test.ts - unit tests for the pure watchlist helpers in lib/watchlist.ts.
 *
 * Purpose: guard the "shared link" feature. The bug this protects against: Turkish-locale upper
 * casing turned "bimas" into "BIMAS" with a dotted capital I, so links matched no stock.
 *
 * What it does: imports the exported pure functions (no browser, no React rendering needed) and
 * checks normalisation, de-duplication, junk removal, the 200-symbol cap and the known-symbol filter.
 *
 * How to run (Node 24+ runs .ts directly):
 *   npm test                                   # -> every file ending in .test.ts under tests/
 *   node --test tests/watchlist.test.ts        # -> just this file; expect "pass 10" and "fail 0"
 *
 * Extension point: add a new `test("...", () => {...})` block per new rule in lib/watchlist.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_SYMBOLS, filterKnownSymbols, normalizeSymbols, parseTakipParam, toTickerSymbol } from "../lib/watchlist.ts";

test("parseTakipParam: plain lower-case list becomes upper-case ASCII", () => {
  assert.deepEqual(parseTakipParam("bimas,sise"), ["BIMAS", "SISE"]);
});

test("dotless i (U+0131) maps to ASCII I", () => {
  assert.equal(toTickerSymbol("bımas"), "BIMAS");
  assert.deepEqual(parseTakipParam("bımas"), ["BIMAS"]);
});

test("dotted capital I (U+0130) and lower i both map to ASCII I", () => {
  assert.equal(toTickerSymbol("BİMAS"), "BIMAS");
  assert.equal(toTickerSymbol("bimas"), "BIMAS");
  // "I" + combining dot above (decomposed form of the dotted capital) must also work
  assert.equal(toTickerSymbol("BİMAS"), "BIMAS");
});

test("other Turkish letters map to their ASCII letters", () => {
  assert.equal(toTickerSymbol("şğüöç"), "SGUOC");
  assert.equal(toTickerSymbol("ŞĞÜÖÇ"), "SGUOC");
});

test("duplicates are removed, first occurrence wins, order kept", () => {
  assert.deepEqual(parseTakipParam("thyao, GARAN ,Thyao,garan,AKBNK"), ["THYAO", "GARAN", "AKBNK"]);
  // different spellings of the same ticker collapse to one entry
  assert.deepEqual(parseTakipParam("bimas,BİMAS,bımas"), ["BIMAS"]);
});

test("junk is dropped: empty, too short, too long, symbols, non-strings", () => {
  assert.deepEqual(parseTakipParam(",, ,A,ABCDEFGHI,THY-AO,<script>,BIM AS,é"), []);
  assert.deepEqual(normalizeSymbols(["THYAO", 5, null, { a: 1 }, "GARAN"]), ["THYAO", "GARAN"]);
  assert.deepEqual(normalizeSymbols("THYAO"), []); // not an array
  assert.deepEqual(parseTakipParam("AB,ABCDEFGH"), ["AB", "ABCDEFGH"]); // 2 and 8 chars are the limits
});

test("digits are allowed (some tickers contain them)", () => {
  assert.deepEqual(parseTakipParam("a1b2"), ["A1B2"]);
});

test("the list is capped at 200 symbols (first ones kept)", () => {
  const many = Array.from({ length: 500 }, (_, i) => `AB${String(i).padStart(3, "0")}`);
  const out = parseTakipParam(many.join(","));
  assert.equal(MAX_SYMBOLS, 200);
  assert.equal(out.length, 200);
  assert.equal(out[0], "AB000");
  assert.equal(out[199], "AB199");
});

test("the cap counts only valid, unique symbols", () => {
  const raw = ["junk!", "AB000", "ab000", ...Array.from({ length: 300 }, (_, i) => `CD${String(i).padStart(3, "0")}`)];
  const out = normalizeSymbols(raw);
  assert.equal(out.length, 200);
  assert.equal(out[0], "AB000");
});

test("filterKnownSymbols keeps only known symbols, and does nothing while the universe is empty", () => {
  const known = new Set(["THYAO", "GARAN"]);
  assert.deepEqual(filterKnownSymbols(["THYAO", "XXXXX", "GARAN"], known), ["THYAO", "GARAN"]);
  assert.deepEqual(filterKnownSymbols(["THYAO", "XXXXX"], new Set()), ["THYAO", "XXXXX"]);
  assert.deepEqual(filterKnownSymbols(["THYAO"], undefined), ["THYAO"]);
});
