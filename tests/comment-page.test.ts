import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentPageFromResponse, mergeComments } from '../lib/comment-page.ts';

const cursor = 'eyJ2IjoxLCJkIjoiZCIsImsiOiJhZnRlciIsInMiOjB9';
const comment = {
  id: '00000000-0000-4000-8000-000000000001',
  body: 'Comentário',
  quote: '',
  source_start: null,
  created_at: '2026-01-01T00:00:00.000Z',
  author_id: 'author',
  author_name: 'Pessoa',
};

void test('página só libera cursor depois de validar todos os comentários', () => {
  const valid = commentPageFromResponse({
    comments: [comment],
    pagination: { olderCursor: null, nextCursor: cursor, hasMore: false },
  });
  assert.deepEqual(valid.comments, [comment]);

  let watermark = 'cursor-anterior';
  for (const comments of [
    [{ ...comment, created_at: 'data inválida' }],
    [{ ...comment, source_start: -1 }],
    [comment, comment],
    Array.from({ length: 101 }, (_, index) => ({
      ...comment,
      id: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-${index
        .toString(16)
        .padStart(12, '0')}`,
    })),
  ])
    assert.throws(() => {
      const page = commentPageFromResponse({
        comments,
        pagination: { olderCursor: null, nextCursor: cursor, hasMore: false },
      });
      watermark = page.pagination.nextCursor;
    });
  assert.equal(watermark, 'cursor-anterior');
  assert.throws(() =>
    commentPageFromResponse({
      comments: [],
      pagination: { olderCursor: null, nextCursor: cursor, hasMore: true },
    }),
  );
});

void test('mescla páginas e confirmações por UUID mantendo a ordem visual', () => {
  const laterSequenceButEarlierTime = {
    ...comment,
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    body: 'Inserido depois',
    created_at: '2025-01-01T00:00:00.000Z',
  };
  const merged = mergeComments(
    [comment],
    [laterSequenceButEarlierTime, { ...comment, body: 'Resposta canônica' }],
  );
  assert.deepEqual(
    merged.map((entry) => [entry.id, entry.body]),
    [
      [laterSequenceButEarlierTime.id, laterSequenceButEarlierTime.body],
      [comment.id, 'Resposta canônica'],
    ],
  );
});
