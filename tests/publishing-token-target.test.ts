import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planIdFromTarget } from '../lib/publishing-token-target.ts';

const origin = 'https://docs.example.com';
const id = '10000000-0000-7000-8000-000000000001';

void test('alvo aceita ID ou link do serviço sem transformar o texto em acesso', () => {
  assert.equal(planIdFromTarget(id, origin), id);
  assert.equal(planIdFromTarget(` ${origin}/d/${id} `, origin), id);
  assert.equal(planIdFromTarget(`https://evil.example/d/${id}`, origin), null);
  assert.equal(planIdFromTarget(`${origin}/documentos/${id}`, origin), null);
  assert.equal(planIdFromTarget('nome-do-plano', origin), null);
});
