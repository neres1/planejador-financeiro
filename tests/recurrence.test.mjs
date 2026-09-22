import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrencesBetween, expand, nextOccurrence } from '../js/recurrence.js';
import { applyThis, applyFuture, applyAll, deleteOccurrence, createEntry } from '../js/series.js';
import { merge } from '../js/store.js';

const dates = (e, from, to) => occurrencesBetween(e, from, to).map((o) => o.date);
const monthly = (extra = {}) => ({
  id: 'a', type: 'despesa', amount: 1000, description: 'Aluguel', categoryId: 'cat-moradia', date: '2026-01-10',
  recurrence: { freq: 'monthly', interval: 1, byMonthDay: 10, end: { type: 'never' } }, overrides: {}, ...extra,
});

test('mensal no dia escolhido', () => {
  assert.deepEqual(dates(monthly(), '2026-01-01', '2026-04-30'), ['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10']);
});

test('dia 31 cai no último dia dos meses curtos', () => {
  const e = monthly({ date: '2026-01-31', recurrence: { freq: 'monthly', byMonthDay: 31, end: { type: 'never' } } });
  assert.deepEqual(dates(e, '2026-01-01', '2026-04-30'), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
});

test('último dia do mês (-1) e ano bissexto', () => {
  const e = monthly({ date: '2028-01-05', recurrence: { freq: 'monthly', byMonthDay: -1, end: { type: 'never' } } });
  assert.deepEqual(dates(e, '2028-01-01', '2028-03-31'), ['2028-01-31', '2028-02-29', '2028-03-31']);
});

test('dia da cobrança anterior à data inicial começa no mês seguinte', () => {
  const e = monthly({ date: '2026-01-20', recurrence: { freq: 'monthly', byMonthDay: 5, end: { type: 'never' } } });
  assert.deepEqual(dates(e, '2026-01-01', '2026-03-31'), ['2026-02-05', '2026-03-05']);
});

test('parcelas: termina após N vezes e numera n/total', () => {
  const e = monthly({ recurrence: { freq: 'monthly', byMonthDay: 10, end: { type: 'count', count: 3 } } });
  const occ = expand(e, '2026-01-01', '2026-12-31');
  assert.deepEqual(occ.map((o) => `${o.n}/${o.total}`), ['1/3', '2/3', '3/3']);
});

test('termina em data', () => {
  const e = monthly({ recurrence: { freq: 'monthly', byMonthDay: 10, end: { type: 'until', until: '2026-03-10' } } });
  assert.deepEqual(dates(e, '2026-01-01', '2026-12-31'), ['2026-01-10', '2026-02-10', '2026-03-10']);
});

test('a cada 2 meses', () => {
  const e = monthly({ recurrence: { freq: 'monthly', interval: 2, byMonthDay: 10, end: { type: 'never' } } });
  assert.deepEqual(dates(e, '2026-01-01', '2026-06-30'), ['2026-01-10', '2026-03-10', '2026-05-10']);
});

test('semanal em vários dias', () => {
  // 2026-09-21 é segunda-feira
  const e = monthly({ date: '2026-09-21', recurrence: { freq: 'weekly', interval: 1, byWeekday: [1, 3], end: { type: 'never' } } });
  assert.deepEqual(dates(e, '2026-09-01', '2026-10-02'), ['2026-09-21', '2026-09-23', '2026-09-28', '2026-09-30']);
});

test('anual em 29/02 cai em 28/02 nos anos comuns', () => {
  const e = monthly({ date: '2028-02-29', recurrence: { freq: 'yearly', interval: 1, end: { type: 'never' } } });
  assert.deepEqual(dates(e, '2028-01-01', '2030-12-31'), ['2028-02-29', '2029-02-28', '2030-02-28']);
});

test('lançamento avulso aparece uma vez', () => {
  const e = monthly({ recurrence: { freq: 'none' } });
  assert.deepEqual(dates(e, '2026-01-01', '2026-12-31'), ['2026-01-10']);
});

test('somente esta: altera valor e marca paga só nessa ocorrência', () => {
  const e = monthly();
  const [occ] = expand(e, '2026-02-01', '2026-02-28');
  const { save: [next] } = applyThis(e, occ, { ...e, amount: 1500, paid: true, date: occ.date });
  const got = expand(next, '2026-01-01', '2026-03-31').map((o) => [o.amount, o.paid]);
  assert.deepEqual(got, [[1000, false], [1500, true], [1000, false]]);
});

test('somente esta: mudar a data move a ocorrência', () => {
  const e = monthly();
  const [occ] = expand(e, '2026-02-01', '2026-02-28');
  const { save: [next] } = applyThis(e, occ, { ...e, date: '2026-02-15' });
  assert.deepEqual(expand(next, '2026-02-01', '2026-02-28').map((o) => o.date), ['2026-02-15']);
});

test('esta e as próximas: divide a série e mantém a numeração das parcelas', () => {
  const e = monthly({ recurrence: { freq: 'monthly', interval: 1, byMonthDay: 10, end: { type: 'count', count: 6 } } });
  const occ = expand(e, '2026-03-01', '2026-03-31')[0];
  const vals = { ...e, amount: 2000, paid: false, date: occ.date, recurrence: { ...e.recurrence, end: { type: 'count', count: 6 } } };
  const { save: [head, tail] } = applyFuture(e, occ, vals, 'b');
  const all = [...expand(head, '2026-01-01', '2026-12-31'), ...expand(tail, '2026-01-01', '2026-12-31')];
  assert.deepEqual(all.map((o) => `${o.date}:${o.amount}:${o.n}/${o.total}`), [
    '2026-01-10:1000:1/6', '2026-02-10:1000:2/6',
    '2026-03-10:2000:3/6', '2026-04-10:2000:4/6', '2026-05-10:2000:5/6', '2026-06-10:2000:6/6',
  ]);
});

test('todas: altera o valor da série inteira', () => {
  const e = monthly();
  const occ = expand(e, '2026-03-01', '2026-03-31')[0];
  const { save: [next] } = applyAll(e, occ, { ...e, amount: 1200, date: occ.date, paid: false });
  assert.ok(expand(next, '2026-01-01', '2026-06-30').every((o) => o.amount === 1200));
});

test('excluir somente esta / esta e as próximas', () => {
  const e = monthly();
  const occ = expand(e, '2026-03-01', '2026-03-31')[0];
  const one = deleteOccurrence(e, occ, 'this').save[0];
  assert.deepEqual(expand(one, '2026-01-01', '2026-04-30').map((o) => o.date), ['2026-01-10', '2026-02-10', '2026-04-10']);
  const fut = deleteOccurrence(e, occ, 'future').save[0];
  assert.deepEqual(expand(fut, '2026-01-01', '2026-12-31').map((o) => o.date), ['2026-01-10', '2026-02-10']);
  assert.equal(nextOccurrence(fut, '2026-09-22'), null);
});

test('novo lançamento pago marca a primeira ocorrência real', () => {
  const vals = { type: 'despesa', amount: 100, description: 'x', categoryId: 'c', date: '2026-01-20', paid: true, notes: '',
    recurrence: { freq: 'monthly', interval: 1, byMonthDay: 5, end: { type: 'never' } } };
  const { save: [e] } = createEntry('z', vals);
  assert.deepEqual(Object.keys(e.overrides), ['2026-02-05']);
});

test('mesclagem: vence a alteração mais recente e exclusões se propagam', () => {
  const a = { categories: [], entries: [{ id: '1', amount: 1, updatedAt: '2026-01-01' }, { id: '2', amount: 5, updatedAt: '2026-01-01' }] };
  const b = { categories: [], entries: [{ id: '1', amount: 9, updatedAt: '2026-02-01' }, { id: '2', deleted: true, updatedAt: '2026-03-01' }, { id: '3', amount: 3, updatedAt: '2026-01-01' }] };
  const m = merge(a, b);
  assert.deepEqual(m.entries.map((e) => [e.id, e.amount ?? 'x', !!e.deleted]), [['1', 9, false], ['2', 'x', true], ['3', 3, false]]);
});
