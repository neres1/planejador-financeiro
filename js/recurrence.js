// Motor de recorrência (puro, sem DOM) — datas sempre como strings ISO "AAAA-MM-DD".
//
// entry.recurrence = {
//   freq: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly',
//   interval: 1,                 // a cada N dias/semanas/meses/anos
//   byMonthDay: 1..31 | -1,      // mensal: dia da cobrança (-1 = último dia do mês)
//   byWeekday: [0..6],           // semanal: 0 = domingo
//   end: { type: 'never' | 'count' | 'until', count, until }
// }
// entry.overrides = { 'AAAA-MM-DD': { skip, paid, amount, description, categoryId, notes, date } }

export const pad = (n) => String(n).padStart(2, '0');
export const toISO = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function addDays(iso, n) {
  const { y, m, d } = parseISO(iso);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function addMonths(y, m, k) {
  const t = y * 12 + (m - 1) + k;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
}

export function weekday(iso) {
  const { y, m, d } = parseISO(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function diffDays(a, b) {
  const pa = parseISO(a), pb = parseISO(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}

export function todayISO(now = new Date()) {
  return toISO(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export const isRecurring = (e) => !!e.recurrence && e.recurrence.freq && e.recurrence.freq !== 'none';

const GUARD = 20000;

// Gera todas as datas da regra, em ordem, a partir da data inicial (sem aplicar o fim).
function* rawDates(entry) {
  const start = entry.date;
  const r = entry.recurrence || {};
  if (!isRecurring(entry)) { yield start; return; }
  const interval = Math.max(1, parseInt(r.interval, 10) || 1);
  const { y: sy, m: sm, d: sd } = parseISO(start);
  let guard = 0;

  if (r.freq === 'daily') {
    for (let k = 0; guard++ < GUARD; k += interval) yield addDays(start, k);
  } else if (r.freq === 'weekly') {
    const days = (r.byWeekday && r.byWeekday.length ? [...new Set(r.byWeekday)] : [weekday(start)]).sort((a, b) => a - b);
    const weekStart = addDays(start, -weekday(start));
    for (let w = 0; guard++ < GUARD; w += interval) {
      for (const wd of days) {
        const dt = addDays(weekStart, w * 7 + wd);
        if (dt >= start) yield dt;
      }
    }
  } else if (r.freq === 'monthly') {
    const bmd = r.byMonthDay == null || r.byMonthDay === '' ? sd : Number(r.byMonthDay);
    for (let k = 0; guard++ < GUARD; k += interval) {
      const { y, m } = addMonths(sy, sm, k);
      const dim = daysInMonth(y, m);
      const dt = toISO(y, m, bmd === -1 ? dim : Math.min(bmd, dim));
      if (dt >= start) yield dt;
    }
  } else if (r.freq === 'yearly') {
    for (let k = 0; guard++ < GUARD; k += interval) {
      const y = sy + k;
      yield toISO(y, sm, Math.min(sd, daysInMonth(y, sm)));
    }
  }
}

// Itera as ocorrências respeitando o fim da série. `n` é o número (1-based) da ocorrência.
export function* iterate(entry) {
  const end = (entry.recurrence && entry.recurrence.end) || { type: 'never' };
  let n = 0;
  for (const date of rawDates(entry)) {
    n++;
    if (isRecurring(entry)) {
      if (end.type === 'count' && n > (parseInt(end.count, 10) || 0)) return;
      if (end.type === 'until' && end.until && date > end.until) return;
    }
    yield { date, n };
  }
}

export function occurrencesBetween(entry, from, to) {
  const out = [];
  for (const o of iterate(entry)) {
    if (o.date > to) break;
    if (o.date >= from) out.push(o);
  }
  return out;
}

export function firstOccurrence(entry, from = entry.date) {
  for (const o of iterate(entry)) if (o.date >= from) return o;
  return null;
}

// Próxima ocorrência não pulada a partir de `from`.
export function nextOccurrence(entry, from) {
  const ov = entry.overrides || {};
  for (const o of iterate(entry)) {
    if (o.date < from) continue;
    if (ov[o.date] && ov[o.date].skip) continue;
    return o;
  }
  return null;
}

// Total de parcelas exibido ("3/10"), ou null quando a série não tem fim por contagem.
export function displayTotal(entry) {
  const end = entry.recurrence && entry.recurrence.end;
  if (entry.displayTotal) return entry.displayTotal;
  if (isRecurring(entry) && end && end.type === 'count') return (parseInt(end.count, 10) || 0) + (entry.ordinalOffset || 0);
  return null;
}

// Expande um lançamento em ocorrências concretas dentro de [from, to], aplicando exceções.
export function expand(entry, from, to) {
  const ov = entry.overrides || {};
  const out = [];
  const total = displayTotal(entry);
  // margem para capturar ocorrências que foram movidas para dentro do intervalo
  for (const { date, n } of occurrencesBetween(entry, addDays(from, -45), addDays(to, 45))) {
    const o = ov[date] || {};
    if (o.skip) continue;
    const eff = o.date || date;
    if (eff < from || eff > to) continue;
    out.push({
      key: `${entry.id}@${date}`,
      entryId: entry.id,
      origDate: date,
      date: eff,
      rawN: n,
      n: n + (entry.ordinalOffset || 0),
      total,
      type: entry.type,
      flow: entry.type === 'investimento' ? (entry.flow || 'aporte') : undefined,
      description: o.description ?? entry.description,
      amount: o.amount ?? entry.amount,
      categoryId: o.categoryId ?? entry.categoryId,
      notes: o.notes ?? entry.notes ?? '',
      paid: !!o.paid,
      recurring: isRecurring(entry),
    });
  }
  return out;
}

// Custo mensal equivalente de uma série (para o resumo de fixos).
export function monthlyEquivalent(entry) {
  const r = entry.recurrence || {};
  const i = Math.max(1, parseInt(r.interval, 10) || 1);
  const a = entry.amount || 0;
  switch (r.freq) {
    case 'daily': return (a * 30.44) / i;
    case 'weekly': return (a * (r.byWeekday && r.byWeekday.length ? r.byWeekday.length : 1) * 52) / 12 / i;
    case 'monthly': return a / i;
    case 'yearly': return a / 12 / i;
    default: return 0;
  }
}
