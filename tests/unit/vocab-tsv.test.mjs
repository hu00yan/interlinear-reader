import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVocabTSV } from "../../packages/web/src/vocab/tsv.ts";

const entry = {
  lemma: "猫",
  lang: "ja",
  gloss: "cat",
  sentence: "猫です。",
  addedAt: 1704067200000,
  known: false,
};

test("TSV is seven ordered fields, UTC ISO date, and Anki tags; no header", () => {
  assert.equal(
    buildVocabTSV([entry]),
    "猫\tja\tcat\t猫です。\t2024-01-01T00:00:00.000Z\tfalse\tilr lang:ja"
  );
  assert.equal(buildVocabTSV([]), "");
  const rows = buildVocabTSV([entry, { ...entry, known: true }]).split("\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[1].split("\t")[5], "true");
});

test("tabs and line breaks become spaces, other controls are stripped, HTML stays plain text", () => {
  const source = {
    ...entry,
    lemma: "a\tb",
    gloss: "x\r\ny\nq",
    sentence: 'One\u0000\u0001\u000b\u001f\u007f\u0085 two\u2028three\u2029four <b> & "quoted"',
  };
  const before = structuredClone(source);
  const result = buildVocabTSV([source, entry]);
  assert.equal(result.split("\n").length, 2);
  const fields = result.split("\n")[0].split("\t");
  assert.equal(fields.length, 7);
  assert.equal(fields[0], "a b");
  assert.equal(fields[2], "x y q");
  assert.equal(fields[3], 'One two three four <b> & "quoted"');
  assert.deepEqual(source, before);
});
