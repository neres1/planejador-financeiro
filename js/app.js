import {
  todayISO, toISO, parseISO, daysInMonth, addMonths, addDays, weekday,
  expand, isRecurring, nextOccurrence, firstOccurrence, iterate, monthlyEquivalent, displayTotal,
} from './recurrence.js';
import {
  money, moneyCompact, esc, fmtMonth, fmtDayHeader, fmtShort, fmtFull, fmtDateBR,
  fmtRelativeTime, centsFromDigits, digitsDisplay, WD_SHORT, WD_LETTER, MONTHS,
} from './format.js';
import { store, uid, GROUPS, validateDoc } from './store.js';
import {
  createEntry, updateSingle, applyThis, applyAll, applyFuture, deleteOccurrence,
  togglePaid, isStructuralChange, formCount,
} from './series.js';
import { cloud } from './cloud.js';
import { EMOJI_GROUPS } from './emoji.js';
import {
  PAYMENTS, paymentOf, isCredit, closeDaysOf, DEFAULT_CLOSE_DAYS, invoiceId, invoiceOf, invoiceFor, invoiceForMonth,
  cardOccurrences, invoiceItems, cardUsed, splitInstallments, installmentRecurrence, normalizeInstallments,
} from './cards.js';
import { auth, db } from './supa.js';
import { keystore } from './keystore.js';
import {
  createVault, unlockWithPassword, unlockWithRecovery, rewrapPassword, rewrapRecovery, importDataKey,
} from './crypto.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

// ---------------------------------------------------------------------------
// Ícones (traço herda a cor do texto)

const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;
const ICONS = {
  home: svg('<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/>'),
  list: svg('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 'stroke-width="2.6"'),
  calendar: svg('<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>'),
  repeat: svg('<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>'),
  sliders: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 'stroke-width="3"'),
  left: svg('<path d="m15 18-6-6 6-6"/>'),
  right: svg('<path d="m9 18 6-6-6-6"/>'),
  backspace: svg('<path d="M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1Z"/><path d="m17 9-6 6M11 9l6 6"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  cloud: svg('<path d="M17.5 19H7a5 5 0 1 1 1.3-9.83A6 6 0 0 1 19.4 11.2 4 4 0 0 1 17.5 19Z"/>'),
  cloudCheck: svg('<path d="M17.5 19H7a5 5 0 1 1 1.3-9.83A6 6 0 0 1 19.4 11.2 4 4 0 0 1 17.5 19Z"/><path d="m9.5 13.5 2 2 3.5-3.5"/>'),
  cloudOff: svg('<path d="m2 2 20 20"/><path d="M5.8 9.6A5 5 0 0 0 7 19h10.5M19.9 17.2A4 4 0 0 0 19.4 11.2 6 6 0 0 0 10 7.2"/>'),
  cloudAlert: svg('<path d="M17.5 19H7a5 5 0 1 1 1.3-9.83A6 6 0 0 1 19.4 11.2 4 4 0 0 1 17.5 19Z"/><path d="M12 10.5v3M12 16.5h.01"/>'),
  sync: svg('<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12A9 9 0 0 1 18.5 5.8L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>', 'class="spin"'),
};

// ---------------------------------------------------------------------------
// Estado da interface

const UI_KEY = 'pf:ui';
const currentYM = () => todayISO().slice(0, 7);
const ui = { tab: 'home', filter: 'all', search: '', showEnded: false, showArchived: false };
try { Object.assign(ui, JSON.parse(localStorage.getItem(UI_KEY) || '{}')); } catch { /* nada */ }
ui.month = currentYM();
ui.day = null;
const saveUI = () => { try { localStorage.setItem(UI_KEY, JSON.stringify({ tab: ui.tab, filter: ui.filter })); } catch { /* nada */ } };

const occIndex = new Map();

// ---------------------------------------------------------------------------
// Consultas

function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  return [toISO(y, m, 1), toISO(y, m, daysInMonth(y, m))];
}

// Ocorrências em [from, to]. Compras no crédito ficam fora do caixa: entram pela fatura, que
// aparece no vencimento. Com `ym`, cada compra no crédito conta no mês em que a fatura dela fecha
// (Resumo e Lançamentos); sem `ym`, fica na data da compra (Agenda).
function occurrencesIn(from, to, ym = null) {
  const list = [];
  const cards = store.allCards();
  const cardIds = new Set(cards.map((c) => c.id));
  const entries = store.entries();
  for (const e of entries) {
    if (isCredit(e) && cardIds.has(e.cardId)) continue;
    for (const o of expand(e, from, to)) { o.payment = paymentOf(e); list.push(o); }
  }
  const [fy, fm] = from.split('-').map(Number);
  for (const card of cards) {
    for (const o of cardOccurrences(card, entries, ym ? addDays(from, -62) : from, to)) {
      if (ym && o.inv.ym !== ym) continue;
      o.paid = store.invoicePaid(invoiceId(card.id, o.inv.dueYM));
      list.push(o);
    }
    for (let k = 0; k <= 1; k++) {
      const n = addMonths(fy, fm, k);
      const inv = invoiceOf(card, `${n.y}-${String(n.m).padStart(2, '0')}`);
      if (inv.due < from || inv.due > to) continue;
      const row = invoiceRow(card, inv);
      if (row) list.push(row);
    }
  }
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.type === b.type ? b.amount - a.amount : a.type === 'receita' ? -1 : 1));
  for (const o of list) occIndex.set(o.key, o);
  return list;
}

// Fatura de um cartão como uma conta a pagar no vencimento (null se não tem compras).
function invoiceRow(card, inv) {
  const items = invoiceItems(card, store.entries(), inv.dueYM);
  if (!items.length) return null;
  return {
    key: `inv:${card.id}:${inv.dueYM}`, isInvoice: true, type: 'despesa', payment: 'credito', cardId: card.id, inv,
    date: inv.due, amount: items.reduce((a, o) => a + o.amount, 0), count: items.length,
    description: `Fatura ${card.name}`, notes: '', paid: store.invoicePaid(invoiceId(card.id, inv.dueYM)),
  };
}

const FALLBACK_CAT = { name: 'Sem categoria', emoji: '❔', color: '#8b8d98' };
const FALLBACK_CARD = { name: 'Cartão', emoji: '💳', color: '#8b8d98' };
const cardOf = (o) => store.card(o.cardId) || FALLBACK_CARD;
const catOf = (o) => (o.isInvoice ? { ...cardOf(o), group: 'variavel' } : store.category(o.categoryId) || { ...FALLBACK_CAT, group: o.type === 'despesa' ? 'variavel' : o.type });
function groupOf(o) {
  if (o.type === 'receita' || o.type === 'investimento') return o.type;
  const c = store.category(o.categoryId);
  return c && (c.group === 'fixo' || c.group === 'variavel') ? c.group : 'variavel';
}

// Efeito no caixa do mês: receitas e resgates entram; despesas e aportes saem.
const cashSign = (o) => (o.type === 'receita' || (o.type === 'investimento' && o.flow === 'resgate') ? 1 : -1);
// Cor de cada tipo: verde (receita), vermelho (despesa), laranja (investimento).
const tone = (o) => (o.type === 'receita' ? 'inc' : o.type === 'investimento' ? 'inv' : 'exp');
const amountSign = (o) => (o.type === 'investimento' ? (o.flow === 'resgate' ? '↙ ' : '↗ ') : o.type === 'receita' ? '+' : '−');
const PAID_WORD = { despesa: 'pago', receita: 'recebido', investimento: 'realizado' };
const PAID_LABEL = { despesa: 'Pago', receita: 'Recebido', investimento: 'Realizado' };
const TYPE_LABEL = { despesa: 'Despesa', receita: 'Receita', investimento: 'Investimento' };

// Caixa: despesas à vista + faturas (no vencimento). Fixas/variáveis: gastos do mês, incluindo
// as compras no crédito (no mês de fechamento da fatura).
function summarize(list) {
  const s = { income: 0, incomePaid: 0, expense: 0, expensePaid: 0, fixo: 0, variavel: 0, invest: 0, investPaid: 0, resgate: 0, resgatePaid: 0, credit: 0 };
  for (const o of list) {
    if (o.type === 'receita') { s.income += o.amount; if (o.paid) s.incomePaid += o.amount; }
    else if (o.isInvoice) { s.expense += o.amount; if (o.paid) s.expensePaid += o.amount; }
    else if (o.credit) { s.credit += o.amount; s[groupOf(o)] += o.amount; }
    else if (o.type === 'investimento') {
      if (o.flow === 'resgate') { s.resgate += o.amount; if (o.paid) s.resgatePaid += o.amount; }
      else { s.invest += o.amount; if (o.paid) s.investPaid += o.amount; }
    } else {
      s.expense += o.amount; if (o.paid) s.expensePaid += o.amount;
      s[groupOf(o)] += o.amount;
    }
  }
  s.balance = s.income - s.expense - s.invest + s.resgate;
  s.balancePaid = s.incomePaid - s.expensePaid - s.investPaid + s.resgatePaid;
  return s;
}

function describeRule(entry) {
  const r = entry.recurrence || {};
  if (!isRecurring(entry)) return 'Não repete';
  const i = Math.max(1, parseInt(r.interval, 10) || 1);
  let txt;
  if (r.freq === 'daily') txt = i === 1 ? 'Todo dia' : `A cada ${i} dias`;
  if (r.freq === 'weekly') {
    const days = (r.byWeekday && r.byWeekday.length ? r.byWeekday : [weekday(entry.date)]).slice().sort().map((d) => WD_SHORT[d]).join(', ');
    txt = `${i === 1 ? 'Toda semana' : `A cada ${i} semanas`} · ${days}`;
  }
  if (r.freq === 'monthly') {
    const d = r.byMonthDay == null ? parseISO(entry.date).d : Number(r.byMonthDay);
    txt = `${i === 1 ? 'Todo mês' : `A cada ${i} meses`} · ${d === -1 ? 'último dia' : `dia ${d}`}`;
  }
  if (r.freq === 'yearly') {
    const { d, m } = parseISO(entry.date);
    txt = `${i === 1 ? 'Todo ano' : `A cada ${i} anos`} · ${d} de ${MONTHS[m - 1]}`;
  }
  const end = r.end || {};
  if (end.type === 'count') txt += ` · ${displayTotal(entry)}x`;
  if (end.type === 'until' && end.until) txt += ` · até ${fmtDateBR(end.until)}`;
  return txt;
}

// ---------------------------------------------------------------------------
// Componentes

const MON3 = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1].slice(0, 3);

function payTag(o) {
  if (o.type !== 'despesa' || o.isInvoice) return '';
  if (o.credit) return `<span class="pay">💳 ${esc(cardOf(o).name)}</span>`;
  const p = PAYMENTS[o.payment || 'debito'];
  return `<span class="pay" title="${p.label}">${p.icon}</span>`;
}

function occRow(o, { showDate = true } = {}) {
  const c = catOf(o);
  const t = todayISO();
  const exp = o.type === 'despesa';
  if (o.isInvoice) {
    const badge = o.paid ? '' : o.date < t ? '<span class="badge late">Atrasada</span>' : o.date === t ? '<span class="badge today">Hoje</span>' : '';
    return `
    <div class="item ${o.paid ? 'is-paid' : ''}" data-action="open-invoice" data-card="${esc(o.cardId)}" data-due="${o.inv.dueYM}">
      <button class="check exp ${o.paid ? 'on' : ''}" data-action="toggle-paid" data-key="${esc(o.key)}"
        aria-label="${o.paid ? 'Desmarcar' : 'Marcar fatura como paga'}">${ICONS.check}</button>
      <div class="tile" style="--c:${esc(c.color)}">${esc(c.emoji)}</div>
      <div class="item-main">
        <div class="item-title">${esc(o.description)}</div>
        <div class="item-sub">${showDate ? `${fmtShort(o.date)} · ` : ''}${o.count} ${o.count === 1 ? 'compra' : 'compras'} · gastos de ${MON3(o.inv.ym)} ${badge}</div>
      </div>
      <div class="item-amount exp"><span class="amt">−${money(o.amount)}</span><small>${o.paid ? 'paga' : 'Fatura'}</small></div>
    </div>`;
  }
  if (o.credit) {
    const rec = o.total ? `<span class="pill">${o.n}/${o.total}</span>` : o.recurring ? `<span class="pill icon">${ICONS.repeat}</span>` : '';
    return `
    <div class="item credit ${o.paid ? 'is-paid' : ''}" data-action="open-occ" data-key="${esc(o.key)}">
      <span class="check card-mark" style="--c:${esc(cardOf(o).color)}" aria-hidden="true">💳</span>
      <div class="tile" style="--c:${esc(c.color)}">${esc(c.emoji)}</div>
      <div class="item-main">
        <div class="item-title">${esc(o.description)}</div>
        <div class="item-sub">${showDate ? `${fmtShort(o.date)} · ` : ''}${esc(c.name)} ${payTag(o)} ${rec}</div>
      </div>
      <div class="item-amount exp"><span class="amt">−${money(o.amount)}</span><small>fatura ${MON3(o.inv.ym)}${o.paid ? ' · paga' : ''}</small></div>
    </div>`;
  }
  let badge = '';
  if (!o.paid) {
    if (o.date < t) badge = `<span class="badge late">${exp ? 'Atrasada' : 'Pendente'}</span>`;
    else if (o.date === t) badge = `<span class="badge today">Hoje</span>`;
  }
  const rec = o.total ? `<span class="pill">${o.n}/${o.total}</span>` : o.recurring ? `<span class="pill icon">${ICONS.repeat}</span>` : '';
  const status = o.paid ? PAID_WORD[o.type] : o.type === 'investimento' ? (o.flow === 'resgate' ? 'Resgate' : 'Aporte') : GROUPS[groupOf(o)].short;
  return `
    <div class="item ${o.paid ? 'is-paid' : ''}" data-action="open-occ" data-key="${esc(o.key)}">
      <button class="check ${tone(o)} ${o.paid ? 'on' : ''}" data-action="toggle-paid" data-key="${esc(o.key)}"
        aria-label="${o.paid ? 'Desmarcar' : `Marcar como ${PAID_WORD[o.type]}`}">${ICONS.check}</button>
      <div class="tile" style="--c:${esc(c.color)}">${esc(c.emoji)}</div>
      <div class="item-main">
        <div class="item-title">${esc(o.description)}</div>
        <div class="item-sub">${showDate ? `${fmtShort(o.date)} · ` : ''}${esc(c.name)} ${payTag(o)} ${rec} ${badge}</div>
      </div>
      <div class="item-amount ${tone(o)}"><span class="amt">${amountSign(o)}${money(o.amount)}</span><small>${status}</small></div>
    </div>`;
}

function emptyState(title, text, withButton = true) {
  return `<div class="empty">
    <div class="empty-art">🧾</div>
    <h3>${title}</h3><p>${text}</p>
    ${withButton ? `<button class="btn primary" data-action="add">Adicionar lançamento</button>` : ''}
  </div>`;
}

// ---------------------------------------------------------------------------
// Telas

function renderHome() {
  const [from, to] = monthRange(ui.month);
  const list = occurrencesIn(from, to, ui.month);
  const s = summarize(list);
  const t = todayISO();
  if (!list.length) {
    return cardsCard() + emptyState(`Nada em ${fmtMonth(ui.month).toLowerCase()}`, 'Adicione salário, contas fixas e gastos. Contas que se repetem aparecem sozinhas nos próximos meses.');
  }
  const balance = s.balance;
  const toPay = list.filter((o) => o.type === 'despesa' && !o.paid && !o.credit);
  const toReceive = list.filter((o) => o.type === 'receita' && !o.paid);
  const overdue = toPay.filter((o) => o.date < t);
  const upcoming = toPay.slice(0, 6);

  const byCat = new Map();
  for (const o of list) if (o.type === 'despesa' && !o.isInvoice) byCat.set(o.categoryId, (byCat.get(o.categoryId) || 0) + o.amount);
  const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const maxCat = cats.length ? cats[0][1] : 1;

  const spent = s.fixo + s.variavel;
  const fixPct = spent ? Math.round((s.fixo / spent) * 100) : 0;
  const incomeUse = s.income ? Math.round((s.fixo / s.income) * 100) : null;

  return `
  <section class="hero ${balance >= 0 ? 'pos' : 'neg'}">
    <div class="hero-label">Saldo livre previsto do mês</div>
    <div class="hero-value">${balance < 0 ? '−' : ''}${money(Math.abs(balance))}</div>
    <div class="hero-sub">Realizado até agora: ${money(s.balancePaid)}</div>
    <div class="hero-pills">
      ${[
        ['receita', 'inc', 'Receitas', s.income, `${money(s.incomePaid)} recebido`],
        ['despesa', 'exp', 'Despesas', s.expense, `${money(s.expensePaid)} pago`],
        ['investimento', 'inv', 'Investido', s.invest - s.resgate, `${money(s.investPaid)} aplicado`],
      ].map(([v, cls, name, total, sub]) => `
        <button class="hero-pill" data-action="filter-go" data-value="${v}">
          <span class="hp-name"><i class="dot ${cls}"></i>${name}</span>
          <span class="hp-val"><b>${money(total)}</b><small>${sub}</small></span>
        </button>`).join('')}
    </div>
  </section>

  <div class="grid-2">
    <section class="card">
      <div class="card-head"><h2>Fixas × variáveis</h2></div>
      <div class="stack-bar"><span class="fixo" style="width:${fixPct}%"></span><span class="variavel" style="width:${spent ? 100 - fixPct : 0}%"></span></div>
      <div class="legend">
        <button data-action="filter-go" data-value="fixo"><i class="dot fixo"></i>Fixas <b>${money(s.fixo)}</b></button>
        <button data-action="filter-go" data-value="variavel"><i class="dot variavel"></i>Variáveis <b>${money(s.variavel)}</b></button>
      </div>
      ${incomeUse != null ? `<p class="note">As despesas fixas comprometem <b>${incomeUse}%</b> das receitas do mês.</p>` : ''}
      ${s.credit ? `<p class="note">Inclui <b>${money(s.credit)}</b> em compras no crédito deste mês; no saldo, elas entram pela fatura, no vencimento.</p>` : ''}
    </section>

    <section class="card">
      <div class="card-head"><h2>Por categoria</h2></div>
      ${cats.length ? `<div class="bars">${cats.slice(0, 6).map(([id, v]) => {
        const c = store.category(id) || FALLBACK_CAT;
        return `<div class="bar-row"><span class="bar-name">${esc(c.emoji)} ${esc(c.name)}</span><span class="bar-val">${money(v)}</span>
          <div class="bar"><span style="width:${Math.max(3, (v / maxCat) * 100)}%;background:${esc(c.color)}"></span></div></div>`;
      }).join('')}</div>` : '<p class="note">Nenhuma despesa neste mês.</p>'}
    </section>
  </div>

  ${cardsCard()}

  ${investCard(s)}

  <section class="card flush">
    <div class="card-head pad"><h2>A pagar ${toPay.length ? `<span class="count">${toPay.length}</span>` : ''}</h2>
      <span class="head-val exp">${money(toPay.reduce((a, o) => a + o.amount, 0))}</span></div>
    ${overdue.length ? `<div class="alert">⚠️ ${overdue.length} ${overdue.length === 1 ? 'conta atrasada' : 'contas atrasadas'} · ${money(overdue.reduce((a, o) => a + o.amount, 0))}</div>` : ''}
    ${upcoming.length ? upcoming.map((o) => occRow(o)).join('') : '<p class="note pad">Tudo pago neste mês. 🎉</p>'}
    ${toPay.length > upcoming.length ? `<button class="more" data-action="filter-go" data-value="pendentes">Ver todas as ${toPay.length} pendências</button>` : ''}
  </section>

  ${toReceive.length ? `<section class="card flush">
    <div class="card-head pad"><h2>A receber</h2><span class="head-val inc">${money(toReceive.reduce((a, o) => a + o.amount, 0))}</span></div>
    ${toReceive.slice(0, 4).map((o) => occRow(o)).join('')}
  </section>` : ''}`;
}

// Cartões: limite disponível hoje e a fatura cujos gastos contam no mês exibido.
function cardsCard() {
  const cards = store.cards();
  if (!cards.length) return '';
  const t = todayISO();
  const entries = store.entries();
  return `<section class="card flush">
    <div class="card-head pad"><h2>💳 Cartões de crédito</h2></div>
    ${cards.map((card) => {
      const used = cardUsed(card, entries, (due) => store.invoicePaid(invoiceId(card.id, due)), t);
      const limit = card.limit || 0;
      const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
      const inv = invoiceForMonth(card, ui.month);
      const total = invoiceItems(card, entries, inv.dueYM).reduce((a, o) => a + o.amount, 0);
      const st = invoiceStatus(card, inv);
      return `<div class="card-row" data-action="open-invoice" data-card="${esc(card.id)}" data-due="${inv.dueYM}">
        <div class="card-row-top">
          <div class="tile" style="--c:${esc(card.color)}">${esc(card.emoji)}</div>
          <div class="item-main"><div class="item-title">${esc(card.name)}</div>
            <div class="item-sub">Disponível <b class="${limit - used < 0 ? 'exp' : ''}">${money(limit - used)}</b> de ${money(limit)}</div></div>
          <span class="chev">${ICONS.right}</span>
        </div>
        <div class="bar limit"><span style="width:${pct}%;background:${esc(card.color)}"></span></div>
        <div class="card-row-inv"><span>Fatura de ${MONTHS[Number(inv.ym.slice(5, 7)) - 1]} · vence ${fmtShort(inv.due)}</span>
          <span><b>${money(total)}</b> <span class="inv-status ${st}">${st}</span></span></div>
      </div>`;
    }).join('')}
  </section>`;
}

function invoiceStatus(card, inv) {
  const t = todayISO();
  if (store.invoicePaid(invoiceId(card.id, inv.dueYM))) return 'paga';
  return t > inv.due ? 'atrasada' : t > inv.close ? 'fechada' : 'aberta';
}

// Carteira: total aportado (menos resgates) por categoria até o fim do mês exibido.
function investCard(s) {
  const invEntries = store.entries().filter((e) => e.type === 'investimento');
  if (!invEntries.length) {
    return `<section class="card invest-cta">
      <div class="card-head"><h2>📈 Investimentos</h2></div>
      <p class="note">Registre aportes e resgates em CDB, CDI, caixinhas, ações, FIIs e renda fixa — inclusive aportes mensais recorrentes.</p>
      <button class="btn inv full" data-action="add-invest">Registrar investimento</button>
    </section>`;
  }
  const to = monthRange(ui.month)[1];
  const first = invEntries.reduce((m, e) => (e.date < m ? e.date : m), to);
  const byCat = new Map();
  let total = 0;
  for (const e of invEntries) {
    for (const o of expand(e, first, to)) {
      const v = o.flow === 'resgate' ? -o.amount : o.amount;
      byCat.set(o.categoryId, (byCat.get(o.categoryId) || 0) + v);
      total += v;
    }
  }
  const rows = [...byCat.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const max = rows.length ? rows[0][1] : 1;
  return `<section class="card">
    <div class="card-head"><h2>📈 Investimentos</h2><span class="head-val inv">${money(total)}</span></div>
    <div class="kpis two">
      <div><small>Aportes no mês</small><b class="inv">${money(s.invest)}</b></div>
      <div><small>Resgates no mês</small><b class="inv">${money(s.resgate)}</b></div>
    </div>
    ${rows.length ? `<div class="bars" style="margin-top:14px">${rows.map(([id, v]) => {
      const c = store.category(id) || FALLBACK_CAT;
      return `<div class="bar-row"><span class="bar-name">${esc(c.emoji)} ${esc(c.name)}</span><span class="bar-val">${money(v)}</span>
        <div class="bar"><span style="width:${Math.max(3, (v / max) * 100)}%;background:${esc(c.color)}"></span></div></div>`;
    }).join('')}</div>` : ''}
    <p class="note">Total aportado até ${fmtMonth(ui.month).toLowerCase()} (aportes − resgates, sem rendimentos).</p>
  </section>`;
}

const FILTERS = [
  ['all', 'Todos'], ['despesa', 'Despesas'], ['receita', 'Receitas'], ['investimento', 'Investimentos'],
  ['fixo', 'Fixas'], ['variavel', 'Variáveis'], ['pendentes', 'Pendentes'], ['recorrentes', 'Recorrentes'],
  ...Object.entries(PAYMENTS).map(([k, p]) => [k, `${p.icon} ${p.label}`]),
];

function filterList(list) {
  const q = ui.search.trim().toLowerCase();
  return list.filter((o) => {
    switch (ui.filter) {
      case 'despesa': case 'receita': case 'investimento': if (o.type !== ui.filter) return false; break;
      case 'fixo': case 'variavel': if (o.type !== 'despesa' || o.isInvoice || groupOf(o) !== ui.filter) return false; break;
      case 'credito': if (o.payment !== 'credito') return false; break;
      case 'debito': case 'pix': case 'dinheiro': if (o.type !== 'despesa' || o.payment !== ui.filter) return false; break;
      case 'pendentes': if (o.paid) return false; break;
      case 'recorrentes': if (!o.recurring) return false; break;
    }
    if (q) {
      const c = catOf(o);
      if (!`${o.description} ${c.name} ${o.notes}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function listResults() {
  const [from, to] = monthRange(ui.month);
  const list = filterList(occurrencesIn(from, to, ui.month));
  if (!list.length) return emptyState('Nenhum lançamento', ui.search || ui.filter !== 'all' ? 'Nada corresponde ao filtro neste mês.' : 'Toque em + para adicionar o primeiro.', !ui.search && ui.filter === 'all');
  const s = summarize(list);
  const days = new Map();
  for (const o of list) { if (!days.has(o.date)) days.set(o.date, []); days.get(o.date).push(o); }
  return `
    <div class="list-summary">
      <span>${list.length} ${list.length === 1 ? 'lançamento' : 'lançamentos'}</span>
      <span><b class="inc">+${money(s.income)}</b> · <b class="exp">−${money(s.expense)}</b>${s.credit ? ` · <b class="exp">💳 ${money(s.credit)}</b>` : ''}${s.invest || s.resgate ? ` · <b class="inv">↗ ${money(s.invest - s.resgate)}</b>` : ''}</span>
    </div>
    ${[...days.entries()].map(([d, items]) => {
      const net = items.reduce((a, o) => a + (o.credit ? 0 : cashSign(o) * o.amount), 0);
      return `<div class="day-group">
        <div class="day-head ${d === todayISO() ? 'today' : ''}"><span>${fmtDayHeader(d)}${d === todayISO() ? ' · hoje' : ''}</span><span>${net < 0 ? '−' : '+'}${money(Math.abs(net))}</span></div>
        <div class="card flush">${items.map((o) => occRow(o, { showDate: false })).join('')}</div>
      </div>`;
    }).join('')}`;
}

function renderList() {
  return `
    <div class="search"><span>${ICONS.search}</span><input id="search" type="search" placeholder="Buscar descrição, categoria…" value="${esc(ui.search)}" autocomplete="off" enterkeyhint="search"></div>
    <div class="chips">${FILTERS.map(([v, l]) => `<button class="chip ${ui.filter === v ? 'on' : ''}" data-action="filter" data-value="${v}">${l}</button>`).join('')}</div>
    <div id="list-results">${listResults()}</div>`;
}

function renderCalendar() {
  const [from, to] = monthRange(ui.month);
  const list = occurrencesIn(from, to);
  const t = todayISO();
  if (!ui.day || ui.day.slice(0, 7) !== ui.month) ui.day = t.slice(0, 7) === ui.month ? t : from;
  const byDate = new Map();
  for (const o of list) { if (!byDate.has(o.date)) byDate.set(o.date, []); byDate.get(o.date).push(o); }
  const lead = weekday(from);
  const dim = parseISO(to).d;
  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<div class="cal-cell blank"></div>';
  for (let d = 1; d <= dim; d++) {
    const iso = addDays(from, d - 1);
    const items = byDate.get(iso) || [];
    const exp = items.filter((o) => o.type === 'despesa' && !o.credit).reduce((a, o) => a + o.amount, 0);
    const credit = items.some((o) => o.credit);
    const inc = items.some((o) => o.type === 'receita');
    const inv = items.some((o) => o.type === 'investimento');
    const late = items.some((o) => !o.paid && o.date < t && o.type === 'despesa' && !o.credit);
    cells += `<button class="cal-cell ${iso === t ? 'today' : ''} ${iso === ui.day ? 'sel' : ''}" data-action="day" data-date="${iso}">
      <span class="num">${d}</span>
      <span class="dots">${inc ? '<i class="dot inc"></i>' : ''}${exp || credit ? `<i class="dot ${late ? 'late' : 'exp'}"></i>` : ''}${inv ? '<i class="dot inv"></i>' : ''}</span>
      ${exp ? `<span class="cal-amt">${moneyCompact(exp)}</span>` : ''}
    </button>`;
  }
  const dayItems = byDate.get(ui.day) || [];
  return `
    <section class="card cal">
      <div class="cal-grid head">${WD_LETTER.map((l) => `<div>${l}</div>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-legend"><span><i class="dot inc"></i>receita</span><span><i class="dot exp"></i>despesa</span><span><i class="dot inv"></i>investimento</span><span><i class="dot late"></i>atrasada</span></div>
    </section>
    <div class="day-head"><span>${fmtFull(ui.day)}</span>
      <button class="link" data-action="add-on-day" data-date="${ui.day}">+ Adicionar</button></div>
    ${dayItems.length ? `<div class="card flush">${dayItems.map((o) => occRow(o, { showDate: false })).join('')}</div>`
      : '<p class="note center">Nenhum lançamento neste dia.</p>'}`;
}

function renderRecurring() {
  const t = todayISO();
  const rec = store.entries().filter(isRecurring);
  if (!rec.length) {
    return emptyState('Nenhuma recorrência', 'Cadastre salário, aluguel, assinaturas e parcelas com repetição — como um evento de agenda — e escolha o dia da cobrança.');
  }
  const groupOfEntry = (e) => (e.type === 'receita' || e.type === 'investimento' ? e.type : (store.category(e.categoryId) || {}).group === 'fixo' ? 'fixo' : 'variavel');
  // Uma série dividida ("esta e as próximas") vira várias partes com o mesmo `seriesOf`:
  // mostra só a parte vigente (próxima ocorrência mais cedo) para não contar em dobro.
  const byRoot = new Map();
  for (const e of rec) {
    const root = e.seriesOf || e.id;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push({ e, next: nextOccurrence(e, t), g: groupOfEntry(e) });
  }
  const active = [], ended = [];
  for (const parts of byRoot.values()) {
    const live = parts.filter((x) => x.next).sort((a, b) => (a.next.date < b.next.date ? -1 : 1));
    if (live.length) active.push(live[0]);
    else ended.push(parts.sort((a, b) => (a.e.date < b.e.date ? 1 : -1))[0]);
  }
  const sum = (g) => active.filter((x) => x.g === g).reduce((a, x) => a + monthlyEquivalent(x.e) * (x.e.flow === 'resgate' ? -1 : 1), 0);
  const inc = sum('receita'), fix = sum('fixo'), vari = sum('variavel'), inv = sum('investimento');

  const row = ({ e, next }) => {
    const c = store.category(e.categoryId) || FALLBACK_CAT;
    const total = displayTotal(e);
    return `<div class="item" data-action="open-entry" data-id="${esc(e.id)}">
      <div class="tile" style="--c:${esc(c.color)}">${esc(c.emoji)}</div>
      <div class="item-main">
        <div class="item-title">${esc(e.description)}</div>
        <div class="item-sub">${esc(describeRule(e))}</div>
        <div class="item-sub">${next ? `Próxima: ${fmtShort(next.date)}${total ? ` · parcela ${next.n + (e.ordinalOffset || 0)}/${total}` : ''}` : 'Encerrada'}</div>
      </div>
      <div class="item-amount ${tone(e)}">${amountSign(e)}${money(e.amount)}</div>
    </div>`;
  };
  const section = (g) => {
    const items = active.filter((x) => x.g === g).sort((a, b) => (a.next.date < b.next.date ? -1 : 1));
    if (!items.length) return '';
    return `<div class="section-title">${GROUPS[g].label}</div><div class="card flush">${items.map(row).join('')}</div>`;
  };
  return `
    <section class="card">
      <div class="card-head"><h2>Compromissos mensais</h2></div>
      <div class="kpis">
        <div><small>Receitas</small><b class="inc">${money(inc)}</b></div>
        <div><small>Fixas</small><b class="exp">${money(fix)}</b></div>
        <div><small>Variáveis</small><b class="exp">${money(vari)}</b></div>
        <div><small>Investimentos</small><b class="inv">${money(inv)}</b></div>
      </div>
      <p class="note">Sobra estimada das recorrências: <b>${money(inc - fix - vari - inv)}</b>/mês${inc ? ` · fixas = ${Math.round((fix / inc) * 100)}% da renda` : ''}.</p>
    </section>
    ${section('receita')}${section('fixo')}${section('variavel')}${section('investimento')}
    ${ended.length ? `<button class="more" data-action="toggle-ended">${ui.showEnded ? 'Ocultar' : 'Mostrar'} encerradas (${ended.length})</button>
      ${ui.showEnded ? `<div class="card flush">${ended.map(row).join('')}</div>` : ''}` : ''}`;
}

function renderSettings() {
  const cats = store.categories();
  const catGroup = (g) => `
    <div class="section-title">${GROUPS[g].label}</div>
    <div class="card flush">
      ${cats.filter((c) => c.group === g).map((c) => `<div class="item" data-action="edit-cat" data-id="${esc(c.id)}">
        <div class="tile" style="--c:${esc(c.color)}">${esc(c.emoji)}</div>
        <div class="item-main"><div class="item-title">${esc(c.name)}</div></div><span class="chev">${ICONS.right}</span></div>`).join('')}
      <button class="more" data-action="add-cat" data-group="${g}">+ Nova categoria</button>
    </div>`;
  return `
    <div class="section-title">Conta</div>
    <section class="card">
      <p class="account">👤 <b>${esc(auth.session && auth.session.user ? auth.session.user.email : '')}</b></p>
      <p class="sync-line" id="sync-line">${syncLine()}</p>
      <div class="btn-row">
        <button class="btn" data-action="sync">Sincronizar agora</button>
        <button class="btn" data-action="change-password">Trocar senha</button>
        <button class="btn" data-action="new-recovery">Nova chave de recuperação</button>
      </div>
      <button class="btn ghost danger full" data-action="logout">Sair desta conta</button>
      <p class="note">🔒 Seus lançamentos são criptografados neste aparelho antes de irem ao servidor. Nem o servidor consegue lê-los — por isso guarde bem sua <b>chave de recuperação</b>.</p>
    </section>

    ${cardsSettings()}

    ${catGroup('fixo')}${catGroup('variavel')}${catGroup('receita')}${catGroup('investimento')}

    <div class="section-title">Backup</div>
    <section class="card">
      <div class="btn-row">
        <button class="btn" data-action="export">Exportar JSON</button>
        <label class="btn">Importar JSON<input type="file" id="import-file" accept="application/json,.json" hidden></label>
      </div>
      <p class="note">O arquivo exportado <b>não</b> é criptografado — guarde-o em local seguro.</p>
    </section>

    <div class="section-title">Instalar no iPhone</div>
    <section class="card">
      <ol class="steps">
        <li>Abra este site no <b>Safari</b>.</li>
        <li>Toque em <b>Compartilhar</b> (quadrado com seta) → <b>Adicionar à Tela de Início</b>.</li>
        <li>Abra pelo ícone e entre com seu e-mail e senha (o app instalado tem armazenamento próprio, separado do Safari).</li>
      </ol>
    </section>
    <p class="note center">Planejador Financeiro · dados em ${store.entries().length} lançamentos</p>`;
}

function cardsSettings() {
  const all = store.allCards();
  const active = all.filter((c) => !c.archived), archived = all.filter((c) => c.archived);
  const row = (c) => `<div class="item" data-action="edit-card" data-id="${esc(c.id)}">
    <div class="tile" style="--c:${esc(c.color)}">${esc(c.emoji)}</div>
    <div class="item-main"><div class="item-title">${esc(c.name)}</div>
      <div class="item-sub">Limite ${money(c.limit)} · vence dia ${c.dueDay} · fecha ${closeDaysOf(c)} dias antes</div></div>
    <span class="chev">${ICONS.right}</span></div>`;
  return `
    <div class="section-title">Cartões de crédito</div>
    <div class="card flush">
      ${active.map(row).join('')}
      <button class="more" data-action="add-card">+ Novo cartão</button>
    </div>
    ${archived.length ? `<button class="more" data-action="toggle-archived">${ui.showArchived ? 'Ocultar' : 'Mostrar'} arquivados (${archived.length})</button>
      ${ui.showArchived ? `<div class="card flush">${archived.map(row).join('')}</div>` : ''}` : ''}`;
}

// ---------------------------------------------------------------------------
// Cabeçalho, barra de abas e sincronização

function syncLine() {
  const last = cloud.lastSync ? `Última sincronização: ${fmtRelativeTime(cloud.lastSync)}.` : '';
  switch (cloud.state) {
    case 'syncing': return 'Sincronizando…';
    case 'error': return `⚠️ Erro ao sincronizar: ${esc(cloud.message)}`;
    case 'auth': return `⚠️ ${esc(cloud.message)}`;
    case 'offline': return `Sem internet — as alterações serão enviadas depois. ${last}`;
    case 'ok': return `✓ Dados sincronizados. ${last}`;
    default: return 'Conectando…';
  }
}

function syncIcon() {
  switch (cloud.state) {
    case 'syncing': return { icon: ICONS.sync, cls: 'brand', label: 'Sincronizando' };
    case 'error': case 'auth': return { icon: ICONS.cloudAlert, cls: 'danger', label: 'Erro de sincronização' };
    case 'offline': return { icon: ICONS.cloudOff, cls: 'muted', label: 'Sem internet' };
    case 'ok': return { icon: ICONS.cloudCheck, cls: 'brand', label: 'Sincronizado' };
    default: return { icon: ICONS.cloud, cls: 'muted', label: 'Sincronização' };
  }
}

function renderSyncBadge() {
  const b = $('#sync-btn');
  if (b) {
    const s = syncIcon();
    b.className = `icon-btn ${s.cls}`;
    b.innerHTML = s.icon;
    b.setAttribute('aria-label', s.label);
    b.title = s.label;
  }
  const line = $('#sync-line');
  if (line) line.innerHTML = syncLine();
}

const TITLES = { recurring: 'Recorrentes', settings: 'Ajustes' };

function renderHeader() {
  const monthNav = ['home', 'list', 'calendar'].includes(ui.tab);
  const isCurrent = ui.month === currentYM();
  $('#topbar').innerHTML = `
    <div class="topbar-row">
      <button id="sync-btn" class="icon-btn" data-action="sync"></button>
      ${monthNav ? `
        <div class="month-nav">
          <button class="icon-btn" data-action="month" data-delta="-1" aria-label="Mês anterior">${ICONS.left}</button>
          <button class="month-label" data-action="month-today">${fmtMonth(ui.month)}${isCurrent ? '' : '<small>voltar para hoje</small>'}</button>
          <button class="icon-btn" data-action="month" data-delta="1" aria-label="Próximo mês">${ICONS.right}</button>
        </div>` : `<h1>${TITLES[ui.tab]}</h1>`}
      <button class="icon-btn ${ui.tab === 'settings' ? 'brand' : ''}" data-action="tab" data-tab="settings" aria-label="Ajustes">${ICONS.sliders}</button>
    </div>`;
  renderSyncBadge();
}

function renderTabbar() {
  const tabs = [['home', 'Resumo', ICONS.home], ['list', 'Lançamentos', ICONS.list], null, ['calendar', 'Agenda', ICONS.calendar], ['recurring', 'Recorrentes', ICONS.repeat]];
  $('#tabbar').innerHTML = tabs.map((t) => t
    ? `<button class="tab ${ui.tab === t[0] ? 'on' : ''}" data-action="tab" data-tab="${t[0]}">${t[2]}<span>${t[1]}</span></button>`
    : `<button class="fab" data-action="add" aria-label="Novo lançamento">${ICONS.plus}</button>`).join('');
}

const VIEWS = { home: renderHome, list: renderList, calendar: renderCalendar, recurring: renderRecurring, settings: renderSettings };

function render() {
  occIndex.clear();
  renderHeader();
  renderTabbar();
  const view = $('#view');
  const focused = document.activeElement && document.activeElement.id;
  view.innerHTML = (VIEWS[ui.tab] || renderHome)();
  if (focused === 'search') { const s = $('#search'); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}

// ---------------------------------------------------------------------------
// Folhas modais (bottom sheets) e avisos

function openSheet(html, onMount, onClose) {
  const root = $('#sheet-root');
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  root.appendChild(wrap);
  document.documentElement.classList.add('modal-open');
  requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    wrap.classList.remove('open');
    setTimeout(() => {
      wrap.remove();
      if (!root.children.length) document.documentElement.classList.remove('modal-open');
      if (onClose) onClose();
    }, 260);
  };
  wrap.querySelector('.sheet-backdrop').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  if (onMount) onMount(wrap.querySelector('.sheet'), close);
  return close;
}

function actionSheet(title, options) {
  return new Promise((resolve) => {
    let result = null;
    openSheet(`
      <div class="action-sheet">
        ${title ? `<p class="as-title">${esc(title)}</p>` : ''}
        <div class="as-group">${options.map((o, i) => `<button class="as-btn ${o.style || ''}" data-i="${i}">${esc(o.label)}</button>`).join('')}</div>
        <button class="as-btn cancel" data-close>Cancelar</button>
      </div>`, (el, done) => {
      el.classList.add('as');
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-i]');
        if (b) { result = options[+b.dataset.i].value; done(); }
      });
    }, () => resolve(result));
  });
}

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2400);
}

// ---------------------------------------------------------------------------
// Detalhe de uma ocorrência

function openOccurrence(key) {
  const o = occIndex.get(key);
  if (!o) return;
  if (o.isInvoice) { openInvoice(o.cardId, o.inv.dueYM); return; }
  const entry = store.entry(o.entryId);
  if (!entry) return;
  const c = catOf(o);
  const typeLabel = o.type === 'despesa'
    ? GROUPS[groupOf(o)].label.replace('Despesas ', 'Despesa ').replace('fixas', 'fixa').replace('variáveis', 'variável')
    : o.type === 'investimento' ? `Investimento · ${o.flow === 'resgate' ? 'resgate' : 'aporte'}` : 'Receita';
  openSheet(`
    <div class="sheet-head"><button class="link" data-close>Fechar</button><h2>${TYPE_LABEL[o.type]}</h2><button class="link strong" data-f="edit">Editar</button></div>
    <div class="sheet-body">
      <div class="detail-top">
        <div class="tile big" style="--c:${esc(c.color)}">${esc(c.emoji)}</div>
        <div class="detail-title">${esc(o.description)}</div>
        <div class="detail-amount ${tone(o)}">${money(o.amount)}</div>
        <div class="detail-sub">${fmtFull(o.date)}</div>
      </div>
      <div class="info-list">
        <div><span>Categoria</span><b>${esc(c.emoji)} ${esc(c.name)}</b></div>
        <div><span>Tipo</span><b>${typeLabel}</b></div>
        <div><span>Repetição</span><b>${esc(describeRule(entry))}</b></div>
        ${o.total ? `<div><span>Parcela</span><b>${o.n} de ${o.total}${entry.totalAmount ? ` · total ${money(entry.totalAmount)}` : ''}</b></div>` : ''}
        ${o.type === 'despesa' ? `<div><span>Pagamento</span><b>${PAYMENTS[o.payment || 'debito'].icon} ${PAYMENTS[o.payment || 'debito'].label}${o.credit ? ` · ${esc(cardOf(o).name)}` : ''}</b></div>` : ''}
        ${o.credit ? `<div><span>Fatura</span><b>${MONTHS[Number(o.inv.ym.slice(5, 7)) - 1]} · vence ${fmtShort(o.inv.due)}${o.paid ? ' · paga' : ''}</b></div>` : ''}
        ${o.notes ? `<div class="notes"><span>Observações</span><p>${esc(o.notes)}</p></div>` : ''}
      </div>
      ${o.credit ? '<button class="btn big full" data-f="invoice">Ver fatura</button>'
        : `<button class="btn big ${o.paid ? '' : 'primary'} full" data-f="paid">${o.paid ? `✓ ${PAID_LABEL[o.type]} — desmarcar` : `Marcar como ${PAID_WORD[o.type]}`}</button>`}
      <button class="btn ghost danger full" data-f="delete">Excluir</button>
    </div>`, (el, close) => {
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      if (b.dataset.f === 'edit') { close(); openEntryForm({ entry, occ: o }); }
      if (b.dataset.f === 'invoice') { close(); openInvoice(o.cardId, o.inv.dueYM); }
      if (b.dataset.f === 'paid') { store.saveEntries(togglePaid(entry, o)); close(); toast(o.paid ? 'Marcado como pendente' : `${PAID_LABEL[o.type]} ✓`); }
      if (b.dataset.f === 'delete') { if (await deleteFlow(entry, o)) close(); }
    });
  });
}

// Fatura de um cartão: compras do ciclo, fechamento, vencimento e pagamento (valor total).
function openInvoice(cardId, dueYM) {
  const card = store.card(cardId);
  if (!card) return;
  let cur = dueYM;
  const shift = (ym, k) => { const [y, m] = ym.split('-').map(Number); const n = addMonths(y, m, k); return `${n.y}-${String(n.m).padStart(2, '0')}`; };
  const body = () => {
    const inv = invoiceOf(card, cur);
    const items = invoiceItems(card, store.entries(), cur).sort((a, b) => (a.date < b.date ? -1 : 1));
    const paid = store.invoicePaid(invoiceId(card.id, cur));
    for (const o of items) o.paid = paid;
    const total = items.reduce((a, o) => a + o.amount, 0);
    const st = invoiceStatus(card, inv);
    return `
      <div class="month-nav inv-nav">
        <button class="icon-btn" data-nav="-1" aria-label="Fatura anterior">${ICONS.left}</button>
        <div class="month-label">Fatura de ${MONTHS[Number(inv.ym.slice(5, 7)) - 1]}<small>${inv.ym.slice(0, 4)}</small></div>
        <button class="icon-btn" data-nav="1" aria-label="Próxima fatura">${ICONS.right}</button>
      </div>
      <div class="detail-top">
        <div class="detail-amount exp">${money(total)}</div>
        <div class="detail-sub"><span class="inv-status ${st}">${st}</span></div>
      </div>
      <div class="info-list">
        <div><span>Fecha em</span><b>${fmtDateBR(inv.close)}</b></div>
        <div><span>Vence em</span><b>${fmtDateBR(inv.due)}</b></div>
        <div><span>Compras</span><b>${items.length}</b></div>
      </div>
      ${items.length ? `<button class="btn big ${paid ? '' : 'primary'} full" data-f="pay">${paid ? '✓ Fatura paga — desmarcar' : 'Marcar fatura como paga'}</button>` : ''}
      ${items.length ? `<div class="card flush inv-items">${items.map((o) => occRow(o)).join('')}</div>` : '<p class="note center">Nenhuma compra nesta fatura.</p>'}`;
  };
  openSheet(`
    <div class="sheet-head"><button class="link" data-close>Fechar</button><h2>${esc(card.emoji)} ${esc(card.name)}</h2><span></span></div>
    <div class="sheet-body" id="inv-body">${body()}</div>`, (el, close) => {
    const root = $('#inv-body', el);
    el.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-nav]');
      if (nav) { cur = shift(cur, +nav.dataset.nav); root.innerHTML = body(); return; }
      const pay = e.target.closest('[data-f=pay]');
      if (pay) {
        const was = store.invoicePaid(invoiceId(card.id, cur));
        store.setInvoicePaid(invoiceId(card.id, cur), !was);
        toast(was ? 'Fatura marcada como pendente' : 'Fatura paga ✓');
        root.innerHTML = body();
        return;
      }
      const row = e.target.closest('[data-action=open-occ]');
      if (row) {
        const [entryId] = row.dataset.key.split('@');
        const en = store.entry(entryId);
        if (en) { close(); openEntryForm({ entry: en, occ: invoiceItems(card, store.entries(), cur).find((o) => o.key === row.dataset.key) }); }
      }
    });
  });
}

async function deleteFlow(entry, occ) {
  let scope = 'all';
  if (isRecurring(entry) && occ) {
    scope = await actionSheet('Este lançamento se repete. Excluir…', [
      { label: 'Somente esta ocorrência', value: 'this', style: 'destructive' },
      { label: 'Esta e as próximas', value: 'future', style: 'destructive' },
      { label: 'Todas as ocorrências', value: 'all', style: 'destructive' },
    ]);
  } else {
    scope = await actionSheet(isRecurring(entry) ? 'Excluir toda a série recorrente?' : 'Excluir este lançamento?', [{ label: 'Excluir', value: 'all', style: 'destructive' }]);
  }
  if (!scope) return false;
  const r = occ ? deleteOccurrence(entry, occ, scope) : { save: [], remove: [entry.id] };
  store.applyEntries(r.save, r.remove);
  toast('Excluído');
  return true;
}

// ---------------------------------------------------------------------------
// Formulário de lançamento (com recorrência estilo agenda)

function categoryGrid(type, selected) {
  const cats = store.categories();
  const groups = type === 'despesa' ? ['fixo', 'variavel'] : [type];
  return groups.map((g) => `
    ${groups.length > 1 ? `<div class="flabel">${GROUPS[g].label}</div>` : ''}
    <div class="cat-grid">${cats.filter((c) => c.group === g).map((c) => `
      <button type="button" class="cat-tile ${c.id === selected ? 'on' : ''}" data-cat="${esc(c.id)}" style="--c:${esc(c.color)}">
        <span class="cat-emoji">${esc(c.emoji)}</span><span class="cat-name">${esc(c.name)}</span></button>`).join('')}
    </div>`).join('');
}

const chip = (attr, value, label, on, cls = '') => `<button type="button" class="chip-opt ${cls} ${on ? 'on' : ''}" data-${attr}="${value}">${label}</button>`;

const FREQS = [['none', 'Não repete'], ['monthly', 'Todo mês'], ['weekly', 'Toda semana'], ['daily', 'Todo dia'], ['yearly', 'Todo ano']];
const STEPS = ['Valor', 'Categoria', 'Quando'];

// Formulário em 3 passos (valor → categoria → quando), com teclado numérico,
// grade de categorias e chips. Ao editar, dá para pular direto para qualquer passo.
const LASTPAY_KEY = 'pf:last-pay';

function openEntryForm({ entry = null, occ = null, date = null, type: startType = 'despesa' } = {}) {
  const t = todayISO();
  // compra parcelada: edita sempre a compra inteira (valor total, data da compra)
  if (entry && entry.installments > 1) occ = null;
  const v = occ
    ? { type: entry.type, amount: occ.amount, description: occ.description, categoryId: occ.categoryId, notes: occ.notes, date: occ.date, paid: occ.paid }
    : entry
      ? { type: entry.type, amount: entry.amount, description: entry.description, categoryId: entry.categoryId, notes: entry.notes || '', date: entry.date, paid: false }
      : { type: startType, amount: 0, description: '', categoryId: '', notes: '', date: date || (ui.month === currentYM() ? t : `${ui.month}-01`), paid: false };
  if (!entry) v.paid = v.date <= t;
  if (entry && entry.installments > 1) v.amount = entry.totalAmount || entry.amount * entry.installments;
  const rec = JSON.parse(JSON.stringify((entry && entry.recurrence) || { freq: 'none' }));
  if (!rec.end) rec.end = { type: 'never' };
  if (entry && rec.end.type === 'count') rec.end.count = formCount(entry);
  const seriesMode = entry && isRecurring(entry) && !occ; // editando a série inteira (aba Recorrentes)
  const title = !entry ? 'Novo lançamento' : entry.installments > 1 ? 'Editar compra parcelada' : seriesMode ? 'Editar série' : 'Editar lançamento';

  let lastPay = {};
  try { lastPay = JSON.parse(localStorage.getItem(LASTPAY_KEY) || '{}'); } catch { /* nada */ }
  const lastCard = store.card(lastPay.cardId);
  let pay = entry && entry.type === 'despesa' ? paymentOf(entry) : PAYMENTS[lastPay.pay] ? lastPay.pay : 'debito';
  let cardSel = (entry && entry.cardId) || (lastCard && !lastCard.archived ? lastCard.id : '') || (store.cards()[0] || {}).id || '';
  let inst = (entry && entry.installments) || 1;
  const cardChips = () => {
    const list = store.cards();
    const cur = store.card(cardSel);
    if (cur && cur.archived) list.push(cur);
    return list.map((c) => chip('card', c.id, `${esc(c.emoji)} ${esc(c.name)}`, c.id === cardSel)).join('')
      + `<button type="button" class="chip-opt" data-newcard="1">+ ${list.length ? 'Novo' : 'Cadastrar cartão'}</button>`;
  };

  let type = v.type;
  let flow = (entry && entry.flow) || 'aporte';
  let cents = v.amount;
  let catId = v.categoryId || '';
  let freq = rec.freq;
  let mday = rec.byMonthDay != null ? Number(rec.byMonthDay) : parseISO(entry ? entry.date : v.date).d;
  let interval = Math.max(1, parseInt(rec.interval, 10) || 1);
  let endType = rec.end.type;
  const wdays0 = rec.byWeekday && rec.byWeekday.length ? rec.byWeekday : [weekday(v.date)];
  let step = 1;
  let touchedFreq = !!entry, touchedPaid = !!entry, touchedMday = !!entry;

  const dateLabel = () => (occ && occ.recurring ? 'Data desta ocorrência' : freq === 'none' ? 'Data' : 'Começa em');

  openSheet(`
    <div class="sheet-head"><button class="link" data-close>Cancelar</button><h2>${title}</h2><button class="link strong" data-f="save">Salvar</button></div>
    <div class="wiz-steps">${STEPS.map((s, i) => `<button type="button" class="wiz-step" data-goto="${i + 1}"><span class="bar"></span>${i + 1}. ${s}</button>`).join('')}</div>
    <div class="sheet-body">
      <form class="entry-form wiz" data-kind="${type}" data-freq="${freq}" data-end="${endType}" data-step="1" onsubmit="return false">

        <section class="wiz-page" data-page="1">
          <div class="chip-row type-chips">${['despesa', 'receita', 'investimento'].map((k) => chip('type', k, TYPE_LABEL[k], type === k, `t-${k}`)).join('')}</div>
          <div class="chip-row flow-chips inv-only">${chip('flow', 'aporte', '↗ Aporte', flow === 'aporte')}${chip('flow', 'resgate', '↙ Resgate', flow === 'resgate')}</div>
          <div class="amount-display ${type}" id="f-amount"><span>R$</span><b></b></div>
          <div class="keypad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'del'].map((k) => `<button type="button" data-key="${k}" ${k === 'del' ? 'aria-label="Apagar"' : ''}>${k === 'del' ? ICONS.backspace : k}</button>`).join('')}</div>
        </section>

        <section class="wiz-page" data-page="2">
          <div class="form-list"><label class="field"><span>Descrição</span><input id="f-desc" value="${esc(v.description)}" placeholder="Opcional — ex.: Aluguel" autocomplete="off" enterkeyhint="done"></label></div>
          <div id="f-cats">${categoryGrid(type, catId)}</div>
        </section>

        <section class="wiz-page" data-page="3">
          <div class="flabel" id="f-date-lbl">${dateLabel()}</div>
          <div class="chip-row" id="f-quick">
            ${chip('quick', addDays(t, -1), 'Ontem', false)}${chip('quick', t, 'Hoje', false)}${chip('quick', addDays(t, 1), 'Amanhã', false)}
            <input id="f-date" type="date" class="date-chip" value="${v.date}" required>
          </div>

          <div class="exp-only">
            <div class="flabel">Pagamento</div>
            <div class="chip-row">${Object.entries(PAYMENTS).map(([k, p]) => chip('pay', k, `${p.icon} ${p.label}`, pay === k)).join('')}</div>
            <div class="credit-only">
              <div class="flabel">Cartão</div>
              <div class="chip-row" id="f-cardlist">${cardChips()}</div>
              <div class="flabel">Parcelas</div>
              <div class="chip-row scroll" id="f-inst">${Array.from({ length: 24 }, (_, i) => chip('inst', i + 1, i ? `${i + 1}×` : 'À vista', inst === i + 1, i ? 'num' : '')).join('')}</div>
              <p class="preview" id="f-inv"></p>
            </div>
          </div>

          <div class="repeat-block">
          <div class="flabel">Repetir</div>
          <div class="chip-row">${FREQS.map(([k, l]) => chip('freq', k, l, freq === k)).join('')}</div>

          <div class="rec-only monthly-only">
            <div class="flabel">Dia da cobrança</div>
            <div class="chip-row scroll" id="f-mday">${Array.from({ length: 31 }, (_, i) => chip('mday', i + 1, i + 1, mday === i + 1, 'num')).join('')}${chip('mday', -1, 'Último dia', mday === -1)}</div>
          </div>
          <div class="rec-only weekly-only">
            <div class="flabel">Dias da semana</div>
            <div class="wdays">${WD_SHORT.map((d, i) => `<button type="button" data-wd="${i}" class="${wdays0.includes(i) ? 'on' : ''}" aria-label="${d}">${WD_LETTER[i]}</button>`).join('')}</div>
          </div>
          <div class="rec-only">
            <div class="flabel">Intervalo</div>
            <div class="stepper"><button type="button" data-interval="-1" aria-label="Menos">−</button><span>a cada <b id="f-interval">${interval}</b> <em id="f-unit"></em></span><button type="button" data-interval="1" aria-label="Mais">+</button></div>
            <div class="flabel">Termina</div>
            <div class="chip-row">${chip('end', 'never', 'Nunca', endType === 'never')}${chip('end', 'count', 'Após N vezes', endType === 'count')}${chip('end', 'until', 'Em uma data', endType === 'until')}</div>
            <div class="stepper end-count"><button type="button" data-count="-1" aria-label="Menos">−</button><input id="f-count" type="number" inputmode="numeric" min="1" max="600" value="${rec.end.count || 12}"><span>vezes</span><button type="button" data-count="1" aria-label="Mais">+</button></div>
            <div class="end-until"><input id="f-until" type="date" class="date-chip" value="${rec.end.until || addDays(v.date, 365)}"></div>
            <p class="preview" id="f-preview"></p>
          </div>
          </div>

          <div class="form-list" style="margin-top:14px">
            ${seriesMode ? '' : `<label class="field switch-field paid-field"><span id="f-paid-lbl">${PAID_LABEL[type]}${occ && occ.recurring ? ' (esta ocorrência)' : ''}</span><input id="f-paid" type="checkbox" class="switch" ${v.paid ? 'checked' : ''}></label>`}
            <label class="field col"><span>Observações</span><textarea id="f-notes" rows="2" placeholder="Opcional">${esc(v.notes)}</textarea></label>
          </div>
          ${entry ? '<button type="button" class="btn ghost danger full" data-f="delete">Excluir</button>' : ''}
        </section>
      </form>
    </div>
    <div class="wiz-foot"><button type="button" class="btn" data-f="back">Voltar</button><button type="button" class="btn primary" data-f="next">Próximo</button></div>`, (el, close) => {
    const form = $('.entry-form', el);
    const body = $('.sheet-body', el);
    const f = (id) => $(`#f-${id}`, el);
    const unitFor = (fr, n) => ({ daily: n > 1 ? 'dias' : 'dia', weekly: n > 1 ? 'semanas' : 'semana', monthly: n > 1 ? 'meses' : 'mês', yearly: n > 1 ? 'anos' : 'ano' }[fr] || '');
    const setOn = (attr, value) => $$(`[data-${attr}]`, el).forEach((b) => b.classList.toggle('on', b.dataset[attr] === String(value)));

    const renderAmount = () => { $('b', f('amount')).textContent = digitsDisplay(cents); };

    function goto(n) {
      step = n;
      form.dataset.step = String(n);
      $$('.wiz-step', el).forEach((b) => {
        const i = +b.dataset.goto;
        b.classList.toggle('cur', i === n);
        b.classList.toggle('done', i < n);
      });
      const back = $('[data-f=back]', el), next = $('[data-f=next]', el);
      back.style.visibility = n === 1 ? 'hidden' : 'visible';
      next.textContent = n === 3 ? 'Salvar' : n === 1 ? 'Próximo: categoria' : 'Próximo: data';
      body.scrollTop = 0;
      if (n === 3) { const on = $('#f-mday .on', el); if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' }); }
    }

    function collect() {
      let recurrence = { freq: 'none' };
      if (freq !== 'none') {
        recurrence = {
          freq,
          interval,
          end: endType === 'count' ? { type: 'count', count: Math.max(1, parseInt(f('count').value, 10) || 1) }
            : endType === 'until' ? { type: 'until', until: f('until').value } : { type: 'never' },
        };
        if (freq === 'monthly') recurrence.byMonthDay = mday;
        if (freq === 'weekly') recurrence.byWeekday = $$('.wdays .on', el).map((b) => +b.dataset.wd);
      }
      const c = store.category(catId);
      const exp = type === 'despesa';
      const credit = exp && pay === 'credito';
      const n = credit ? inst : 1;
      const dt = f('date').value;
      if (n > 1 && dt) recurrence = installmentRecurrence(dt, n);
      return {
        type,
        flow: type === 'investimento' ? flow : undefined,
        amount: n > 1 ? splitInstallments(cents, n).base : cents,
        description: f('desc').value.trim() || (c ? c.name : 'Sem descrição'),
        categoryId: catId,
        date: dt,
        paid: credit ? false : f('paid') ? f('paid').checked : false,
        notes: f('notes').value.trim(),
        recurrence,
        payment: exp ? pay : undefined,
        cardId: credit ? cardSel : undefined,
        installments: n > 1 ? n : undefined,
        totalAmount: n > 1 ? cents : undefined,
      };
    }

    // onde a compra no crédito vai cair
    function invPreview(vals) {
      const card = store.card(cardSel);
      if (vals.payment !== 'credito' || !card || !vals.date) { f('inv').innerHTML = ''; return; }
      const inv = invoiceFor(card, vals.date);
      const mon = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1];
      let txt = `Entra na fatura de <b>${mon(inv.ym)}</b>, que fecha em ${fmtShort(inv.close)} e vence em <b>${fmtShort(inv.due)}</b>.`;
      if (vals.installments > 1) {
        const { base, first } = splitInstallments(vals.totalAmount, vals.installments);
        let lastInv = inv;
        for (const o of iterate({ date: vals.date, recurrence: vals.recurrence })) lastInv = invoiceFor(card, o.date);
        txt = `${vals.installments}× de <b>${money(base)}</b>${first !== base ? ` (1ª de ${money(first)})` : ''}, uma em cada fatura, de ${mon(inv.ym)} a ${mon(lastInv.ym)}/${lastInv.ym.slice(0, 4)}. O limite desconta ${money(vals.totalAmount)} na hora. ` + txt.replace('Entra', 'A 1ª entra');
      }
      f('inv').innerHTML = txt;
    }

    function sync_() {
      form.dataset.paymode = type === 'despesa' ? pay : '';
      form.dataset.instmode = type === 'despesa' && pay === 'credito' && inst > 1 ? 'multi' : '1';
      form.dataset.freq = freq;
      form.dataset.end = endType;
      f('interval').textContent = interval;
      f('unit').textContent = unitFor(freq, interval);
      f('date-lbl').textContent = dateLabel();
      setOn('quick', f('date').value);
      const vals = collect();
      invPreview(vals);
      // novo lançamento: "pago" por padrão só se a primeira cobrança já passou
      if (!touchedPaid && !entry && f('paid') && vals.date) {
        const first = freq === 'none' ? vals.date : (firstOccurrence({ date: vals.date, recurrence: vals.recurrence }) || {}).date;
        f('paid').checked = !!first && first <= t;
      }
      if (freq !== 'none' && vals.date) {
        const dates = [];
        let last = null;
        const showLast = !occ && vals.recurrence.end.type !== 'never';
        for (const o of iterate({ date: vals.date, recurrence: vals.recurrence })) {
          if (dates.length < 4) dates.push(fmtShort(o.date));
          last = o;
          if ((!showLast && dates.length >= 4) || o.n > 600) break;
        }
        f('preview').innerHTML = `Próximas: ${dates.join(', ')}${showLast && last ? ` … última em <b>${fmtDateBR(last.date)}</b>` : '…'}`;
      }
    }

    function setType(k) {
      type = k;
      form.dataset.kind = k;
      setOn('type', k);
      f('amount').className = `amount-display ${k}`;
      const c = store.category(catId);
      const fits = c && (k === 'despesa' ? c.group === 'fixo' || c.group === 'variavel' : c.group === k);
      if (!fits) catId = '';
      f('cats').innerHTML = categoryGrid(k, catId);
      if (f('paid-lbl')) f('paid-lbl').textContent = PAID_LABEL[k] + (occ && occ.recurring ? ' (esta ocorrência)' : '');
      sync_();
    }

    function press(k) {
      if (k === 'del') cents = Math.floor(cents / 10);
      else if (String(cents).length < 11) cents = parseInt(`${cents}${k}`, 10);
      renderAmount();
    }

    function validateStep(n) {
      if (n === 1 && !cents) { toast('Digite o valor', 'err'); return false; }
      if (n === 2 && !catId) { toast('Escolha uma categoria', 'err'); return false; }
      if (n === 3 && type === 'despesa' && pay === 'credito' && !store.card(cardSel)) { toast('Escolha o cartão', 'err'); return false; }
      return true;
    }

    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const d = b.dataset;
      if (d.key) { press(d.key); return; }
      if (d.type) { setType(d.type); return; }
      if (d.flow) { flow = d.flow; setOn('flow', flow); return; }
      if (d.pay) { pay = d.pay; setOn('pay', pay); sync_(); return; }
      if (d.card) { cardSel = d.card; setOn('card', cardSel); sync_(); return; }
      if (d.inst) { inst = +d.inst; setOn('inst', inst); sync_(); return; }
      if (d.newcard) {
        openCardForm(null, (c) => { cardSel = c.id; f('cardlist').innerHTML = cardChips(); sync_(); });
        return;
      }
      if (d.goto) { goto(+d.goto); return; }
      if (d.cat) {
        catId = d.cat;
        setOn('cat', catId);
        const c = store.category(catId);
        if (!touchedFreq && !entry && c && c.group === 'fixo' && freq === 'none') { freq = 'monthly'; setOn('freq', freq); sync_(); }
        return;
      }
      if (d.quick) { f('date').value = d.quick; f('date').dispatchEvent(new Event('change')); return; }
      if (d.freq) { freq = d.freq; touchedFreq = true; setOn('freq', freq); sync_(); return; }
      if (d.mday) { mday = +d.mday; touchedMday = true; setOn('mday', mday); sync_(); return; }
      if (d.wd !== undefined) { b.classList.toggle('on'); sync_(); return; }
      if (d.interval) { interval = Math.min(99, Math.max(1, interval + +d.interval)); sync_(); return; }
      if (d.count) { f('count').value = Math.min(600, Math.max(1, (parseInt(f('count').value, 10) || 1) + +d.count)); sync_(); return; }
      if (d.end) { endType = d.end; setOn('end', endType); sync_(); return; }
      if (d.f === 'back') { goto(Math.max(1, step - 1)); return; }
      if (d.f === 'next') { if (step < 3) { if (validateStep(step)) goto(step + 1); } else await save(); return; }
      if (d.f === 'delete') { if (await deleteFlow(entry, occ)) close(); return; }
      if (d.f === 'save') await save();
    });

    // teclado físico (computador) no passo do valor
    el.addEventListener('keydown', (e) => {
      if (step !== 1 || e.target.matches('input, textarea')) return;
      if (/^[0-9]$/.test(e.key)) { press(e.key); e.preventDefault(); }
      else if (e.key === 'Backspace') { press('del'); e.preventDefault(); }
      else if (e.key === 'Enter') { $('[data-f=next]', el).click(); e.preventDefault(); }
    });

    if (f('paid')) f('paid').addEventListener('change', () => { touchedPaid = true; });
    f('date').addEventListener('change', () => {
      const dt = f('date').value;
      if (!dt) return;
      if (!touchedMday) { mday = parseISO(dt).d; setOn('mday', mday); }
      if ($$('.wdays .on', el).length <= 1 && !entry) $$('.wdays button', el).forEach((b) => b.classList.toggle('on', +b.dataset.wd === weekday(dt)));
      sync_();
    });
    ['count', 'until'].forEach((id) => f(id).addEventListener('input', sync_));

    renderAmount();
    sync_();
    goto(1);
    el.tabIndex = -1;
    el.focus({ preventScroll: true });

    async function save() {
      const vals = collect();
      if (!vals.amount) { toast('Digite o valor', 'err'); goto(1); return; }
      if (!vals.categoryId) { toast('Escolha uma categoria', 'err'); goto(2); return; }
      if (!vals.date) { toast('Informe a data', 'err'); goto(3); return; }
      if (vals.payment === 'credito' && !store.card(vals.cardId)) { toast('Escolha o cartão', 'err'); goto(3); return; }
      const r = vals.recurrence;
      if (r.freq === 'weekly' && !r.byWeekday.length) { toast('Escolha ao menos um dia da semana', 'err'); goto(3); return; }
      if (r.freq !== 'none' && r.end.type === 'until' && (!r.end.until || r.end.until < vals.date)) { toast('A data final deve ser depois do início', 'err'); goto(3); return; }

      let result;
      if (!entry) result = createEntry(uid(), vals);
      else if (vals.installments > 1 || entry.installments > 1) result = applyAll(entry, null, vals);
      else if (!isRecurring(entry)) result = updateSingle(entry, vals);
      else if (!occ) result = applyAll(entry, null, vals);
      else {
        const structural = isStructuralChange(entry, vals);
        const scope = await actionSheet(structural ? 'Você alterou a repetição. Aplicar a…' : 'Este lançamento se repete. Salvar para…', [
          ...(structural ? [] : [{ label: 'Somente esta ocorrência', value: 'this' }]),
          { label: 'Esta e as próximas', value: 'future' },
          { label: 'Todas as ocorrências', value: 'all' },
        ]);
        if (!scope) return;
        result = scope === 'this' ? applyThis(entry, occ, vals) : scope === 'future' ? applyFuture(entry, occ, vals, uid()) : applyAll(entry, occ, vals);
      }
      if (vals.installments > 1 || (entry && entry.installments > 1)) result.save = result.save.map(normalizeInstallments);
      store.applyEntries(result.save, result.remove);
      if (vals.payment) { try { localStorage.setItem(LASTPAY_KEY, JSON.stringify({ pay: vals.payment, cardId: vals.cardId || cardSel })); } catch { /* nada */ } }
      close();
      toast(entry ? 'Alterações salvas' : 'Lançamento adicionado');
    }
  });
}

// ---------------------------------------------------------------------------
// Editor de categoria

const COLORS = ['#1cc29f', '#30a46c', '#12a594', '#00a2c7', '#0090ff', '#3b9dff', '#6e56cf', '#7c6cf2', '#8e4ec6', '#d6409f', '#e93d82', '#e5484d', '#f76b15', '#f5a524', '#ffb224', '#ad7f58', '#8b8d98'];

// Seletor de emojis no estilo do teclado do iPhone: grupos em sequência, abas embaixo,
// "usados recentemente" e um campo que aceita qualquer emoji do teclado.
const RECENT_KEY = 'pf:emoji-recent';
const recentEmojis = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } };
function rememberEmoji(em) {
  const list = [em, ...recentEmojis().filter((x) => x !== em)].slice(0, 32);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* nada */ }
}
// Primeiro "caractere visível" (um emoji pode ter vários códigos, ex.: 👨‍👩‍👧 ou 🏳️‍🌈).
function firstGrapheme(str) {
  const text = String(str || '').trim();
  if (!text) return '';
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    for (const { segment } of new Intl.Segmenter('pt', { granularity: 'grapheme' }).segment(text)) return segment;
  }
  return Array.from(text)[0];
}

function emojiPicker(current) {
  const recent = recentEmojis();
  const groups = [...(recent.length ? [{ key: 'recentes', label: 'Usados recentemente', icon: '🕘', emojis: recent }] : []), ...EMOJI_GROUPS];
  return `
    <div class="emoji-picker">
      <label class="ep-custom"><span>Outro emoji:</span><input id="c-emoji" value="${esc(current)}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done" aria-label="Digite ou cole um emoji"></label>
      <div class="ep-grid" id="ep-grid">${groups.map((g) => `
        <div class="ep-sec" data-sec="${g.key}"><div class="ep-title">${esc(g.label)}</div>
          <div class="ep-list">${g.emojis.map((e) => `<button type="button" class="ep-e ${e === current ? 'on' : ''}" data-e="${e}">${e}</button>`).join('')}</div>
        </div>`).join('')}
      </div>
      <div class="ep-tabs">${groups.map((g, i) => `<button type="button" class="${i === 0 ? 'on' : ''}" data-tab-e="${g.key}" aria-label="${esc(g.label)}">${g.icon}</button>`).join('')}</div>
    </div>`;
}

function wireEmojiPicker(el, current, onPick) {
  const grid = $('#ep-grid', el);
  const input = $('#c-emoji', el);
  const pick = (em) => {
    if (!em) return;
    $$('.ep-e.on', grid).forEach((b) => b.classList.remove('on'));
    $$(`.ep-e[data-e="${CSS.escape(em)}"]`, grid).forEach((b) => b.classList.add('on'));
    input.value = em;
    onPick(em);
  };
  grid.addEventListener('click', (e) => { const b = e.target.closest('[data-e]'); if (b) pick(b.dataset.e); });
  input.addEventListener('input', () => { const em = firstGrapheme(input.value); if (em) pick(em); });
  input.addEventListener('focus', () => input.select());
  const tabs = $$('[data-tab-e]', el);
  const setTab = (key) => tabs.forEach((t) => t.classList.toggle('on', t.dataset.tabE === key));
  tabs.forEach((t) => t.addEventListener('click', () => {
    const sec = $(`[data-sec="${t.dataset.tabE}"]`, grid);
    grid.scrollTop = sec.offsetTop;
    setTab(t.dataset.tabE);
  }));
  // aba ativa acompanha a rolagem, como no teclado do iPhone
  grid.addEventListener('scroll', () => {
    const y = grid.scrollTop + 8;
    let key = null;
    for (const sec of $$('.ep-sec', grid)) if (sec.offsetTop <= y) key = sec.dataset.sec;
    if (key) setTab(key);
  }, { passive: true });
}

function openCategoryForm(cat = null, group = 'variavel') {
  const c = cat ? { ...cat } : { id: `cat-${uid()}`, name: '', emoji: '🏷️', group, color: COLORS[Math.floor(Math.random() * COLORS.length)] };
  const used = store.entries().filter((e) => e.categoryId === c.id).length;
  openSheet(`
    <div class="sheet-head"><button class="link" data-close>Cancelar</button><h2>${cat ? 'Editar categoria' : 'Nova categoria'}</h2><button class="link strong" data-f="save">Salvar</button></div>
    <div class="sheet-body">
      <div class="cat-preview"><div class="tile big" id="c-tile" style="--c:${esc(c.color)}">${esc(c.emoji)}</div></div>
      <div class="form-list">
        <label class="field"><span>Nome</span><input id="c-name" value="${esc(c.name)}" placeholder="Ex.: Academia" autocomplete="off"></label>
      </div>
      <div class="section-title">Emoji</div>
      ${emojiPicker(c.emoji)}
      <div class="section-title">Grupo</div>
      <div class="seg four" id="c-group">${['fixo', 'variavel', 'receita', 'investimento'].map((g) => `<button type="button" data-g="${g}" class="${c.group === g ? 'on' : ''}">${GROUPS[g].short}</button>`).join('')}</div>
      <p class="note">Fixas: contas que se repetem com valor previsível (aluguel, plano, assinaturas). Variáveis: gastos do dia a dia (mercado, lazer). Investimentos: aportes e resgates.</p>
      <div class="section-title">Cor</div>
      <div class="swatches">${COLORS.map((col) => `<button type="button" data-col="${col}" class="${col === c.color ? 'on' : ''}" style="--c:${col}" aria-label="${col}"></button>`).join('')}</div>
      ${cat ? `<button class="btn ghost danger full" data-f="delete">Excluir categoria</button>${used ? `<p class="note center">${used} lançamento(s) usam esta categoria.</p>` : ''}` : ''}
    </div>`, (el, close) => {
    const tile = $('#c-tile', el);
    wireEmojiPicker(el, c.emoji, (em) => { c.emoji = em; tile.textContent = em; });
    el.addEventListener('click', async (e) => {
      const g = e.target.closest('[data-g]');
      if (g) { c.group = g.dataset.g; $$('#c-group button', el).forEach((b) => b.classList.toggle('on', b === g)); return; }
      const col = e.target.closest('[data-col]');
      if (col) { c.color = col.dataset.col; tile.style.setProperty('--c', c.color); $$('.swatches button', el).forEach((b) => b.classList.toggle('on', b === col)); return; }
      const act = e.target.closest('[data-f]');
      if (!act) return;
      if (act.dataset.f === 'save') {
        c.name = $('#c-name', el).value.trim();
        c.emoji = c.emoji || '🏷️';
        if (!c.name) { toast('Dê um nome à categoria', 'err'); return; }
        rememberEmoji(c.emoji);
        store.saveCategory(c);
        close();
        toast('Categoria salva');
      }
      if (act.dataset.f === 'delete') {
        const ok = await actionSheet(used ? `Excluir? ${used} lançamento(s) ficarão "Sem categoria".` : 'Excluir esta categoria?', [{ label: 'Excluir categoria', value: true, style: 'destructive' }]);
        if (ok) { store.deleteCategory(c.id); close(); toast('Categoria excluída'); }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Cadastro de cartão de crédito

const CARD_EMOJIS = ['💳', '🟣', '🟠', '🔵', '🟢', '🔴', '🟡', '⚫', '⚪', '🏦', '💎', '⭐'];

function openCardForm(card = null, onSaved = null) {
  const c = card ? { ...card } : { id: `card-${uid()}`, name: '', emoji: '💳', color: COLORS[Math.floor(Math.random() * COLORS.length)], limit: 0, dueDay: 10, closeDays: DEFAULT_CLOSE_DAYS };
  c.closeDays = closeDaysOf(c);
  const used = store.entries().filter((e) => e.cardId === c.id).length;
  openSheet(`
    <div class="sheet-head"><button class="link" data-close>Cancelar</button><h2>${card ? 'Editar cartão' : 'Novo cartão'}</h2><button class="link strong" data-f="save">Salvar</button></div>
    <div class="sheet-body">
      <div class="cat-preview"><div class="tile big" id="k-tile" style="--c:${esc(c.color)}">${esc(c.emoji)}</div></div>
      <div class="form-list">
        <label class="field"><span>Nome</span><input id="k-name" value="${esc(c.name)}" placeholder="Ex.: Nubank" autocomplete="off"></label>
        <label class="field"><span>Limite total</span><input id="k-limit" inputmode="numeric" value="${digitsDisplay(c.limit || 0)}" autocomplete="off" class="money-input"></label>
      </div>
      <p class="note">O limite disponível é calculado: limite total menos as compras no crédito cujas faturas ainda não foram pagas.</p>

      <div class="flabel">Dia do vencimento da fatura</div>
      <div class="chip-row scroll" id="k-due">${Array.from({ length: 31 }, (_, i) => chip('due', i + 1, i + 1, c.dueDay === i + 1, 'num')).join('')}</div>

      <div class="flabel">Fechamento</div>
      <div class="stepper"><button type="button" data-close-days="-1" aria-label="Menos">−</button><span><b id="k-close">${c.closeDays}</b> dias antes do vencimento</span><button type="button" data-close-days="1" aria-label="Mais">+</button></div>
      <p class="note" id="k-rule"></p>

      <div class="section-title">Ícone</div>
      <div class="chip-row">${CARD_EMOJIS.map((em) => chip('em', em, em, c.emoji === em, 'num')).join('')}</div>
      <div class="section-title">Cor</div>
      <div class="swatches">${COLORS.map((col) => `<button type="button" data-col="${col}" class="${col === c.color ? 'on' : ''}" style="--c:${col}" aria-label="${col}"></button>`).join('')}</div>

      ${card ? (card.archived
        ? '<button class="btn full" data-f="unarchive">Reativar cartão</button>'
        : `<button class="btn ghost danger full" data-f="${used ? 'archive' : 'delete'}">${used ? 'Arquivar cartão' : 'Excluir cartão'}</button>`)
        + (used ? `<p class="note center">${used} lançamento(s) usam este cartão. Arquivado, ele some das opções do formulário, mas o histórico e as faturas continuam.</p>` : '') : ''}
    </div>`, (el, close) => {
    const tile = $('#k-tile', el);
    const limitInput = $('#k-limit', el);
    const explain = () => {
      const t = todayISO();
      const [y, m] = t.split('-').map(Number);
      const n = addMonths(y, m, 1);
      const inv = invoiceOf(c, `${n.y}-${String(n.m).padStart(2, '0')}`);
      $('#k-close', el).textContent = c.closeDays;
      $('#k-rule', el).innerHTML = `Ex.: a fatura que vence em <b>${fmtShort(inv.due)}</b> fecha em <b>${fmtShort(inv.close)}</b>. Compras até ${fmtShort(inv.close)} contam como gastos de ${MONTHS[Number(inv.ym.slice(5, 7)) - 1]}; a partir de ${fmtShort(addDays(inv.close, 1))}, entram na fatura seguinte.`;
    };
    explain();
    limitInput.addEventListener('input', () => { c.limit = centsFromDigits(limitInput.value); limitInput.value = digitsDisplay(c.limit); });
    limitInput.addEventListener('focus', () => limitInput.select());
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const d = b.dataset;
      if (d.due) { c.dueDay = +d.due; $$('[data-due]', el).forEach((x) => x.classList.toggle('on', x === b)); explain(); return; }
      if (d.closeDays) { c.closeDays = Math.min(28, Math.max(1, c.closeDays + +d.closeDays)); explain(); return; }
      if (d.em) { c.emoji = d.em; tile.textContent = d.em; $$('[data-em]', el).forEach((x) => x.classList.toggle('on', x === b)); return; }
      if (d.col) { c.color = d.col; tile.style.setProperty('--c', c.color); $$('.swatches button', el).forEach((x) => x.classList.toggle('on', x === b)); return; }
      if (d.f === 'save') {
        c.name = $('#k-name', el).value.trim();
        if (!c.name) { toast('Dê um nome ao cartão', 'err'); return; }
        if (!c.limit) { toast('Informe o limite', 'err'); return; }
        store.saveCard(c);
        close();
        toast('Cartão salvo');
        if (onSaved) onSaved(c);
      }
      if (d.f === 'archive' || d.f === 'unarchive') {
        store.saveCard({ ...card, archived: d.f === 'archive' });
        close();
        toast(d.f === 'archive' ? 'Cartão arquivado' : 'Cartão reativado');
      }
      if (d.f === 'delete') {
        const ok = await actionSheet('Excluir este cartão?', [{ label: 'Excluir cartão', value: true, style: 'destructive' }]);
        if (ok) { store.deleteCard(c.id); close(); toast('Cartão excluído'); }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Ações globais

function exportJSON() {
  const blob = new Blob([JSON.stringify(store.doc, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `financas-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.closest('.sheet')) return;
  const a = el.dataset.action;
  switch (a) {
    case 'tab':
      ui.tab = el.dataset.tab; saveUI(); render(); window.scrollTo(0, 0); break;
    case 'month': {
      const [y, m] = ui.month.split('-').map(Number);
      const n = addMonths(y, m, +el.dataset.delta);
      ui.month = `${n.y}-${String(n.m).padStart(2, '0')}`;
      ui.day = null; render(); break;
    }
    case 'month-today': ui.month = currentYM(); ui.day = null; render(); break;
    case 'add': openEntryForm(ui.tab === 'calendar' && ui.day ? { date: ui.day } : {}); break;
    case 'add-on-day': openEntryForm({ date: el.dataset.date }); break;
    case 'add-invest': openEntryForm({ type: 'investimento' }); break;
    case 'toggle-paid': {
      e.stopPropagation();
      const o = occIndex.get(el.dataset.key);
      if (o && o.isInvoice) {
        if (navigator.vibrate) navigator.vibrate(8);
        store.setInvoicePaid(invoiceId(o.cardId, o.inv.dueYM), !o.paid);
        break;
      }
      const entry = o && store.entry(o.entryId);
      if (entry) {
        if (navigator.vibrate) navigator.vibrate(8);
        store.saveEntries(togglePaid(entry, o));
      }
      break;
    }
    case 'open-occ': openOccurrence(el.dataset.key); break;
    case 'open-invoice': openInvoice(el.dataset.card, el.dataset.due); break;
    case 'add-card': openCardForm(); break;
    case 'edit-card': openCardForm(store.card(el.dataset.id)); break;
    case 'toggle-archived': ui.showArchived = !ui.showArchived; render(); break;
    case 'open-entry': { const en = store.entry(el.dataset.id); if (en) openEntryForm({ entry: en }); break; }
    case 'filter': ui.filter = el.dataset.value; saveUI(); render(); break;
    case 'filter-go': ui.filter = el.dataset.value; ui.tab = 'list'; saveUI(); render(); window.scrollTo(0, 0); break;
    case 'day': ui.day = el.dataset.date; render(); break;
    case 'toggle-ended': ui.showEnded = !ui.showEnded; render(); break;
    case 'sync':
      await cloud.run();
      if (cloud.state === 'error' || cloud.state === 'auth') toast(cloud.message, 'err');
      else if (ui.tab !== 'settings' && cloud.state === 'ok') toast('Sincronizado ✓');
      break;
    case 'edit-cat': openCategoryForm(store.category(el.dataset.id)); break;
    case 'add-cat': openCategoryForm(null, el.dataset.group); break;
    case 'change-password': openChangePassword(); break;
    case 'new-recovery': openNewRecovery(); break;
    case 'logout': {
      const ok = await actionSheet(cloud.state === 'ok' || !store.dirty.size ? 'Sair desta conta neste aparelho?' : 'Há alterações ainda não enviadas (sem internet). Se sair agora, elas serão perdidas. Sair mesmo assim?', [{ label: 'Sair', value: true, style: 'destructive' }]);
      if (ok) logout();
      break;
    }
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'search') {
    ui.search = e.target.value;
    $('#list-results').innerHTML = listResults();
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id !== 'import-file') return;
  const file = e.target.files[0];
  if (!file) return;
  try {
    const doc = JSON.parse(await file.text());
    if (!validateDoc(doc)) throw new Error('Arquivo inválido');
    store.importDoc(doc);
    toast(`Importado: ${doc.entries.filter((x) => !x.deleted).length} lançamentos`);
  } catch (err) {
    toast(`Não foi possível importar: ${err.message}`, 'err');
  }
  e.target.value = '';
});

// ---------------------------------------------------------------------------
// Conta: login, convite, recuperação e chave de recuperação

const MIN_PASSWORD = 10;
const siteURL = () => location.origin + location.pathname;

function lock() {
  document.body.classList.add('locked');
  $('#topbar').innerHTML = '';
  $('#tabbar').innerHTML = '';
}

function authShell(inner) {
  lock();
  $('#view').innerHTML = `<div class="auth-wrap"><div class="auth-brand"><img src="icons/icon.svg" alt=""><h1>Planejador Financeiro</h1></div>${inner}</div>`;
  window.scrollTo(0, 0);
}

function busy(form, on, label) {
  const b = $('button[type=submit]', form);
  if (!b) return;
  if (on) { b.dataset.label = b.textContent; b.textContent = label || 'Aguarde…'; b.disabled = true; }
  else { b.textContent = b.dataset.label || b.textContent; b.disabled = false; }
}

function formError(form, msg) {
  const el = $('.auth-error', form);
  el.textContent = msg || '';
  el.hidden = !msg;
}

function checkNewPassword(pw, pw2) {
  if (pw.length < MIN_PASSWORD) return `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`;
  if (pw !== pw2) return 'As senhas não coincidem.';
  return '';
}

const pwFields = (autocomplete = 'new-password') => `
  <label class="field"><span>Nova senha</span><input name="pw" type="password" autocomplete="${autocomplete}" minlength="${MIN_PASSWORD}" required placeholder="mín. ${MIN_PASSWORD} caracteres"></label>
  <label class="field"><span>Repetir senha</span><input name="pw2" type="password" autocomplete="${autocomplete}" required></label>`;

async function enterApp(key) {
  const uid = auth.session.user.id;
  await keystore.set(uid, key).catch(() => {});
  await store.open(uid, key);
  document.body.classList.remove('locked');
  render();
  cloud.run();
}

async function logout() {
  const uid = auth.session && auth.session.user && auth.session.user.id;
  store.close({ wipe: true });
  if (uid) await keystore.remove(uid);
  await auth.signOut();
  cloud._set('idle');
  showLogin();
}

// Cria o cofre (primeiro acesso): gera chave de dados e chave de recuperação.
async function setupVault(password) {
  const { vault, raw, recoveryKey } = await createVault(password);
  await db.createVault(vault);
  const key = await importDataKey(raw);
  showRecoveryKey(recoveryKey, () => enterApp(key), { first: true });
}

function showLogin({ email = '', error = '', info = '' } = {}) {
  authShell(`
    <form class="auth-card" id="login-form" autocomplete="on">
      <h2>Entrar</h2>
      <div class="form-list">
        <label class="field"><span>E-mail</span><input name="email" type="email" autocomplete="username" inputmode="email" autocapitalize="off" value="${esc(email)}" required></label>
        <label class="field"><span>Senha</span><input name="pw" type="password" autocomplete="current-password" required></label>
      </div>
      <p class="auth-error" ${error ? '' : 'hidden'}>${esc(error)}</p>
      ${info ? `<p class="auth-info">${esc(info)}</p>` : ''}
      <button type="submit" class="btn primary big full">Entrar</button>
      <button type="button" class="link auth-link" data-f="forgot">Esqueci minha senha</button>
      <p class="note center">Acesso somente por convite.</p>
    </form>`);
  const form = $('#login-form');
  $('[data-f=forgot]', form).addEventListener('click', () => showForgot(form.email.value.trim()));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError(form, '');
    const email = form.email.value.trim(), pw = form.pw.value;
    busy(form, true, 'Entrando…');
    try {
      await auth.signIn(email, pw);
      const vault = await db.getVault();
      if (!vault) { await setupVault(pw); return; }
      let raw;
      try { raw = await unlockWithPassword(vault, pw); }
      catch { showNeedRecovery(pw); return; }
      await enterApp(await importDataKey(raw));
    } catch (err) {
      busy(form, false);
      formError(form, navigator.onLine ? err.message : 'Sem internet. Conecte-se para entrar.');
    }
  });
}

function showForgot(email = '') {
  authShell(`
    <form class="auth-card" id="forgot-form">
      <h2>Redefinir senha</h2>
      <p class="note">Enviaremos um link para o seu e-mail. Depois de criar a nova senha, você vai precisar da sua <b>chave de recuperação</b> para destravar os dados.</p>
      <div class="form-list">
        <label class="field"><span>E-mail</span><input name="email" type="email" autocomplete="username" autocapitalize="off" value="${esc(email)}" required></label>
      </div>
      <p class="auth-error" hidden></p>
      <button type="submit" class="btn primary big full">Enviar link</button>
      <button type="button" class="link auth-link" data-f="back">Voltar</button>
    </form>`);
  const form = $('#forgot-form');
  $('[data-f=back]', form).addEventListener('click', () => showLogin({ email: form.email.value.trim() }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    busy(form, true, 'Enviando…');
    try {
      await auth.requestReset(form.email.value.trim(), siteURL());
      showLogin({ email: form.email.value.trim(), info: 'Se o e-mail estiver cadastrado, você receberá um link em instantes (confira o spam). O e-mail vem em inglês: "Reset Your Password".' });
    } catch (err) { busy(form, false); formError(form, err.message); }
  });
}

// Convite aceito: a pessoa define a senha e ganha a chave de recuperação.
function showSetPassword() {
  authShell(`
    <form class="auth-card" id="setpw-form">
      <h2>Bem-vindo(a)!</h2>
      <p class="note">Crie a senha da sua conta <b>${esc(auth.session.user.email)}</b>.</p>
      <div class="form-list">${pwFields()}</div>
      <p class="auth-error" hidden></p>
      <button type="submit" class="btn primary big full">Criar senha</button>
    </form>`);
  const form = $('#setpw-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = form.pw.value;
    const bad = checkNewPassword(pw, form.pw2.value);
    if (bad) { formError(form, bad); return; }
    busy(form, true, 'Preparando…');
    try {
      await auth.setPassword(pw);
      const vault = await db.getVault();
      if (!vault) await setupVault(pw);
      else {
        // já tinha cofre (convite reenviado): trata como redefinição
        busy(form, false);
        showRecovery();
      }
    } catch (err) { busy(form, false); formError(form, err.message); }
  });
}

// Link de "esqueci a senha": nova senha + chave de recuperação.
function showRecovery() {
  authShell(`
    <form class="auth-card" id="recover-form">
      <h2>Nova senha</h2>
      <p class="note">Conta <b>${esc(auth.session.user.email)}</b>. Para destravar seus dados, informe também a <b>chave de recuperação</b> que você guardou.</p>
      <div class="form-list">
        ${pwFields()}
        <label class="field col"><span>Chave de recuperação</span><input name="rk" class="mono" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" required></label>
      </div>
      <p class="auth-error" hidden></p>
      <button type="submit" class="btn primary big full">Redefinir e entrar</button>
      <button type="button" class="link auth-link danger" data-f="lost">Perdi a chave de recuperação</button>
    </form>`);
  const form = $('#recover-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = form.pw.value;
    const bad = checkNewPassword(pw, form.pw2.value);
    if (bad) { formError(form, bad); return; }
    busy(form, true, 'Verificando…');
    try {
      const vault = await db.getVault();
      if (!vault) { await auth.setPassword(pw); await setupVault(pw); return; }
      let raw;
      try { raw = await unlockWithRecovery(vault, form.rk.value); }
      catch { busy(form, false); formError(form, 'Chave de recuperação incorreta.'); return; }
      await auth.setPassword(pw);
      await db.updateVault(await rewrapPassword(raw, pw));
      toast('Senha redefinida ✓');
      await enterApp(await importDataKey(raw));
    } catch (err) { busy(form, false); formError(form, err.message); }
  });
  $('[data-f=lost]', form).addEventListener('click', async () => {
    const pw = form.pw.value;
    const bad = checkNewPassword(pw, form.pw2.value);
    if (bad) { formError(form, `Preencha a nova senha primeiro. ${bad}`); return; }
    const ok = await actionSheet('Sem a chave de recuperação não é possível ler os dados antigos. Apagar todos os dados da conta e começar do zero?', [{ label: 'Apagar tudo e recomeçar', value: true, style: 'destructive' }]);
    if (!ok) return;
    busy(form, true, 'Recomeçando…');
    try {
      await auth.setPassword(pw);
      await db.deleteAllItems();
      const { vault, raw, recoveryKey } = await createVault(pw);
      await db.updateVault(vault);
      store.close({ wipe: false });
      try { localStorage.removeItem(`pf:u:${auth.session.user.id}`); } catch { /* nada */ }
      const key = await importDataKey(raw);
      showRecoveryKey(recoveryKey, () => enterApp(key), { first: true });
    } catch (err) { busy(form, false); formError(form, err.message); }
  });
}

// Senha aceita pelo login, mas o cofre está embrulhado com outra (redefinição incompleta).
function showNeedRecovery(pw) {
  authShell(`
    <form class="auth-card" id="needrk-form">
      <h2>Destravar dados</h2>
      <p class="note">Sua senha foi alterada, mas os dados ainda estão protegidos pela anterior. Informe a <b>chave de recuperação</b> para destravá-los com a senha nova.</p>
      <div class="form-list">
        <label class="field col"><span>Chave de recuperação</span><input name="rk" class="mono" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" required></label>
      </div>
      <p class="auth-error" hidden></p>
      <button type="submit" class="btn primary big full">Destravar</button>
      <button type="button" class="link auth-link" data-f="out">Sair</button>
    </form>`);
  const form = $('#needrk-form');
  $('[data-f=out]', form).addEventListener('click', () => logout());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    busy(form, true, 'Verificando…');
    try {
      const vault = await db.getVault();
      let raw;
      try { raw = await unlockWithRecovery(vault, form.rk.value); }
      catch { busy(form, false); formError(form, 'Chave de recuperação incorreta.'); return; }
      await db.updateVault(await rewrapPassword(raw, pw));
      await enterApp(await importDataKey(raw));
    } catch (err) { busy(form, false); formError(form, err.message); }
  });
}

function recoveryKeyHTML(rk, first) {
  return `
    <h2>${first ? 'Sua chave de recuperação' : 'Nova chave de recuperação'}</h2>
    <p class="note">Ela é a <b>única forma</b> de recuperar seus dados se você esquecer a senha. Guarde no seu gerenciador de senhas (ou anote em papel). <b>Ela não será mostrada de novo.</b></p>
    <div class="rk-box mono" id="rk-text">${esc(rk)}</div>
    <button type="button" class="btn full" data-f="copy">Copiar chave</button>
    <label class="rk-confirm"><input type="checkbox" id="rk-ok"> Guardei minha chave em um local seguro</label>`;
}

function wireRecoveryKey(root, rk, onDone) {
  $('[data-f=copy]', root).addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(rk); toast('Chave copiada'); }
    catch { toast('Selecione e copie o texto da chave', 'err'); }
  });
  const btn = $('[data-f=done]', root);
  $('#rk-ok', root).addEventListener('change', (e) => { btn.disabled = !e.target.checked; });
  btn.addEventListener('click', onDone);
}

function showRecoveryKey(rk, onDone, { first = false } = {}) {
  authShell(`<div class="auth-card">${recoveryKeyHTML(rk, first)}<button type="button" class="btn primary big full" data-f="done" disabled>Continuar</button></div>`);
  wireRecoveryKey($('.auth-card'), rk, onDone);
}

// Ajustes → trocar senha (pede a atual para reembrulhar a chave dos dados).
function openChangePassword() {
  openSheet(`
    <div class="sheet-head"><button class="link" data-close>Cancelar</button><h2>Trocar senha</h2><span></span></div>
    <form class="sheet-body" id="chpw-form">
      <div class="form-list">
        <label class="field"><span>Senha atual</span><input name="cur" type="password" autocomplete="current-password" required></label>
        ${pwFields()}
      </div>
      <p class="auth-error" hidden></p>
      <button type="submit" class="btn primary big full">Salvar nova senha</button>
    </form>`, (el, close) => {
    const form = $('#chpw-form', el);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = form.pw.value;
      const bad = checkNewPassword(pw, form.pw2.value);
      if (bad) { formError(form, bad); return; }
      busy(form, true, 'Salvando…');
      try {
        const vault = await db.getVault();
        let raw;
        try { raw = await unlockWithPassword(vault, form.cur.value); }
        catch { busy(form, false); formError(form, 'Senha atual incorreta.'); return; }
        await auth.setPassword(pw);
        await db.updateVault(await rewrapPassword(raw, pw));
        close();
        toast('Senha alterada ✓');
      } catch (err) { busy(form, false); formError(form, err.message); }
    });
  });
}

// Ajustes → gerar nova chave de recuperação (a anterior deixa de valer).
function openNewRecovery() {
  openSheet(`
    <div class="sheet-head"><button class="link" data-close>Fechar</button><h2>Chave de recuperação</h2><span></span></div>
    <form class="sheet-body" id="newrk-form">
      <p class="note">Gera uma nova chave e invalida a anterior. Use se perdeu a chave antiga ou acha que alguém a viu.</p>
      <div class="form-list"><label class="field"><span>Senha atual</span><input name="cur" type="password" autocomplete="current-password" required></label></div>
      <p class="auth-error" hidden></p>
      <button type="submit" class="btn primary big full">Gerar nova chave</button>
    </form>`, (el, close) => {
    const form = $('#newrk-form', el);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      busy(form, true, 'Gerando…');
      try {
        const vault = await db.getVault();
        let raw;
        try { raw = await unlockWithPassword(vault, form.cur.value); }
        catch { busy(form, false); formError(form, 'Senha incorreta.'); return; }
        const { recoveryKey, patch } = await rewrapRecovery(raw);
        await db.updateVault(patch);
        form.innerHTML = `${recoveryKeyHTML(recoveryKey, false)}<button type="button" class="btn primary big full" data-f="done" disabled>Concluir</button>`;
        wireRecoveryKey(form, recoveryKey, close);
      } catch (err) { busy(form, false); formError(form, err.message); }
    });
  });
}

async function boot() {
  lock();
  $('#view').innerHTML = '<div class="auth-wrap"><p class="note center">Carregando…</p></div>';
  let redirect = null;
  try { redirect = await auth.consumeRedirect(); }
  catch (err) { redirect = { error: err.message }; }
  if (redirect && redirect.error) { showLogin({ error: redirect.error }); return; }
  if (!auth.session || !auth.session.user) { showLogin(); return; }
  if (redirect && redirect.type === 'invite') { showSetPassword(); return; }
  if (redirect && redirect.type === 'recovery') { showRecovery(); return; }
  const key = await keystore.get(auth.session.user.id);
  if (!key) { const email = auth.session.user.email; await auth.signOut(); showLogin({ email }); return; }
  await enterApp(key);
}

// ---------------------------------------------------------------------------
// Inicialização

store.onChange(({ local }) => {
  if (!document.body.classList.contains('locked')) render();
  if (local) cloud.markDirty();
});
cloud.onStatus(renderSyncBadge);

window.addEventListener('online', () => cloud.run());
window.addEventListener('offline', () => cloud._set('offline', 'Sem internet'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') cloud.schedule(300);
});
setInterval(() => { if (document.visibilityState === 'visible') cloud.run(); }, 60000);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

boot();
