// Importação de fatura do cartão (OFX ou CSV), puro, sem DOM.
//
// 1. readStatement(bytes, nome) → transações { date, description, amount (centavos, sinal do arquivo), fitid, parcel }
// 2. splitTransactions(txs) → { purchases (valor positivo), credits (pagamentos e estornos, ignorados) }
// 3. planImport(...) → itens com a data dentro da fatura escolhida, a categoria sugerida e se já foram lançados
// 4. importEntries(itens, cartão) → lançamentos no crédito. Compra parcelada vira uma série com todas
//    as parcelas que faltam (ex.: "3/10" na fatura → parcelas 3 a 10, uma em cada fatura seguinte).
//
// Cada lançamento importado guarda `importKey`, para que importar a mesma fatura (ou, no caso de
// parcelas, a fatura do mês seguinte) não duplique nada.

import { addDays, addMonths, diffDays } from './recurrence.js';
import { invoiceOf, cardOccurrences, installmentRecurrence } from './cards.js';
import { createEntry } from './series.js';

// ---------------------------------------------------------------------------
// Texto, datas e valores

// Bancos brasileiros costumam exportar em Windows-1252; tenta UTF-8 primeiro.
export function decodeBytes(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}

export const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');

function validDate(y, m, d) {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

const MONTH_NAMES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

export function parseDate(str) {
  const s = fold(clean(str));
  let m;
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})/))) return validDate(+m[1], +m[2], +m[3]); // OFX: 20260315120000[-3:BRT]
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return validDate(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/))) return validDate(+m[3], +m[2], +m[1]);
  if ((m = s.match(/^(\d{1,2})\s*(?:de\s+)?([a-z]{3})[a-z]*\.?\s*(?:de\s+)?(\d{4})/))) {
    const mi = MONTH_NAMES.indexOf(m[2]);
    if (mi >= 0) return validDate(+m[3], mi + 1, +m[1]);
  }
  return null;
}

// "1.234,56", "1234.56", "-R$ 12,34", "(12,34)", "12,34 D" → centavos (com sinal). null se não for valor.
export function parseAmount(str) {
  let s = clean(str).toUpperCase();
  if (!/\d/.test(s)) return null;
  let neg = /-/.test(s) || /^\(.*\)$/.test(s) || /\sD$/.test(s);
  s = s.replace(/[^\d.,]/g, '');
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  let num;
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    num = s.replace(dec === '.' ? /,/g : /\./g, '').replace(dec, '.');
  } else if (lastComma >= 0) {
    num = s.split(',').length > 2 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot >= 0) {
    // "1.234" (só um ponto seguido de 3 dígitos) é milhar; "12.5" / "12.50" é decimal.
    const parts = s.split('.');
    num = parts.length > 2 || parts[parts.length - 1].length === 3 ? s.replace(/\./g, '') : s;
  } else num = s;
  const v = Math.round(parseFloat(num) * 100);
  if (!Number.isFinite(v)) return null;
  if (neg && v === 0) neg = false;
  return neg ? -v : v;
}

// Parcela na descrição: "Parcela 3/10", "PARC 03/10", "LOJA 3/10", "LOJA 03 DE 10".
const PARCEL_RES = [
  /\bparc(?:ela)?s?\.?\s*(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\b/i,
  /(?:^|[\s*\-(])(\d{1,2})\s*\/\s*(\d{1,2})(?=$|[\s)])/,
  /(?:^|\s)(\d{1,2})\s+de\s+(\d{1,2})\s*$/i,
];

export function parseParcel(desc) {
  const text = clean(desc);
  for (const re of PARCEL_RES) {
    const m = text.match(re);
    if (!m) continue;
    const k = +m[1], n = +m[2];
    if (n < 2 || n > 48 || k < 1 || k > n) continue;
    const base = clean(text.replace(m[0], ' ').replace(/[\s\-–*]+$/, '').replace(/^[\s\-–*]+/, '').replace(/\(\s*\)/g, ''));
    return { k, n, base: base || text };
  }
  return null;
}

// ---------------------------------------------------------------------------
// OFX

const unescapeXML = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function ofxTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, 'i'));
  return m ? unescapeXML(m[1].trim()) : '';
}

export function parseOFX(text) {
  const blocks = text.split(/<STMTTRN>/i).slice(1).map((b) => b.split(/<\/STMTTRN>|<\/BANKTRANLIST>/i)[0]);
  const txs = [];
  for (const b of blocks) {
    const date = parseDate(ofxTag(b, 'DTPOSTED') || ofxTag(b, 'DTUSER'));
    const amount = parseAmount(ofxTag(b, 'TRNAMT'));
    const memo = ofxTag(b, 'MEMO'), name = ofxTag(b, 'NAME');
    const description = clean(memo || name || 'Compra');
    if (!date || !amount) continue;
    txs.push({ date, description, amount, fitid: ofxTag(b, 'FITID') || null, parcel: parseParcel(description) });
  }
  return txs;
}

// ---------------------------------------------------------------------------
// CSV

function splitCSV(text, sep) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c));
}

function detectSeparator(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  let best = ',', score = 0;
  for (const sep of [';', ',', '\t', '|']) {
    // linhas que têm o separador pesam mais que o total (ignora um título solto no topo)
    const counts = lines.map((l) => l.replace(/"[^"]*"/g, '').split(sep).length - 1);
    const sc = counts.filter((c) => c > 0).length * 1000 + counts.reduce((a, b) => a + b, 0);
    if (sc > score) { best = sep; score = sc; }
  }
  return best;
}

const H_DATE = /^(data|date|dt)\b|data d[ae] (compra|lancamento|transacao)/;
const H_DESC = [/descri/, /title|titulo/, /estabelec|loja|comercio/, /histori/, /lancamento/, /memo|detalhe/, /nome/];
const H_NOT_DESC = /cartao|card|final|categoria|category|tipo|type/;
const H_AMOUNT = /valor|amount|value|montante|quantia|preco/;
const H_FOREIGN = /us\$|usd|dolar|dollar|cotacao|moeda/;
const H_PARCEL = /parcela|installment/;

function findColumns(header) {
  const h = header.map(fold);
  const date = h.findIndex((x) => H_DATE.test(x));
  const amounts = h.map((x, i) => (H_AMOUNT.test(x) ? i : -1)).filter((i) => i >= 0 && i !== date);
  const amount = amounts.find((i) => /r\$|brl|real/.test(h[i])) ?? amounts.find((i) => !H_FOREIGN.test(h[i])) ?? amounts[0] ?? -1;
  const parcel = h.findIndex((x, i) => H_PARCEL.test(x) && i !== amount);
  const free = (x, i) => ![date, amount, parcel].includes(i) && !H_DATE.test(x) && !H_NOT_DESC.test(x);
  let desc = -1;
  for (const re of H_DESC) { desc = h.findIndex((x, i) => re.test(x) && free(x, i)); if (desc >= 0) break; }
  return { date, amount, desc, parcel };
}

// Sem cabeçalho reconhecível: descobre as colunas pelo conteúdo.
function guessColumns(rows) {
  const sample = rows.slice(0, 30);
  const width = Math.max(...sample.map((r) => r.length));
  const share = (i, fn) => sample.filter((r) => r[i] && fn(r[i])).length / sample.length;
  let date = -1, amount = -1, desc = -1, bestLen = 0;
  for (let i = 0; i < width; i++) if (date < 0 && share(i, parseDate) > 0.6) date = i;
  for (let i = 0; i < width; i++) {
    if (i !== date && amount < 0 && share(i, (c) => /^[\s()R$\-+]*[\d.,]+\s*[DC]?\)?$/i.test(c) && /[.,]\d{2}\b/.test(c)) > 0.6) amount = i;
  }
  for (let i = 0; i < width; i++) {
    if (i === date || i === amount) continue;
    const len = sample.reduce((a, r) => a + (r[i] || '').length, 0);
    if (len > bestLen) { bestLen = len; desc = i; }
  }
  return { date, amount, desc, parcel: -1 };
}

export function parseCSV(text) {
  const rows = splitCSV(text.replace(/^﻿/, ''), detectSeparator(text));
  let start = 0, cols = null;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const c = findColumns(rows[i]);
    if (c.date >= 0 && c.amount >= 0) { cols = c; start = i + 1; break; }
  }
  if (!cols) cols = guessColumns(rows);
  if (cols.date < 0 || cols.amount < 0) throw new Error('não encontrei as colunas de data e valor no CSV');
  const txs = [];
  for (const r of rows.slice(start)) {
    const date = parseDate(r[cols.date]);
    const amount = parseAmount(r[cols.amount]);
    if (!date || !amount) continue;
    let description = clean(cols.desc >= 0 ? r[cols.desc] : '') || 'Compra';
    let parcel = parseParcel(description);
    const pm = cols.parcel >= 0 && clean(r[cols.parcel]).match(/^(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})$/i);
    if (!parcel && pm && +pm[2] >= 2 && +pm[1] >= 1 && +pm[1] <= +pm[2]) {
      parcel = { k: +pm[1], n: +pm[2], base: description };
      description = `${description} ${pm[1]}/${pm[2]}`;
    }
    txs.push({ date, description, amount, fitid: null, parcel });
  }
  return txs;
}

// Lê o arquivo (bytes) e decide o formato pelo conteúdo.
export function readStatement(bytes, filename = '') {
  const text = typeof bytes === 'string' ? bytes : decodeBytes(bytes);
  const isOFX = /<OFX>|OFXHEADER|<STMTTRN>/i.test(text) || /\.(ofx|qfx)$/i.test(filename);
  const txs = isOFX ? parseOFX(text) : parseCSV(text);
  if (!txs.length) throw new Error('nenhuma transação encontrada no arquivo');
  return { format: isOFX ? 'OFX' : 'CSV', txs };
}

// ---------------------------------------------------------------------------
// Compras × pagamentos/estornos

// Na fatura a maioria das linhas são compras: o sinal mais comum é o das compras.
// `flip` inverte, caso o banco exporte ao contrário e a fatura tenha mais créditos que compras.
export function splitTransactions(txs, flip = false) {
  const neg = txs.filter((t) => t.amount < 0).length;
  let sign = neg > txs.length - neg ? -1 : 1;
  if (flip) sign = -sign;
  const purchases = [], credits = [];
  txs.forEach((t, i) => {
    const amount = t.amount * sign;
    (amount > 0 ? purchases : credits).push({ ...t, row: i, amount: Math.abs(amount) });
  });
  return { purchases, credits };
}

// ---------------------------------------------------------------------------
// Categoria sugerida

const RULES = [
  ['cat-mercado', /supermerc|mercado(?!\s*(livre|pago))|carrefour|atacad|assai|pao de acucar|extra hiper|hortifruti|sacolao|dia brasil|zaffari|mambo|oba hort/],
  ['cat-restaurantes', /ifood|ifd\*|restaur|lanchonete|burger|mc ?donald|bk |habib|padaria|pizza|bar e |cafeteria|starbucks|outback|subway|rappi|coco bambu|sushi/],
  ['cat-combustivel', /posto|shell|ipiranga|petrobras|br mania|combust|auto posto|gasolin/],
  ['cat-transporte', /uber|\b99 ?(app|pop|taxi|tecnologia)\b|cabify|metro|estacion|sem parar|veloe|conectcar|pedagio|onibus|bilhete unico|taxi/],
  ['cat-farmacia', /drogaria|farmac|droga ?raia|drogasil|pague menos|panvel|pacheco|ultrafarma/],
  ['cat-assinaturas', /netflix|spotify|prime video|amazon prime|disney|hbo|max\.com|youtube|apple\.com|google one|globoplay|deezer|paramount|chatgpt|openai|claude\.ai|anthropic|icloud|microsoft|adobe|crunchyroll/],
  ['cat-viagem', /hotel|airbnb|latam|\bgol\b|azul linhas|booking|decolar|\bcvc\b|hostel|pousada|123 ?milhas|smiles/],
  ['cat-internet', /vivo|claro|\btim\b|oi fibra|net servicos|internet/],
  ['cat-saude', /unimed|amil|bradesco saude|sulamerica|hapvida|laborat|clinica|hospital|odonto|dentist/],
  ['cat-educacao', /escola|faculdade|universidade|udemy|alura|coursera|curso|livraria/],
  ['cat-lazer', /cinema|cinemark|ingresso|sympla|eventim|steam|playstation|xbox|nintendo|teatro|show/],
  ['cat-compras', /amazon|mercado ?livre|mercadolivre|magalu|magazine luiza|shopee|aliexpress|shein|americanas|casas bahia|renner|riachuelo|c&a|zara|kabum|centauro|netshoes|leroy/],
];

const descKey = (s) => fold(s).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Último categoryId usado em despesas com a mesma descrição.
export function categoryHistory(entries) {
  const map = new Map();
  const sorted = [...entries].filter((e) => e.type === 'despesa' && e.categoryId).sort((a, b) => ((a.updatedAt || '') < (b.updatedAt || '') ? -1 : 1));
  for (const e of sorted) {
    const p = parseParcel(e.description);
    map.set(descKey(p ? p.base : e.description), e.categoryId);
  }
  return map;
}

export function guessCategory(description, categories, history) {
  const ok = (id) => categories.some((c) => c.id === id && !c.deleted && (c.group === 'fixo' || c.group === 'variavel'));
  const key = descKey(description);
  const known = history && history.get(key);
  if (known && ok(known)) return known;
  const f = ` ${fold(description)} `;
  for (const [id, re] of RULES) if (re.test(f) && ok(id)) return id;
  if (ok('cat-outros')) return 'cat-outros';
  const any = categories.find((c) => !c.deleted && c.group === 'variavel');
  return any ? any.id : null;
}

// ---------------------------------------------------------------------------
// Plano de importação para uma fatura

const shiftYM = (ym, k) => { const [y, m] = ym.split('-').map(Number); const n = addMonths(y, m, k); return `${n.y}-${pad(n.m)}`; };
const clamp = (d, a, b) => (d < a ? a : d > b ? b : d);

// Período de compras de uma fatura: do dia seguinte ao fechamento anterior até o fechamento.
export function invoiceWindow(card, dueYM) {
  const inv = invoiceOf(card, dueYM);
  return { ...inv, start: addDays(invoiceOf(card, shiftYM(dueYM, -1)).close, 1), end: inv.close };
}

// Fatura do arquivo: a que vence logo depois da compra à vista mais recente (parcelas antigas
// costumam vir com a data da compra original, por isso ficam de fora). Bancos que fecham alguns
// dias depois do configurado não mudam o resultado.
export function detectDueYM(card, purchases) {
  const pool = purchases.filter((p) => !p.parcel || p.parcel.k === 1);
  const dates = (pool.length ? pool : purchases).map((p) => p.date).sort();
  const last = dates[dates.length - 1];
  for (let k = -1; k <= 2; k++) {
    const ym = shiftYM(last.slice(0, 7), k);
    if (invoiceOf(card, ym).close >= addDays(last, -5)) return ym;
  }
  return shiftYM(last.slice(0, 7), 1);
}

export const parcelKey = (cardId, base, amount, n) => `parc:${cardId}:${descKey(base)}|${amount}|${n}`;

// Cada item: { row, description, origDate, date, amount, parcel, key, status, categoryId, include }
// status: 'new' | 'imported' (mesma chave já importada) | 'probable' (lançamento manual parecido)
export function planImport(purchases, card, entries, dueYM, categories) {
  const win = invoiceWindow(card, dueYM);
  const mine = entries.filter((e) => !e.deleted && e.cardId === card.id);
  const keys = new Set(mine.map((e) => e.importKey).filter(Boolean));
  const occs = cardOccurrences(card, mine, addDays(win.start, -10), addDays(win.end, 10));
  const used = new Set();
  const history = categoryHistory(entries);
  const seen = new Map();

  return purchases.map((p) => {
    const parcel = p.parcel;
    let date, key, status = 'new';
    if (parcel) {
      // A série começa nesta fatura; as próximas parcelas caem no mesmo dia dos meses seguintes,
      // por isso a data fica longe das bordas do ciclo.
      const safe = p.date >= addDays(win.start, 3) && p.date <= addDays(win.end, -4);
      date = safe ? p.date : addDays(win.end, -14);
      key = parcelKey(card.id, parcel.base, p.amount, parcel.n);
    } else {
      date = clamp(p.date, win.start, win.end);
      const base = p.fitid ? `ofx:${card.id}:${p.fitid}` : `csv:${card.id}:${p.date}|${p.amount}|${descKey(p.description)}`;
      const n = (seen.get(base) || 0) + 1; // duas compras iguais no mesmo dia
      seen.set(base, n);
      key = p.fitid ? base : `${base}#${n}`;
    }
    if (keys.has(key)) status = 'imported';
    else {
      const match = occs.find((o) => {
        if (used.has(o.key) || o.inv.dueYM !== dueYM) return false;
        if (parcel) return Math.abs(o.amount - p.amount) <= 2 && o.total === parcel.n;
        return o.amount === p.amount && Math.abs(diffDays(o.date, p.date)) <= 3;
      });
      if (match) {
        used.add(match.key);
        status = parcel && match.n === parcel.k ? 'imported' : 'probable';
      }
    }
    const description = parcel ? parcel.base : p.description;
    return {
      row: p.row, description, origDate: p.date, date, amount: p.amount, parcel, key, status,
      categoryId: guessCategory(description, categories, history),
      include: status === 'new',
    };
  });
}

// ---------------------------------------------------------------------------
// Lançamentos

export function importEntries(items, card, makeId) {
  const out = [];
  for (const it of items) {
    if (!it.include) continue;
    const { parcel } = it;
    const notes = [];
    if (parcel) notes.push(`Parcela ${parcel.k}/${parcel.n} importada da fatura`);
    if (it.origDate !== it.date) notes.push(`${parcel ? 'Data no arquivo' : 'Data original'}: ${it.origDate.split('-').reverse().join('/')}`);
    const left = parcel ? parcel.n - parcel.k + 1 : 0;
    const vals = {
      type: 'despesa', payment: 'credito', cardId: card.id,
      description: it.description, amount: it.amount, categoryId: it.categoryId, notes: notes.join(' · '),
      date: it.date, paid: false,
      recurrence: parcel ? installmentRecurrence(it.date, left) : { freq: 'none' },
      installments: parcel ? parcel.n : undefined,
      totalAmount: parcel ? it.amount * parcel.n : undefined,
    };
    const entry = createEntry(makeId(), vals).save[0];
    entry.importKey = it.key;
    if (parcel && parcel.k > 1) entry.ordinalOffset = parcel.k - 1; // exibe "3/10", "4/10"…
    out.push(entry);
  }
  return out;
}
