export const MARKDOWN_RENDER_LIMITS = Object.freeze({
  lineBytes: 16 * 1024,
  blockLines: 1024,
  blockBytes: 64 * 1024,
  totalLines: 10_000,
});

const emptyAnalysis = Object.freeze({ headingIds: {}, references: [] });

function utf8Width(source, index) {
  const code = source.charCodeAt(index);
  if (code <= 0x7f) return { bytes: 1, width: 1 };
  if (code <= 0x7ff) return { bytes: 2, width: 1 };
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = source.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return { bytes: 4, width: 2 };
  }
  return { bytes: 3, width: 1 };
}

/**
 * Chooses the Markdown reading mode without parsing or normalizing the source.
 * Line offsets remain JavaScript UTF-16 offsets; only render budgets use UTF-8.
 */
export function markdownRenderPreflight(
  markdown,
  limits = MARKDOWN_RENDER_LIMITS,
) {
  let totalLines = 1;
  let lineBytes = 0;
  let lineIsBlank = true;
  let blockLines = 0;
  let blockBytes = 0;
  let maximumLineBytes = 0;
  let maximumBlockLines = 0;
  let maximumBlockBytes = 0;
  let exceeded = null;

  const finishLine = (terminatorBytes) => {
    maximumLineBytes = Math.max(maximumLineBytes, lineBytes);
    if (!exceeded && lineBytes > limits.lineBytes) exceeded = 'line';

    if (lineIsBlank) {
      blockLines = 0;
      blockBytes = 0;
    } else {
      blockLines += 1;
      blockBytes += lineBytes + terminatorBytes;
      maximumBlockLines = Math.max(maximumBlockLines, blockLines);
      maximumBlockBytes = Math.max(maximumBlockBytes, blockBytes);
      if (!exceeded && blockLines > limits.blockLines) exceeded = 'block-lines';
      if (!exceeded && blockBytes > limits.blockBytes) exceeded = 'block-bytes';
    }
    lineBytes = 0;
    lineIsBlank = true;
  };

  for (let index = 0; index < markdown.length;) {
    const code = markdown.charCodeAt(index);
    if (code === 0x0d || code === 0x0a) {
      const crlf = code === 0x0d && markdown.charCodeAt(index + 1) === 0x0a;
      finishLine(crlf ? 2 : 1);
      totalLines += 1;
      if (!exceeded && totalLines > limits.totalLines) exceeded = 'total-lines';
      index += crlf ? 2 : 1;
      continue;
    }

    const width = utf8Width(markdown, index);
    lineBytes += width.bytes;
    if (code !== 0x20 && code !== 0x09) lineIsBlank = false;
    index += width.width;
  }
  finishLine(0);

  const metrics = {
    totalLines,
    maximumLineBytes,
    maximumBlockLines,
    maximumBlockBytes,
  };
  return exceeded
    ? { mode: 'raw', reason: exceeded, metrics }
    : { mode: 'gfm', reason: null, metrics };
}

/**
 * The current-document analysis goes through this gate before the GFM parser.
 * Supplying the analyzer keeps the boundary observable in unit tests.
 */
export function prepareMarkdownRender(markdown, analyzer) {
  const preflight = markdownRenderPreflight(markdown);
  return {
    preflight,
    analysis: preflight.mode === 'gfm' ? analyzer(markdown) : emptyAnalysis,
  };
}
