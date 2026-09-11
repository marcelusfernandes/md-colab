import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MARKDOWN_RENDER_LIMITS,
  markdownRenderPreflight,
  prepareMarkdownRender,
} from '../lib/markdown-render-preflight.mjs';

void test('line endings count once and a final empty line remains visible', () => {
  assert.deepEqual(markdownRenderPreflight('').metrics, {
    totalLines: 1,
    maximumLineBytes: 0,
    maximumBlockLines: 0,
    maximumBlockBytes: 0,
  });
  assert.equal(markdownRenderPreflight('a\r\nb\rc\nd\n').metrics.totalLines, 5);
  assert.equal(markdownRenderPreflight('a\r\nb').metrics.maximumBlockBytes, 4);
});

void test('line byte limit is inclusive and uses UTF-8 without changing UTF-16 offsets', () => {
  const asciiBoundary = 'a'.repeat(MARKDOWN_RENDER_LIMITS.lineBytes);
  assert.equal(markdownRenderPreflight(asciiBoundary).mode, 'gfm');
  assert.equal(markdownRenderPreflight(asciiBoundary + 'a').reason, 'line');

  const unicodeBoundary = '😀'.repeat(MARKDOWN_RENDER_LIMITS.lineBytes / 4);
  const unicode = markdownRenderPreflight(unicodeBoundary);
  assert.equal(unicode.mode, 'gfm');
  assert.equal(
    unicode.metrics.maximumLineBytes,
    MARKDOWN_RENDER_LIMITS.lineBytes,
  );
  assert.equal(unicodeBoundary.length, MARKDOWN_RENDER_LIMITS.lineBytes / 2);
  assert.equal(markdownRenderPreflight(unicodeBoundary + '€').reason, 'line');

  assert.equal(markdownRenderPreflight('\ud800').metrics.maximumLineBytes, 3);
  assert.equal(
    markdownRenderPreflight('\ufefftexto').metrics.maximumLineBytes,
    8,
  );
});

void test('continuous block limits are inclusive for original terminator bytes', () => {
  const exactLines = 'a\n'.repeat(MARKDOWN_RENDER_LIMITS.blockLines);
  const atLineLimit = markdownRenderPreflight(exactLines);
  assert.equal(atLineLimit.mode, 'gfm');
  assert.equal(
    atLineLimit.metrics.maximumBlockLines,
    MARKDOWN_RENDER_LIMITS.blockLines,
  );
  assert.equal(markdownRenderPreflight(exactLines + 'a').reason, 'block-lines');

  const exactBytes = `${'a'.repeat(63)}\n`.repeat(1024);
  const atByteLimit = markdownRenderPreflight(exactBytes);
  assert.equal(atByteLimit.mode, 'gfm');
  assert.equal(
    atByteLimit.metrics.maximumBlockBytes,
    MARKDOWN_RENDER_LIMITS.blockBytes,
  );
  const overBytes = `${'a'.repeat(64)}\n${`${'a'.repeat(63)}\n`.repeat(1023)}`;
  assert.equal(markdownRenderPreflight(overBytes).reason, 'block-bytes');
});

void test('only ASCII spaces and tabs make a blank line', () => {
  const asciiBlank = markdownRenderPreflight('a\n \t\r\nb');
  assert.equal(asciiBlank.metrics.maximumBlockLines, 1);
  const unicodeSpace = markdownRenderPreflight('a\n\u00a0\nb');
  assert.equal(unicodeSpace.metrics.maximumBlockLines, 3);
});

void test('total rendered line limit is inclusive across many small blocks', () => {
  const exact = `${'a\n\n'.repeat(4999)}a\n`;
  const boundary = markdownRenderPreflight(exact);
  assert.equal(boundary.mode, 'gfm');
  assert.equal(boundary.metrics.totalLines, MARKDOWN_RENDER_LIMITS.totalLines);
  assert.equal(boundary.metrics.maximumBlockLines, 1);
  assert.equal(markdownRenderPreflight(exact + '\n').reason, 'total-lines');
});

void test('raw mode prevents the analysis pass while bounded Markdown enters it', () => {
  let calls = 0;
  const analyzer = (markdown: string) => {
    calls += 1;
    return { headingIds: { 0: markdown }, references: [] };
  };
  const raw = prepareMarkdownRender(
    'x'.repeat(MARKDOWN_RENDER_LIMITS.lineBytes + 1),
    analyzer,
  );
  assert.equal(raw.preflight.mode, 'raw');
  assert.deepEqual(raw.analysis, { headingIds: {}, references: [] });
  assert.equal(calls, 0);

  const rich = prepareMarkdownRender('# título', analyzer);
  assert.equal(rich.preflight.mode, 'gfm');
  assert.deepEqual(rich.analysis.headingIds, { 0: '# título' });
  assert.equal(calls, 1);
});
