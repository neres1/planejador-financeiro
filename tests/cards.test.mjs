import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  invoiceOf, invoiceFor, invoiceForMonth, invoiceItems, cardUsed, splitInstallments,
  installmentRecurrence, normalizeInstallments, paymentOf, openInvoiceTotal, triggeredAlerts,
} from '../js/cards.js';
import { createEntry, applyAll, isStructuralChange } from '../js/series.js';
import { merge, emptyDoc, kindOf } from '../js/store.js';

const card = (extra = {}) => ({ id: 'card-nu', name: 'Nubank', limit: 500000, dueDay: 3, closeDays: 7, ...extra });
const buy = (id, date, amount, extra = {}) => ({
  id, type: 'despesa', payment: 'credito', cardId: 'card-nu', amount, description: id, categoryId: 'cat-mercado',
  date, recurrence: { freq: 'none' }, overrides: {}, ...extra,
});

test('fatura fecha 7 dias corridos antes do vencimento', () => {
  assert.deepEqual(invoiceOf(card(), '2026-04'), { dueYM: '2026-04', due: '2026-04-03', close: '2026-03-27', ym: '2026-03' });
  assert.equal(invoiceOf(card({ closeDays: 10 }), '2026-04').close, '2026-03-24');
});

test('compra até o fechamento conta no mês; depois dele, no mês seguinte', () => {
  const c = card();
  assert.equal(invoiceFor(c, '2026-03-15').dueYM, '2026-04');
  assert.equal(invoiceFor(c, '2026-03-27').ym, '2026-03');
  const after = invoiceFor(c, '2026-03-28');
  assert.equal(after.ym, '2026-04');
  assert.equal(after.due, '2026-05-03');
});

test('vencimento no fim do mês: conta no mês do fechamento', () => {
  const c = card({ dueDay: 20 });
  assert.equal(invoiceFor(c, '2026-03-20').ym, '2026-04'); // fecha 13/04, vence 20/04
  assert.equal(invoiceFor(c, '2026-04-13').dueYM, '2026-04');
  assert.equal(invoiceFor(c, '2026-04-14').dueYM, '2026-05');
  assert.equal(invoiceForMonth(c, '2026-04').dueYM, '2026-04');
  assert.equal(invoiceForMonth(card(), '2026-03').dueYM, '2026-04');
});

test('dia 31 em mês curto vence no último dia', () => {
  const inv = invoiceOf(card({ dueDay: 31 }), '2026-02');
  assert.equal(inv.due, '2026-02-28');
  assert.equal(inv.close, '2026-02-21');
});

test('itens da fatura', () => {
  const entries = [buy('a', '2026-02-28', 100), buy('b', '2026-03-27', 200), buy('c', '2026-03-28', 400)];
  assert.deepEqual(invoiceItems(card(), entries, '2026-04').map((o) => o.entryId), ['a', 'b']);
  assert.deepEqual(invoiceItems(card(), entries, '2026-05').map((o) => o.entryId), ['c']);
});

test('parcelas: valor dividido, sobra na 1ª e uma em cada fatura', () => {
  assert.deepEqual(splitInstallments(10000, 3), { base: 3333, first: 3334 });
  const vals = {
    type: 'despesa', payment: 'credito', cardId: 'card-nu', installments: 3, totalAmount: 10000, amount: 3333,
    description: 'TV', categoryId: 'cat-compras', notes: '', date: '2026-03-10', paid: false,
    recurrence: installmentRecurrence('2026-03-10', 3),
  };
  const e = normalizeInstallments(createEntry('tv', vals).save[0]);
  const items = (due) => invoiceItems(card(), [e], due).map((o) => o.amount);
  assert.deepEqual(items('2026-04'), [3334]);
  assert.deepEqual(items('2026-05'), [3333]);
  assert.deepEqual(items('2026-06'), [3333]);
  assert.deepEqual(items('2026-07'), []);

  // limite: ocupa o total na compra; cada fatura paga devolve a parcela
  const paid = new Set();
  const used = (today) => cardUsed(card(), [e], (d) => paid.has(d), today);
  assert.equal(used('2026-03-09'), 0);
  assert.equal(used('2026-03-10'), 10000);
  paid.add('2026-04');
  assert.equal(used('2026-04-05'), 6666);
});

test('recorrente no crédito ocupa só as cobranças que já aconteceram', () => {
  const netflix = buy('n', '2026-01-10', 5590, { recurrence: { freq: 'monthly', interval: 1, byMonthDay: 10, end: { type: 'never' } } });
  const paid = new Set(['2026-02', '2026-03']); // jan (vence 03/02) e fev (vence 03/03) pagas
  assert.equal(cardUsed(card(), [netflix], (d) => paid.has(d), '2026-03-15'), 5590);
});

test('editar compra parcelada recalcula as parcelas', () => {
  const vals = (n, total) => ({
    type: 'despesa', payment: 'credito', cardId: 'card-nu', installments: n, totalAmount: total, amount: Math.floor(total / n),
    description: 'TV', categoryId: 'cat-compras', notes: '', date: '2026-03-10', paid: false, recurrence: installmentRecurrence('2026-03-10', n),
  });
  const e = normalizeInstallments(createEntry('tv', vals(3, 10000)).save[0]);
  assert.ok(isStructuralChange(e, vals(4, 10000)));
  const e2 = normalizeInstallments(applyAll(e, null, vals(4, 10002)).save[0]);
  assert.deepEqual(invoiceItems(card(), [e2], '2026-04').map((o) => o.amount), [2502]);
  assert.equal(e2.recurrence.end.count, 4);
  // virou à vista no débito: some o parcelamento
  const e3 = normalizeInstallments(applyAll(e2, null, { ...vals(1, 0), payment: 'debito', amount: 9000, recurrence: { freq: 'none' } }).save[0]);
  assert.equal(e3.installments, undefined);
  assert.equal(e3.cardId, undefined);
  assert.deepEqual(e3.overrides, {});
});

test('forma de pagamento: despesas antigas são débito', () => {
  assert.equal(paymentOf({ type: 'despesa' }), 'debito');
  assert.equal(paymentOf({ type: 'despesa', payment: 'pix' }), 'pix');
  assert.equal(paymentOf({ type: 'receita' }), null);
});

test('mesclagem inclui cartões e faturas; documentos antigos continuam válidos', () => {
  const old = { schema: 1, updatedAt: '2026-01-01T00:00:00.000Z', categories: [], entries: [] };
  const a = { ...emptyDoc(), cards: [{ ...card(), updatedAt: '2026-01-02T00:00:00.000Z' }], invoices: [{ id: 'inv-card-nu-2026-04', paid: true, updatedAt: '2026-01-02T00:00:00.000Z' }] };
  const m = merge(old, a);
  assert.equal(m.cards.length, 1);
  assert.equal(m.invoices.length, 1);
  assert.equal(kindOf('card-nu'), 'card');
  assert.equal(kindOf('inv-card-nu-2026-04'), 'invoice');
  assert.equal(kindOf('cat-x'), 'category');
  assert.equal(kindOf('m1abc23'), 'entry');
});

test('alertas: disparam quando a fatura em aberto já atingiu o valor', () => {
  const itau = card({ id: 'card-it', dueDay: 20 });
  const entries = [buy('a', '2026-03-10', 150000), buy('b', '2026-03-28', 90000), buy('c', '2026-03-15', 70000, { cardId: 'card-it' })]; // Itaú: fatura que fecha 13/04
  assert.equal(openInvoiceTotal(card(), entries, '2026-03-20'), 150000); // fatura que fecha 27/03
  assert.equal(openInvoiceTotal(card(), entries, '2026-03-28'), 90000); // já na fatura seguinte
  const alerts = [
    { id: 'alert-1', cardId: 'card-nu', amount: 150000, message: 'Nubank passou de 1.500' },
    { id: 'alert-2', cardId: '', amount: 200000, message: 'Somando tudo, 2.000' },
    { id: 'alert-3', cardId: 'card-nu', amount: 100, message: 'desativado', active: false },
  ];
  const msgs = (cardId, date) => triggeredAlerts(alerts, [card(), itau], entries, cardId, date).map((x) => x.alert.message);
  assert.deepEqual(msgs('card-nu', '2026-03-20'), ['Nubank passou de 1.500', 'Somando tudo, 2.000']);
  assert.deepEqual(msgs('card-it', '2026-03-20'), ['Somando tudo, 2.000']);
  assert.deepEqual(msgs('card-nu', '2026-03-28'), []);
});
