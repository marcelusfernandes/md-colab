import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeMarkdown, classifyMarkdownUrl, isNavigableMarkdownUrl, warningMessage } from '../lib/markdown-analysis.mjs';

void test('headings keep deterministic unicode ids after inline formatting and duplicates', () => {
  const markdown = '# Café **forte**\n\n## Café forte\n\n# `Café` forte\n';
  assert.deepEqual(analyzeMarkdown(markdown).headingIds, { 0: 'café-forte', 18: 'café-forte-1', 33: 'café-forte-2' });
  assert.deepEqual(analyzeMarkdown(markdown), analyzeMarkdown(markdown));
});

void test('heading text follows visible Markdown and always has a usable id', () => {
  const markdown = '# ![marca](logo.svg) `código` <span>oculto</span>\n# 🎉!!!\n# section-50\n';
  assert.deepEqual(analyzeMarkdown(markdown).headingIds, {
    0: 'marca-código-oculto',
    50: 'section-50',
    58: 'section-50-1',
  });
});

void test('AST analysis resolves references and ignores inline and fenced code', () => {
  const markdown = [
    String.raw`[relative][guide]`, String.raw`![Windows](C:\docs\image.png)`, String.raw`![UNC](\\server\share\image.png)`,
    '[root](/Users/author/plan.md)', '[file](file:///Users/author/plan.md)', '[protocol](//example.com/file)',
    '![data](data:image/png;base64,nope)', '[unsafe](javascript:alert(1))', '[web](https://example.com)',
    '[mail](mailto:qa@example.invalid)', '![mail image](mailto:qa@example.invalid)', '`[inline](./ignored.md)`', '',
    '```md', '[fenced](./ignored-too.md)', '```', '', '[guide]: ./guide.md',
  ].join('\n');
  assert.deepEqual(analyzeMarkdown(markdown).references.map((reference) => [reference.kind, reference.image, reference.url]), [
    ['relative', false, './guide.md'], ['windows-path', true, String.raw`C:\docs\image.png`], ['unc-path', true, String.raw`\server\share\image.png`],
    ['root-relative', false, '/Users/author/plan.md'], ['file', false, 'file:///Users/author/plan.md'], ['protocol-relative', false, '//example.com/file'],
    ['data', true, 'data:image/png;base64,nope'], ['unsupported-scheme', false, 'javascript:alert(1)'], ['mailto', true, 'mailto:qa@example.invalid'],
  ]);
});

void test('URL policy permits document fragments, web links and mail links only', () => {
  assert.equal(classifyMarkdownUrl('#café-forte'), 'fragment');
  assert.equal(classifyMarkdownUrl('https://example.com'), 'web');
  assert.equal(classifyMarkdownUrl('mailto:qa@example.invalid'), 'mailto');
  assert.equal(isNavigableMarkdownUrl('fragment'), true);
  assert.equal(isNavigableMarkdownUrl('web'), true);
  assert.equal(isNavigableMarkdownUrl('mailto'), true);
  assert.equal(isNavigableMarkdownUrl('mailto', true), false);
  assert.equal(isNavigableMarkdownUrl('protocol-relative'), false);
});

void test('URL policy rejects malformed web forms and uses the first reference definition', () => {
  assert.equal(classifyMarkdownUrl('https:/api/private'), 'unsupported-scheme');
  assert.equal(classifyMarkdownUrl('https:foo'), 'unsupported-scheme');
  assert.equal(classifyMarkdownUrl(String.raw`https://example.com\private`), 'unsupported-scheme');
  const localFirst = analyzeMarkdown('[one][ref]\n\n[ref]: ./local.md\n[ref]: https://example.com\n');
  const webFirst = analyzeMarkdown('[two][ref]\n\n[ref]: https://example.com\n[ref]: ./local.md\n');
  assert.equal(localFirst.references[0].kind, 'relative');
  assert.equal(webFirst.references.length, 0);
  assert.equal(analyzeMarkdown('![fragment](#section)').references[0].kind, 'fragment');
});

void test('reference warnings retain data but escape terminal control characters', () => {
  const reference = analyzeMarkdown('[x](<local\u001b[2J.md>)').references[0];
  assert.equal(reference.url, 'local\u001b[2J.md');
  assert.match(warningMessage(reference), /local\\u001b\[2J\.md/);
  const entity = analyzeMarkdown('[x](<line&#x0a;break.md>)').references[0];
  assert.equal(entity.url, 'line\nbreak.md');
  assert.match(warningMessage(entity), /line\\u000abreak\.md/);
});
