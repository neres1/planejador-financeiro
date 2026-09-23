// Cartões de crédito (puro, sem DOM): ciclo da fatura, total da fatura, limite usado e parcelas.
//
// card = { id: 'card-…', name, emoji, color, limit (centavos), dueDay: 1..31, closeDays: 7, archived }
// Despesa no crédito: entry.payment = 'credito', entry.cardId; parcelada: entry.installments = N
// e entry.totalAmount (valor da compra); a série é mensal com N ocorrências.
//
// Regra do ciclo: a fatura fecha `closeDays` dias corridos antes do vencimento. A compra entra
// na primeira fatura cujo fechamento é no mesmo dia ou depois dela, e conta como gasto do mês
// em que essa fatura fecha. Ex.: vence 03/04, fecha 27/03 → compras até 27/03 contam em março;
// a partir de 28/03, na fatura que vence 03/05 (fecha 26/04), contando em abril.

import { toISO, parseISO, daysInMonth, addDays, addMonths, expand } from './recurrence.js';

export const PAYMENTS = {
  debito: { label: 'Débito', icon: '🏧' },
  pix: { label: 'Pix', icon: '⚡' },
  dinheiro: { label: 'Dinheiro', icon: '💵' },
  credito: { label: 'Crédito', icon: '💳' },
};

// Forma de pagamento de uma despesa (lançamentos antigos, sem o campo, são débito).
export const paymentOf = (e) => (e && e.type === 'despesa' ? (PAYMENTS[e.payment] ? e.payment : 'debito') : null);
export const isCredit = (e) => !!e && e.type === 'despesa' && e.payment === 'credito' && !!e.cardId;

export const DEFAULT_CLOSE_DAYS = 7;
export const closeDaysOf = (card) => Math.min(28, Math.max(1, parseInt(card.closeDays, 10) || DEFAULT_CLOSE_DAYS));

const ymOf = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
export const invoiceId = (cardId, dueYM) => `inv-${cardId}-${dueYM}`;

// Fatura que vence no mês `dueYM`: { dueYM, due, close, ym } — `ym` é o mês em que os gastos contam.
export function invoiceOf(card, dueYM) {
  const [y, m] = dueYM.split('-').map(Number);
  const due = toISO(y, m, Math.min(Math.max(1, parseInt(card.dueDay, 10) || 1), daysInMonth(y, m)));
  const close = addDays(due, -closeDaysOf(card));
  return { dueYM, due, close, ym: close.slice(0, 7) };
}

// Fatura em que entra uma compra feita em `date`.
export function invoiceFor(card, date) {
  const { y, m } = parseISO(date);
  for (let k = 0; k <= 3; k++) {
    const n = addMonths(y, m, k);
    const inv = invoiceOf(card, ymOf(n.y, n.m));
    if (inv.close >= date) return inv;
  }
  return invoiceOf(card, ymOf(y, m)); // inalcançável com closeDays ≤ 28
}

// Fatura cujos gastos contam no mês `ym` (a que fecha naquele mês).
export function invoiceForMonth(card, ym) {
  const [y, m] = ym.split('-').map(Number);
  for (let k = 0; k <= 1; k++) {
    const n = addMonths(y, m, k);
    const inv = invoiceOf(card, ymOf(n.y, n.m));
    if (inv.ym === ym) return inv;
  }
  return invoiceOf(card, ym);
}

// Compras (ocorrências) no cartão com data em [from, to], já com a fatura de cada uma.
export function cardOccurrences(card, entries, from, to) {
  const out = [];
  for (const e of entries) {
    if (!isCredit(e) || e.cardId !== card.id) continue;
    for (const o of expand(e, from, to)) out.push({ ...o, payment: 'credito', cardId: card.id, credit: true, inv: invoiceFor(card, o.date) });
  }
  return out;
}

// Compras que compõem a fatura que vence em `dueYM`.
export function invoiceItems(card, entries, dueYM) {
  const inv = invoiceOf(card, dueYM);
  return cardOccurrences(card, entries, addDays(inv.close, -40), inv.close).filter((o) => o.inv.dueYM === dueYM);
}

// Limite ocupado hoje: compras já feitas cujas faturas ainda não foram pagas. Compra parcelada
// ocupa o valor total desde o dia da compra; cada fatura paga devolve a parcela dela.
// Recorrência comum (ex.: assinatura) só ocupa as cobranças que já aconteceram.
export function cardUsed(card, entries, isPaid, today) {
  let used = 0;
  for (const e of entries) {
    if (!isCredit(e) || e.cardId !== card.id || e.date > today) continue;
    const to = e.installments > 1 ? addDays(e.date, 31 * (e.installments + 1)) : today;
    for (const o of expand(e, e.date, to)) {
      if (!(e.installments > 1) && o.date > today) continue;
      if (!isPaid(invoiceFor(card, o.date).dueYM)) used += o.amount;
    }
  }
  return used;
}

// Divide o valor da compra em N parcelas; os centavos que sobram vão na primeira.
export function splitInstallments(total, n) {
  const base = Math.floor(total / n);
  return { base, first: total - base * (n - 1) };
}

// Recorrência de uma compra parcelada: mensal, no dia da compra, N vezes.
export function installmentRecurrence(date, n) {
  return { freq: 'monthly', interval: 1, byMonthDay: parseISO(date).d, end: { type: 'count', count: n } };
}

// Ajusta os valores das parcelas depois de criar/editar: tira valores avulsos e põe a sobra na 1ª.
export function normalizeInstallments(entry) {
  const ov = {};
  for (const [k, v] of Object.entries(entry.overrides || {})) {
    const { amount, ...rest } = v;
    if (Object.keys(rest).length) ov[k] = rest;
  }
  if (entry.installments > 1 && entry.totalAmount) {
    const { base, first } = splitInstallments(entry.totalAmount, entry.installments);
    if (first !== base) ov[entry.date] = { ...(ov[entry.date] || {}), amount: first };
    return { ...entry, amount: base, overrides: ov };
  }
  return { ...entry, overrides: ov };
}
