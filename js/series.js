// Edição e exclusão de séries recorrentes, no estilo de uma agenda:
// "somente esta", "esta e as próximas" ou "todas". Funções puras: recebem o lançamento
// e devolvem { save: [lançamentos], remove: [ids] } para o store aplicar.

import { addDays, diffDays, firstOccurrence, isRecurring, displayTotal } from './recurrence.js';

const OCC_FIELDS = ['amount', 'description', 'categoryId', 'notes'];

const clone = (x) => JSON.parse(JSON.stringify(x));

function setPaidOnFirst(entry, paid) {
  const first = firstOccurrence(entry);
  if (!first) return entry;
  const ov = { ...(entry.overrides || {}) };
  const o = { ...(ov[first.date] || {}) };
  if (paid) o.paid = true; else delete o.paid;
  if (Object.keys(o).length) ov[first.date] = o; else delete ov[first.date];
  return { ...entry, overrides: ov };
}

// Converte a contagem exibida no formulário (total de parcelas) para a contagem da série.
function withCount(rec, offset) {
  const r = clone(rec);
  if (r.end && r.end.type === 'count') r.end.count = Math.max(1, (parseInt(r.end.count, 10) || 1) - offset);
  return r;
}

export function createEntry(id, vals) {
  const entry = {
    id,
    type: vals.type,
    description: vals.description,
    amount: vals.amount,
    categoryId: vals.categoryId,
    notes: vals.notes || '',
    date: vals.date,
    recurrence: clone(vals.recurrence),
    overrides: {},
  };
  return { save: [setPaidOnFirst(entry, vals.paid)], remove: [] };
}

// Alterações que não cabem em "somente esta" (mudam a regra da série).
export function isStructuralChange(entry, vals) {
  const cur = clone(entry.recurrence || { freq: 'none' });
  if (cur.end && cur.end.type === 'count') cur.end.count = formCount(entry);
  return vals.type !== entry.type || JSON.stringify(normalizeRec(cur)) !== JSON.stringify(normalizeRec(vals.recurrence));
}

// Contagem mostrada no formulário: ocorrências desta série somadas às de séries anteriores.
export function formCount(entry) {
  const end = entry.recurrence && entry.recurrence.end;
  return end && end.type === 'count' ? (parseInt(end.count, 10) || 0) + (entry.ordinalOffset || 0) : null;
}

export function normalizeRec(r) {
  if (!r || !r.freq || r.freq === 'none') return { freq: 'none' };
  const out = { freq: r.freq, interval: Math.max(1, parseInt(r.interval, 10) || 1) };
  if (r.freq === 'monthly') out.byMonthDay = Number(r.byMonthDay);
  if (r.freq === 'weekly') out.byWeekday = [...(r.byWeekday || [])].sort();
  const end = r.end || { type: 'never' };
  out.end = end.type === 'count' ? { type: 'count', count: parseInt(end.count, 10) || 1 }
    : end.type === 'until' ? { type: 'until', until: end.until } : { type: 'never' };
  return out;
}

// Lançamento avulso (não recorrente) ou conversão de avulso para recorrente.
export function updateSingle(entry, vals) {
  const next = {
    ...entry,
    type: vals.type,
    description: vals.description,
    amount: vals.amount,
    categoryId: vals.categoryId,
    notes: vals.notes || '',
    date: vals.date,
    recurrence: clone(vals.recurrence),
    overrides: {},
    ordinalOffset: 0,
    displayTotal: undefined,
  };
  return { save: [setPaidOnFirst(next, vals.paid)], remove: [] };
}

export function applyThis(entry, occ, vals) {
  const ov = { ...(entry.overrides || {}) };
  const o = { ...(ov[occ.origDate] || {}) };
  for (const f of OCC_FIELDS) {
    if ((vals[f] ?? '') !== (entry[f] ?? '')) o[f] = vals[f]; else delete o[f];
  }
  if (vals.date !== occ.origDate) o.date = vals.date; else delete o.date;
  if (vals.paid) o.paid = true; else delete o.paid;
  if (Object.keys(o).length) ov[occ.origDate] = o; else delete ov[occ.origDate];
  return { save: [{ ...entry, overrides: ov }], remove: [] };
}

export function applyAll(entry, occ, vals) {
  const offset = entry.ordinalOffset || 0;
  let start = entry.date;
  if (!occ) start = vals.date;
  else if (vals.date !== occ.date && vals.recurrence.freq !== 'monthly') start = addDays(entry.date, diffDays(occ.date, vals.date));
  const ov = { ...(entry.overrides || {}) };
  if (occ) {
    const o = { ...(ov[occ.origDate] || {}) };
    for (const f of [...OCC_FIELDS, 'date']) delete o[f];
    if (vals.paid) o.paid = true; else delete o.paid;
    if (Object.keys(o).length) ov[occ.origDate] = o; else delete ov[occ.origDate];
  }
  const recurrence = withCount(vals.recurrence, offset);
  const sameCount = JSON.stringify(recurrence.end) === JSON.stringify(entry.recurrence && entry.recurrence.end);
  const next = {
    ...entry,
    type: vals.type,
    description: vals.description,
    amount: vals.amount,
    categoryId: vals.categoryId,
    notes: vals.notes || '',
    date: start,
    recurrence,
    overrides: ov,
    displayTotal: sameCount ? entry.displayTotal : undefined,
  };
  return { save: [next], remove: [] };
}

// Encerra a série antes da ocorrência `occ` (mantém o histórico anterior).
function truncateBefore(entry, occ) {
  const r = clone(entry.recurrence);
  const total = displayTotal(entry);
  if (r.end && r.end.type === 'count') r.end.count = occ.rawN - 1;
  else r.end = { type: 'until', until: addDays(occ.origDate, -1) };
  const ov = {};
  for (const [k, v] of Object.entries(entry.overrides || {})) if (k < occ.origDate) ov[k] = v;
  const head = { ...entry, recurrence: r, overrides: ov };
  if (total) head.displayTotal = total;
  return head;
}

export function applyFuture(entry, occ, vals, newId) {
  if (occ.rawN === 1) return applyAll(entry, occ, vals);
  const head = truncateBefore(entry, occ);
  const tailOffset = (entry.ordinalOffset || 0) + occ.rawN - 1;
  const ov = {};
  for (const [k, v] of Object.entries(entry.overrides || {})) if (k > occ.origDate) ov[k] = v;
  const tail = {
    id: newId,
    type: vals.type,
    description: vals.description,
    amount: vals.amount,
    categoryId: vals.categoryId,
    notes: vals.notes || '',
    date: vals.date,
    recurrence: withCount(vals.recurrence, tailOffset),
    overrides: ov,
    ordinalOffset: tailOffset,
    seriesOf: entry.seriesOf || entry.id,
  };
  return { save: [head, setPaidOnFirst(tail, vals.paid)], remove: [] };
}

export function deleteOccurrence(entry, occ, scope) {
  if (!isRecurring(entry) || scope === 'all' || (scope === 'future' && occ.rawN === 1)) {
    return { save: [], remove: [entry.id] };
  }
  if (scope === 'future') return { save: [truncateBefore(entry, occ)], remove: [] };
  const ov = { ...(entry.overrides || {}) };
  ov[occ.origDate] = { skip: true };
  return { save: [{ ...entry, overrides: ov }], remove: [] };
}

export function togglePaid(entry, occ) {
  const ov = { ...(entry.overrides || {}) };
  const o = { ...(ov[occ.origDate] || {}) };
  if (o.paid) delete o.paid; else o.paid = true;
  if (Object.keys(o).length) ov[occ.origDate] = o; else delete ov[occ.origDate];
  return { ...entry, overrides: ov };
}
