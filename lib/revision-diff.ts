const MAX_MARKDOWN_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_LINE_PRODUCT = 1_000_000;
const MAX_RENDER_LINES = 500;
const MAX_RENDER_BYTES = 128 * 1024;

export const REVISION_DIFF_UNAVAILABLE =
  'Comparação detalhada indisponível neste tamanho';

export type RevisionDiffLine = {
  kind: 'equal' | 'added' | 'removed';
  text: string;
};

export type RevisionTextFormat = {
  bom: boolean;
  lineEndings: 'none' | 'LF' | 'CRLF' | 'CR' | 'mixed';
  finalNewline: boolean;
};

export type RevisionDiff = {
  available: boolean;
  message: string | null;
  identical: boolean;
  bomChanged: boolean;
  lineEndingsChanged: boolean;
  before: RevisionTextFormat;
  after: RevisionTextFormat;
  lines: RevisionDiffLine[];
};

type ParsedMarkdown = RevisionTextFormat & {
  lines: string[];
  terminators: Uint8Array;
  oversizedLine: boolean;
};

const encoder = new TextEncoder();

function parsedMarkdown(markdown: string): ParsedMarkdown {
  const bom = markdown.startsWith('\uFEFF');
  const text = bom ? markdown.slice(1) : markdown;
  const lines: string[] = [];
  const terminators: number[] = [];
  const byteLengths = new Map<string, number>();
  let oversizedLine = false;
  let start = 0;
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  const pushLine = (end: number, terminator: 0 | 1 | 2 | 3) => {
    const line = text.slice(start, end);
    lines.push(line);
    let bytes = byteLengths.get(line);
    if (bytes === undefined) {
      bytes = encoder.encode(line).byteLength;
      byteLengths.set(line, bytes);
    }
    if (bytes > MAX_LINE_BYTES) oversizedLine = true;
    if (terminator !== 0) terminators.push(terminator);
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charCodeAt(index);
    if (character === 10) {
      pushLine(index, 1);
      lf += 1;
      start = index + 1;
    } else if (character === 13) {
      if (text.charCodeAt(index + 1) === 10) {
        pushLine(index, 2);
        crlf += 1;
        index += 1;
      } else {
        pushLine(index, 3);
        cr += 1;
      }
      start = index + 1;
    }
  }
  if (start < text.length) pushLine(text.length, 0);
  const styles = Number(lf > 0) + Number(crlf > 0) + Number(cr > 0);
  return {
    bom,
    lines,
    terminators: Uint8Array.from(terminators),
    oversizedLine,
    lineEndings:
      styles === 0
        ? 'none'
        : styles > 1
          ? 'mixed'
          : lf
            ? 'LF'
            : crlf
              ? 'CRLF'
              : 'CR',
    finalNewline: terminators.length > 0 && start === text.length,
  };
}

function markdownFormat(markdown: string): ParsedMarkdown {
  const bom = markdown.startsWith('\uFEFF');
  const text = bom ? markdown.slice(1) : markdown;
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  let finalNewline = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charCodeAt(index);
    if (character === 10) {
      lf += 1;
      finalNewline = index === text.length - 1;
    } else if (character === 13) {
      if (text.charCodeAt(index + 1) === 10) {
        crlf += 1;
        index += 1;
      } else cr += 1;
      finalNewline = index === text.length - 1;
    } else finalNewline = false;
  }
  const styles = Number(lf > 0) + Number(crlf > 0) + Number(cr > 0);
  return {
    bom,
    lines: [],
    terminators: new Uint8Array(),
    oversizedLine: false,
    lineEndings:
      styles === 0
        ? 'none'
        : styles > 1
          ? 'mixed'
          : lf
            ? 'LF'
            : crlf
              ? 'CRLF'
              : 'CR',
    finalNewline,
  };
}

function exactBytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

function exactLinesEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

function formatOf(parsed: ParsedMarkdown): RevisionTextFormat {
  return {
    bom: parsed.bom,
    lineEndings: parsed.lineEndings,
    finalNewline: parsed.finalNewline,
  };
}

function unavailable(
  before: ParsedMarkdown,
  after: ParsedMarkdown,
  bomChanged: boolean,
  lineEndingsChanged: boolean,
): RevisionDiff {
  return {
    available: false,
    message: REVISION_DIFF_UNAVAILABLE,
    identical: false,
    bomChanged,
    lineEndingsChanged,
    before: formatOf(before),
    after: formatOf(after),
    lines: [],
  };
}

export function compareRevisionMarkdown(
  beforeMarkdown: string,
  afterMarkdown: string,
): RevisionDiff {
  const beforeBytes = encoder.encode(beforeMarkdown).byteLength;
  const afterBytes = encoder.encode(afterMarkdown).byteLength;
  if (beforeBytes > MAX_MARKDOWN_BYTES || afterBytes > MAX_MARKDOWN_BYTES) {
    const before = markdownFormat(beforeMarkdown);
    const after = markdownFormat(afterMarkdown);
    return unavailable(
      before,
      after,
      before.bom !== after.bom,
      before.lineEndings !== after.lineEndings ||
        before.finalNewline !== after.finalNewline,
    );
  }
  const before = parsedMarkdown(beforeMarkdown);
  const after = parsedMarkdown(afterMarkdown);
  const bomChanged = before.bom !== after.bom;
  const sameLines = exactLinesEqual(before.lines, after.lines);
  const lineEndingsChanged =
    before.lineEndings !== after.lineEndings ||
    before.finalNewline !== after.finalNewline ||
    (sameLines && !exactBytesEqual(before.terminators, after.terminators));
  if (before.oversizedLine || after.oversizedLine)
    return unavailable(before, after, bomChanged, lineEndingsChanged);

  if (sameLines)
    return {
      available: true,
      message: null,
      identical: beforeMarkdown === afterMarkdown,
      bomChanged,
      lineEndingsChanged,
      before: formatOf(before),
      after: formatOf(after),
      lines: [],
    };

  const beforeCount = before.lines.length;
  const afterCount = after.lines.length;
  if (
    beforeCount !== 0 &&
    afterCount > Math.floor(MAX_LINE_PRODUCT / beforeCount)
  )
    return unavailable(before, after, bomChanged, lineEndingsChanged);
  const product = beforeCount * afterCount;
  if (!Number.isSafeInteger(product) || product > MAX_LINE_PRODUCT)
    return unavailable(before, after, bomChanged, lineEndingsChanged);

  const interned = new Map<string, number>();
  let nextId = 1;
  const intern = (line: string) => {
    const existing = interned.get(line);
    if (existing !== undefined) return existing;
    const id = nextId++;
    interned.set(line, id);
    return id;
  };
  const beforeIds = Uint32Array.from(before.lines.map(intern));
  const afterIds = Uint32Array.from(after.lines.map(intern));
  const directions = new Uint8Array(product);
  let previous = new Uint32Array(afterCount + 1);
  let current = new Uint32Array(afterCount + 1);
  for (let beforeIndex = 1; beforeIndex <= beforeCount; beforeIndex += 1) {
    current[0] = 0;
    for (let afterIndex = 1; afterIndex <= afterCount; afterIndex += 1) {
      const directionIndex =
        (beforeIndex - 1) * afterCount + afterIndex - 1;
      if (beforeIds[beforeIndex - 1] === afterIds[afterIndex - 1]) {
        current[afterIndex] = previous[afterIndex - 1]! + 1;
        directions[directionIndex] = 1;
      } else if (previous[afterIndex]! >= current[afterIndex - 1]!) {
        current[afterIndex] = previous[afterIndex]!;
        directions[directionIndex] = 2;
      } else {
        current[afterIndex] = current[afterIndex - 1]!;
        directions[directionIndex] = 3;
      }
    }
    [previous, current] = [current, previous];
  }

  const reversed: RevisionDiffLine[] = [];
  let renderBytes = 0;
  let beforeIndex = beforeCount;
  let afterIndex = afterCount;
  const append = (line: RevisionDiffLine) => {
    renderBytes += encoder.encode(line.text).byteLength + 1;
    if (
      reversed.length + 1 > MAX_RENDER_LINES ||
      renderBytes > MAX_RENDER_BYTES
    )
      return false;
    reversed.push(line);
    return true;
  };
  while (beforeIndex > 0 || afterIndex > 0) {
    const direction =
      beforeIndex > 0 && afterIndex > 0
        ? directions[(beforeIndex - 1) * afterCount + afterIndex - 1]
        : beforeIndex > 0
          ? 2
          : 3;
    if (direction === 1) {
      if (
        !append({ kind: 'equal', text: before.lines[beforeIndex - 1]! })
      )
        return unavailable(before, after, bomChanged, lineEndingsChanged);
      beforeIndex -= 1;
      afterIndex -= 1;
    } else if (direction === 2) {
      if (
        !append({ kind: 'removed', text: before.lines[beforeIndex - 1]! })
      )
        return unavailable(before, after, bomChanged, lineEndingsChanged);
      beforeIndex -= 1;
    } else {
      if (!append({ kind: 'added', text: after.lines[afterIndex - 1]! }))
        return unavailable(before, after, bomChanged, lineEndingsChanged);
      afterIndex -= 1;
    }
  }
  reversed.reverse();
  return {
    available: true,
    message: null,
    identical: false,
    bomChanged,
    lineEndingsChanged,
    before: formatOf(before),
    after: formatOf(after),
    lines: reversed,
  };
}
