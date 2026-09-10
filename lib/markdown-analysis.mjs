import GithubSlugger from 'github-slugger';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';

const parser = unified().use(remarkParse).use(remarkGfm);
const windowsPath = /^[a-z]:[\\/]/i;
const scheme = /^[a-z][a-z\d+.-]*:/i;

function textOf(node) {
  if (node.type === 'html') return '';
  if (typeof node.alt === 'string') return node.alt;
  if (typeof node.value === 'string') return node.value;
  return (node.children ?? []).map(textOf).join('');
}

/**
 * Classifies a Markdown destination without resolving, reading, or fetching it.
 */
export function classifyMarkdownUrl(url) {
  if (url.startsWith('#')) return 'fragment';
  if (url.startsWith('//')) return 'protocol-relative';
  if (windowsPath.test(url)) return 'windows-path';
  // remark normalizes Markdown backslash escapes, so an UNC path can arrive
  // with one leading backslash even when the source used two.
  if (url.charCodeAt(0) === 92) return 'unc-path';
  if (url.startsWith('/')) return 'root-relative';
  if (/^file:/i.test(url)) return 'file';
  if (/^data:/i.test(url)) return 'data';
  if (/^https?:\/\/[^\\/?#]+/i.test(url) && !url.includes('\\')) return 'web';
  if (/^mailto:/i.test(url)) return 'mailto';
  if (scheme.test(url)) return 'unsupported-scheme';
  return 'relative';
}

export function isNavigableMarkdownUrl(kind, image = false) {
  return kind === 'web' || (!image && (kind === 'fragment' || kind === 'mailto'));
}

export function warningMessage(reference) {
  const type = reference.image ? 'imagem' : 'link';
  const descriptions = {
    relative: 'referência relativa que não acompanha a publicação',
    'root-relative': 'caminho a partir da raiz local que não acompanha a publicação',
    file: 'URL file:// local que não acompanha a publicação',
    'windows-path': 'caminho local do Windows que não acompanha a publicação',
    'unc-path': 'caminho de rede Windows/UNC que não acompanha a publicação',
    'protocol-relative': 'URL sem protocolo, não suportada',
    data: 'URL data:, não suportada',
    mailto: 'URL mailto: não pode ser usada como imagem',
    'unsupported-scheme': 'esquema de URL não suportado',
  };
  const visibleUrl = reference.url.replace(/\p{Cc}/gu, (character) =>
    `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`,
  );
  return `${type} ${descriptions[reference.kind] ?? 'não publicado'}: ${visibleUrl}`;
}

/**
 * Returns deterministic heading ids and non-navigable Markdown references.
 * Offsets are UTF-16 positions in the original JavaScript string.
 */
export function analyzeMarkdown(markdown) {
  const tree = parser.parse(markdown);
  const slugger = new GithubSlugger();
  const headingIds = {};
  const definitions = new Map();
  const references = [];

  visit(tree, 'definition', (node) => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url ?? '');
  });
  visit(tree, 'heading', (node) => {
    const offset = node.position?.start.offset;
    if (offset !== undefined) {
      const text = textOf(node).trim() || `section-${offset}`;
      const base = new GithubSlugger().slug(text) || `section-${offset}`;
      headingIds[offset] = slugger.slug(base);
    }
  });
  visit(tree, (node) => {
    const image = node.type === 'image' || node.type === 'imageReference';
    const link = node.type === 'link' || node.type === 'linkReference';
    if (!image && !link) return;
    const url =
      node.type === 'linkReference' || node.type === 'imageReference'
        ? definitions.get(node.identifier)
        : node.url;
    if (!url) return;
    const kind = classifyMarkdownUrl(url);
    if (isNavigableMarkdownUrl(kind, image)) return;
    references.push({
      url,
      kind,
      image,
      offset: node.position?.start.offset ?? 0,
      line: node.position?.start.line ?? 1,
      label: node.label ?? textOf(node),
    });
  });

  return { headingIds, references };
}
