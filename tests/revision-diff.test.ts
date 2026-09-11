import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareRevisionMarkdown,
  REVISION_DIFF_UNAVAILABLE,
} from '../lib/revision-diff.ts';

void test('diff distingue inclusão, remoção, substituição e bloco movido', () => {
  const insertion = compareRevisionMarkdown('a\nc', 'a\nb\nc');
  assert.equal(insertion.available, true);
  assert.deepEqual(
    insertion.lines.filter((line) => line.kind !== 'equal'),
    [{ kind: 'added', text: 'b' }],
  );
  assert.equal(insertion.lineEndingsChanged, false);

  const removal = compareRevisionMarkdown('a\nb\nc', 'a\nc');
  assert.deepEqual(
    removal.lines.filter((line) => line.kind !== 'equal'),
    [{ kind: 'removed', text: 'b' }],
  );

  const replacement = compareRevisionMarkdown('antes\nmesmo offset', 'depois\nmesmo offset');
  assert.deepEqual(
    replacement.lines.filter((line) => line.kind !== 'equal'),
    [
      { kind: 'added', text: 'depois' },
      { kind: 'removed', text: 'antes' },
    ],
  );

  const moved = compareRevisionMarkdown('a\nb\nc\nd', 'c\nd\na\nb');
  assert.ok(moved.lines.some((line) => line.kind === 'removed'));
  assert.ok(moved.lines.some((line) => line.kind === 'added'));
});

void test('conteúdo idêntico e diferenças de BOM ou terminação têm estados exatos', () => {
  const identical = compareRevisionMarkdown('Olá 🌎\nlinha', 'Olá 🌎\nlinha');
  assert.equal(identical.identical, true);
  assert.deepEqual(identical.lines, []);

  const formatting = compareRevisionMarkdown('\uFEFFOlá\r\nlinha\r\n', 'Olá\nlinha\n');
  assert.equal(formatting.available, true);
  assert.equal(formatting.identical, false);
  assert.equal(formatting.bomChanged, true);
  assert.equal(formatting.lineEndingsChanged, true);
  assert.deepEqual(formatting.lines, []);
  assert.deepEqual(formatting.before, {
    bom: true,
    lineEndings: 'CRLF',
    finalNewline: true,
  });
  assert.deepEqual(formatting.after, {
    bom: false,
    lineEndings: 'LF',
    finalNewline: true,
  });
});

void test('scores preservam subsequência comum acima de 255 linhas', () => {
  const common = Array.from({ length: 300 }, (_, index) => `linha-${index}`);
  const result = compareRevisionMarkdown(
    ['antes', ...common].join('\n'),
    ['depois', ...common].join('\n'),
  );
  assert.equal(result.available, true);
  assert.equal(
    result.lines.filter((line) => line.kind === 'equal').length,
    300,
  );
});

void test('orçamentos recusam produto, linha, render e entrada acima do limite', () => {
  const product = compareRevisionMarkdown(
    Array.from({ length: 1001 }, (_, index) => `a-${index}`).join('\n'),
    Array.from({ length: 1000 }, (_, index) => `b-${index}`).join('\n'),
  );
  const longLine = compareRevisionMarkdown('a'.repeat(16 * 1024 + 1), 'b');
  const render = compareRevisionMarkdown(
    Array.from({ length: 251 }, (_, index) => `a-${index}`).join('\n'),
    Array.from({ length: 251 }, (_, index) => `b-${index}`).join('\n'),
  );
  const overInput = compareRevisionMarkdown('a'.repeat(1024 * 1024 + 1), 'b');
  const overInputLines = compareRevisionMarkdown(
    '\n'.repeat(1024 * 1024 + 1),
    'b',
  );
  for (const result of [product, longLine, render, overInput, overInputLines]) {
    assert.equal(result.available, false);
    assert.equal(result.message, REVISION_DIFF_UNAVAILABLE);
    assert.deepEqual(result.lines, []);
  }
});

void test('entradas vazias e linha final vazia permanecem determinísticas', () => {
  assert.equal(compareRevisionMarkdown('', '').identical, true);
  const added = compareRevisionMarkdown('', 'linha');
  assert.deepEqual(added.lines, [{ kind: 'added', text: 'linha' }]);
  const finalNewline = compareRevisionMarkdown('linha', 'linha\n');
  assert.equal(finalNewline.available, true);
  assert.equal(finalNewline.identical, false);
  assert.equal(finalNewline.lineEndingsChanged, true);
  assert.deepEqual(finalNewline.lines, []);
});
