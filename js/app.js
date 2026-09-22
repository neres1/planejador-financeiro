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
const ui = { tab: 'home', filter: 'all', search: '', showEnded: false };
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

function occurrencesIn(from, to) {
  const list = [];
  for (const e of store.entries()) list.push(...expand(e, from, to));
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.type === b.type ? b.amount - a.amount : a.type === 'receita' ? -1 : 1));
  for (const o of list) occIndex.set(o.key, o);
  return list;
}

const FALLBACK_CAT = { name: 'Sem categoria', emoji: '❔', color: '#8b8d98' };
const catOf = (o) => store.category(o.categoryId) || { ...FALLBACK_CAT, group: o.type === 'despesa' ? 'variavel' : o.type };
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

function summarize(list) {
  const s = { income: 0, incomePaid: 0, expense: 0, expensePaid: 0, fixo: 0, variavel: 0, invest: 0, investPaid: 0, resgate: 0, resgatePaid: 0 };
  for (const o of list) {
    if (o.type === 'receita') { s.income += o.amount; if (o.paid) s.incomePaid += o.amount; }
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

function occRow(o, { showDate = true } = {}) {
  const c = catOf(o);
  const t = todayISO();
  const exp = o.type === 'despesa';
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
        <div class="item-sub">${showDate ? `${fmtShort(o.date)} · ` : ''}${esc(c.name)} ${rec} ${badge}</div>
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
  const list = occurrencesIn(from, to);
  const s = summarize(list);
  const t = todayISO();
  if (!list.length) {
    return emptyState(`Nada em ${fmtMonth(ui.month).toLowerCase()}`, 'Adicione salário, contas fixas e gastos. Contas que se repetem aparecem sozinhas nos próximos meses.');
  }
  const balance = s.balance;
  const toPay = list.filter((o) => o.type === 'despesa' && !o.paid);
  const toReceive = list.filter((o) => o.type === 'receita' && !o.paid);
  const overdue = toPay.filter((o) => o.date < t);
  const upcoming = toPay.slice(0, 6);

  const byCat = new Map();
  for (const o of list) if (o.type === 'despesa') byCat.set(o.categoryId, (byCat.get(o.categoryId) || 0) + o.amount);
  const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const maxCat = cats.length ? cats[0][1] : 1;

  const fixPct = s.expense ? Math.round((s.fixo / s.expense) * 100) : 0;
  const incomeUse = s.income ? Math.round((s.fixo / s.income) * 100) : null;

  return `
  <section class="hero ${balance >= 0 ? 'pos' : 'neg'}">
    <div class="hero-label">Saldo livre previsto do mês</div>
    <div class="hero-value">${balance < 0 ? '−' : ''}${money(Math.abs(balance))}</div>
    <div class="hero-sub">Realizado até agora: ${money(s.balancePaid)}</div>
    <div class="hero-split">
      <button class="hero-cell" data-action="filter-go" data-value="receita">
        <span class="lbl"><i class="dot inc"></i>Receitas</span><b>${money(s.income)}</b><small>${money(s.incomePaid)} recebido</small>
      </button>
      <button class="hero-cell" data-action="filter-go" data-value="despesa">
        <span class="lbl"><i class="dot exp"></i>Despesas</span><b>${money(s.expense)}</b><small>${money(s.expensePaid)} pago</small>
      </button>
      <button class="hero-cell" data-action="filter-go" data-value="investimento">
        <span class="lbl"><i class="dot inv"></i>Investido</span><b>${money(s.invest - s.resgate)}</b><small>${money(s.investPaid)} aplicado</small>
      </button>
    </div>
  </section>

  <div class="grid-2">
    <section class="card">
      <div class="card-head"><h2>Fixas × variáveis</h2></div>
      <div class="stack-bar"><span class="fixo" style="width:${fixPct}%"></span><span class="variavel" style="width:${s.expense ? 100 - fixPct : 0}%"></span></div>
      <div class="legend">
        <button data-action="filter-go" data-value="fixo"><i class="dot fixo"></i>Fixas <b>${money(s.fixo)}</b></button>
        <button data-action="filter-go" data-value="variavel"><i class="dot variavel"></i>Variáveis <b>${money(s.variavel)}</b></button>
      </div>
      ${incomeUse != null ? `<p class="note">As despesas fixas comprometem <b>${incomeUse}%</b> das receitas do mês.</p>` : ''}
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
];

function filterList(list) {
  const q = ui.search.trim().toLowerCase();
  return list.filter((o) => {
    switch (ui.filter) {
      case 'despesa': case 'receita': case 'investimento': if (o.type !== ui.filter) return false; break;
      case 'fixo': case 'variavel': if (o.type !== 'despesa' || groupOf(o) !== ui.filter) return false; break;
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
  const list = filterList(occurrencesIn(from, to));
  if (!list.length) return emptyState('Nenhum lançamento', ui.search || ui.filter !== 'all' ? 'Nada corresponde ao filtro neste mês.' : 'Toque em + para adicionar o primeiro.', !ui.search && ui.filter === 'all');
  const s = summarize(list);
  const days = new Map();
  for (const o of list) { if (!days.has(o.date)) days.set(o.date, []); days.get(o.date).push(o); }
  return `
    <div class="list-summary">
      <span>${list.length} ${list.length === 1 ? 'lançamento' : 'lançamentos'}</span>
      <span><b class="inc">+${money(s.income)}</b> · <b class="exp">−${money(s.expense)}</b>${s.invest || s.resgate ? ` · <b class="inv">↗ ${money(s.invest - s.resgate)}</b>` : ''}</span>
    </div>
    ${[...days.entries()].map(([d, items]) => {
      const net = items.reduce((a, o) => a + cashSign(o) * o.amount, 0);
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
    const exp = items.filter((o) => o.type === 'despesa').reduce((a, o) => a + o.amount, 0);
    const inc = items.some((o) => o.type === 'receita');
    const inv = items.some((o) => o.type === 'investimento');
    const late = items.some((o) => !o.paid && o.date < t && o.type === 'despesa');
    cells += `<button class="cal-cell ${iso === t ? 'today' : ''} ${iso === ui.day ? 'sel' : ''}" data-action="day" data-date="${iso}">
      <span class="num">${d}</span>
      <span class="dots">${inc ? '<i class="dot inc"></i>' : ''}${exp ? `<i class="dot ${late ? 'late' : 'exp'}"></i>` : ''}${inv ? '<i class="dot inv"></i>' : ''}</span>
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
        ${o.total ? `<div><span>Parcela</span><b>${o.n} de ${o.total}</b></div>` : ''}
        ${o.notes ? `<div class="notes"><span>Observações</span><p>${esc(o.notes)}</p></div>` : ''}
      </div>
      <button class="btn big ${o.paid ? '' : 'primary'} full" data-f="paid">${o.paid ? `✓ ${PAID_LABEL[o.type]} — desmarcar` : `Marcar como ${PAID_WORD[o.type]}`}</button>
      <button class="btn ghost danger full" data-f="delete">Excluir</button>
    </div>`, (el, close) => {
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-f]');
      if (!b) return;
      if (b.dataset.f === 'edit') { close(); openEntryForm({ entry, occ: o }); }
      if (b.dataset.f === 'paid') { store.saveEntries(togglePaid(entry, o)); close(); toast(o.paid ? 'Marcado como pendente' : `${PAID_LABEL[o.type]} ✓`); }
      if (b.dataset.f === 'delete') { if (await deleteFlow(entry, o)) close(); }
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

function categoryOptions(type, selected) {
  const cats = store.categories();
  const groups = type === 'despesa' ? ['fixo', 'variavel'] : [type];
  return groups.map((g) => `<optgroup label="${GROUPS[g].label}">${cats.filter((c) => c.group === g)
    .map((c) => `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.emoji)} ${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
}

function openEntryForm({ entry = null, occ = null, date = null, type: startType = 'despesa' } = {}) {
  const t = todayISO();
  const v = occ
    ? { type: entry.type, amount: occ.amount, description: occ.description, categoryId: occ.categoryId, notes: occ.notes, date: occ.date, paid: occ.paid }
    : entry
      ? { type: entry.type, amount: entry.amount, description: entry.description, categoryId: entry.categoryId, notes: entry.notes || '', date: entry.date, paid: false }
      : { type: startType, amount: 0, description: '', categoryId: '', notes: '', date: date || (ui.month === currentYM() ? t : `${ui.month}-01`), paid: false };
  if (!entry) v.paid = v.date <= t;
  const rec = JSON.parse(JSON.stringify((entry && entry.recurrence) || { freq: 'none' }));
  if (!rec.end) rec.end = { type: 'never' };
  if (entry && rec.end.type === 'count') rec.end.count = formCount(entry);
  const startDay = parseISO(entry ? entry.date : v.date).d;
  const mday = rec.byMonthDay != null ? Number(rec.byMonthDay) : startDay;
  const wdays = rec.byWeekday && rec.byWeekday.length ? rec.byWeekday : [weekday(v.date)];
  const seriesMode = entry && isRecurring(entry) && !occ; // editando a série inteira (aba Recorrentes)
  const title = !entry ? 'Novo lançamento' : seriesMode ? 'Editar série' : 'Editar lançamento';

  let type = v.type;
  let flow = (entry && entry.flow) || 'aporte';
  let cents = v.amount;
  let touchedFreq = !!entry, touchedPaid = !!entry, touchedMday = !!entry;

  openSheet(`
    <div class="sheet-head"><button class="link" data-close>Cancelar</button><h2>${title}</h2><button class="link strong" data-f="save">Salvar</button></div>
    <div class="sheet-body">
      <form class="entry-form" data-kind="${type}" data-freq="${rec.freq}" data-end="${rec.end.type}" onsubmit="return false">
        <div class="seg three type-seg">
          ${['despesa', 'receita', 'investimento'].map((k) => `<button type="button" data-type="${k}" class="t-${k} ${type === k ? 'on' : ''}">${TYPE_LABEL[k]}</button>`).join('')}
        </div>
        <div class="seg flow-seg inv-only">
          <button type="button" data-flow="aporte" class="${flow === 'aporte' ? 'on' : ''}">↗ Aporte</button>
          <button type="button" data-flow="resgate" class="${flow === 'resgate' ? 'on' : ''}">↙ Resgate</button>
        </div>
        <label class="amount ${type}"><span>R$</span><input id="f-amount" inputmode="numeric" pattern="[0-9]*" value="${cents ? digitsDisplay(cents) : ''}" placeholder="0,00" autocomplete="off"></label>
        <div class="form-list">
          <label class="field"><span>Descrição</span><input id="f-desc" value="${esc(v.description)}" placeholder="Ex.: Aluguel, Mercado…" autocomplete="off" enterkeyhint="done"></label>
          <label class="field"><span>Categoria</span><select id="f-cat">${categoryOptions(type, v.categoryId)}</select></label>
          <label class="field"><span id="f-date-lbl">${occ && occ.recurring ? 'Data desta ocorrência' : isRecurring({ recurrence: rec }) ? 'Começa em' : 'Data'}</span><input id="f-date" type="date" value="${v.date}" required></label>
          ${seriesMode ? '' : `<label class="field switch-field"><span id="f-paid-lbl">${PAID_LABEL[type]}${occ && occ.recurring ? ' (esta ocorrência)' : ''}</span><input id="f-paid" type="checkbox" class="switch" ${v.paid ? 'checked' : ''}></label>`}
        </div>

        <div class="section-title">Repetição</div>
        <div class="form-list">
          <label class="field"><span>Repetir</span>
            <select id="f-freq">
              <option value="none" ${rec.freq === 'none' ? 'selected' : ''}>Não repete</option>
              <option value="monthly" ${rec.freq === 'monthly' ? 'selected' : ''}>Todo mês</option>
              <option value="weekly" ${rec.freq === 'weekly' ? 'selected' : ''}>Toda semana</option>
              <option value="daily" ${rec.freq === 'daily' ? 'selected' : ''}>Todo dia</option>
              <option value="yearly" ${rec.freq === 'yearly' ? 'selected' : ''}>Todo ano</option>
            </select></label>
          <label class="field rec-only monthly-only"><span>Dia da cobrança</span>
            <select id="f-mday">${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${mday === i + 1 ? 'selected' : ''}>Dia ${i + 1}</option>`).join('')}
              <option value="-1" ${mday === -1 ? 'selected' : ''}>Último dia do mês</option></select></label>
          <div class="field rec-only weekly-only"><span>Dias</span>
            <div class="wdays">${WD_SHORT.map((d, i) => `<button type="button" data-wd="${i}" class="${wdays.includes(i) ? 'on' : ''}">${WD_LETTER[i]}</button>`).join('')}</div></div>
          <label class="field rec-only"><span>Intervalo</span>
            <span class="inline">a cada <input id="f-interval" type="number" inputmode="numeric" min="1" max="99" value="${Math.max(1, parseInt(rec.interval, 10) || 1)}"> <em id="f-unit"></em></span></label>
          <label class="field rec-only"><span>Termina</span>
            <select id="f-end">
              <option value="never" ${rec.end.type === 'never' ? 'selected' : ''}>Nunca</option>
              <option value="count" ${rec.end.type === 'count' ? 'selected' : ''}>Após N vezes (parcelas)</option>
              <option value="until" ${rec.end.type === 'until' ? 'selected' : ''}>Em uma data</option>
            </select></label>
          <label class="field rec-only end-count"><span>Nº de vezes</span><input id="f-count" type="number" inputmode="numeric" min="1" max="600" value="${rec.end.count || 12}"></label>
          <label class="field rec-only end-until"><span>Até</span><input id="f-until" type="date" value="${rec.end.until || addDays(v.date, 365)}"></label>
        </div>
        <p class="preview rec-only" id="f-preview"></p>

        <div class="form-list"><label class="field col"><span>Observações</span><textarea id="f-notes" rows="2" placeholder="Opcional">${esc(v.notes)}</textarea></label></div>
        ${entry ? '<button type="button" class="btn ghost danger full" data-f="delete">Excluir</button>' : ''}
      </form>
    </div>`, (el, close) => {
    const form = $('.entry-form', el);
    const f = (id) => $(`#f-${id}`, el);

    const suggestFromCategory = () => {
      const c = store.category(f('cat').value);
      if (!touchedFreq && !entry && c && c.group === 'fixo' && f('freq').value === 'none') { f('freq').value = 'monthly'; sync_(); }
    };
    const unitFor = (freq, n) => ({ daily: n > 1 ? 'dias' : 'dia', weekly: n > 1 ? 'semanas' : 'semana', monthly: n > 1 ? 'meses' : 'mês', yearly: n > 1 ? 'anos' : 'ano' }[freq] || '');

    function collect() {
      const freq = f('freq').value;
      let recurrence = { freq: 'none' };
      if (freq !== 'none') {
        const endType = f('end').value;
        recurrence = {
          freq,
          interval: Math.max(1, parseInt(f('interval').value, 10) || 1),
          end: endType === 'count' ? { type: 'count', count: Math.max(1, parseInt(f('count').value, 10) || 1) }
            : endType === 'until' ? { type: 'until', until: f('until').value } : { type: 'never' },
        };
        if (freq === 'monthly') recurrence.byMonthDay = Number(f('mday').value);
        if (freq === 'weekly') recurrence.byWeekday = $$('.wdays .on', el).map((b) => +b.dataset.wd);
      }
      const c = store.category(f('cat').value);
      return {
        type,
        flow: type === 'investimento' ? flow : undefined,
        amount: cents,
        description: f('desc').value.trim() || (c ? c.name : 'Sem descrição'),
        categoryId: f('cat').value,
        date: f('date').value,
        paid: f('paid') ? f('paid').checked : false,
        notes: f('notes').value.trim(),
        recurrence,
      };
    }

    function sync_() {
      const freq = f('freq').value;
      form.dataset.freq = freq;
      form.dataset.end = f('end').value;
      f('unit').textContent = unitFor(freq, parseInt(f('interval').value, 10) || 1);
      if (!occ || !occ.recurring) f('date-lbl').textContent = freq === 'none' ? 'Data' : 'Começa em';
      // prévia das próximas datas, como na agenda
      const vals = collect();
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

    // valor estilo caixa eletrônico
    const amt = f('amount');
    amt.addEventListener('input', () => {
      cents = centsFromDigits(amt.value);
      amt.value = cents ? digitsDisplay(cents) : '';
    });
    if (!entry) setTimeout(() => amt.focus(), 320);

    el.addEventListener('click', async (e) => {
      const tb = e.target.closest('.type-seg [data-type]');
      if (tb) {
        type = tb.dataset.type;
        form.dataset.kind = type;
        $$('.type-seg button', el).forEach((b) => b.classList.toggle('on', b === tb));
        $('.amount', el).className = `amount ${type}`;
        f('cat').innerHTML = categoryOptions(type, '');
        if (f('paid-lbl')) f('paid-lbl').textContent = PAID_LABEL[type] + (occ && occ.recurring ? ' (esta ocorrência)' : '');
        suggestFromCategory();
        return;
      }
      const fb = e.target.closest('[data-flow]');
      if (fb) { flow = fb.dataset.flow; $$('.flow-seg button', el).forEach((b) => b.classList.toggle('on', b === fb)); return; }
      const wd = e.target.closest('[data-wd]');
      if (wd) { wd.classList.toggle('on'); sync_(); return; }
      const act = e.target.closest('[data-f]');
      if (!act) return;
      if (act.dataset.f === 'delete') { if (await deleteFlow(entry, occ)) close(); return; }
      if (act.dataset.f === 'save') await save();
    });
    f('freq').addEventListener('change', () => { touchedFreq = true; sync_(); });
    f('cat').addEventListener('change', suggestFromCategory);
    f('mday').addEventListener('change', () => { touchedMday = true; sync_(); });
    if (f('paid')) f('paid').addEventListener('change', () => { touchedPaid = true; });
    f('date').addEventListener('change', () => {
      const d = f('date').value;
      if (!d) return;
      if (!touchedMday) f('mday').value = String(parseISO(d).d);
      if ($$('.wdays .on', el).length <= 1 && !entry) $$('.wdays button', el).forEach((b) => b.classList.toggle('on', +b.dataset.wd === weekday(d)));
      sync_();
    });
    ['interval', 'end', 'count', 'until'].forEach((id) => f(id).addEventListener('input', sync_));
    f('end').addEventListener('change', sync_);
    sync_();

    async function save() {
      const vals = collect();
      if (!vals.amount) { toast('Informe o valor', 'err'); amt.focus(); return; }
      if (!vals.date) { toast('Informe a data', 'err'); return; }
      if (!vals.categoryId) { toast('Escolha uma categoria', 'err'); return; }
      const r = vals.recurrence;
      if (r.freq === 'weekly' && !r.byWeekday.length) { toast('Escolha ao menos um dia da semana', 'err'); return; }
      if (r.freq !== 'none' && r.end.type === 'until' && (!r.end.until || r.end.until < vals.date)) { toast('A data final deve ser depois do início', 'err'); return; }

      let result;
      if (!entry) result = createEntry(uid(), vals);
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
      store.applyEntries(result.save, result.remove);
      close();
      toast(entry ? 'Alterações salvas' : 'Lançamento adicionado');
    }
  });
}

// ---------------------------------------------------------------------------
// Editor de categoria

const COLORS = ['#1cc29f', '#30a46c', '#12a594', '#00a2c7', '#0090ff', '#3b9dff', '#6e56cf', '#7c6cf2', '#8e4ec6', '#d6409f', '#e93d82', '#e5484d', '#f76b15', '#f5a524', '#ffb224', '#ad7f58', '#8b8d98'];

function openCategoryForm(cat = null, group = 'variavel') {
  const c = cat ? { ...cat } : { id: `cat-${uid()}`, name: '', emoji: '🏷️', group, color: COLORS[Math.floor(Math.random() * COLORS.length)] };
  const used = store.entries().filter((e) => e.categoryId === c.id).length;
  openSheet(`
    <div class="sheet-head"><button class="link" data-close>Cancelar</button><h2>${cat ? 'Editar categoria' : 'Nova categoria'}</h2><button class="link strong" data-f="save">Salvar</button></div>
    <div class="sheet-body">
      <div class="cat-preview"><div class="tile big" id="c-tile" style="--c:${esc(c.color)}">${esc(c.emoji)}</div></div>
      <div class="form-list">
        <label class="field"><span>Nome</span><input id="c-name" value="${esc(c.name)}" placeholder="Ex.: Academia" autocomplete="off"></label>
        <label class="field"><span>Emoji</span><input id="c-emoji" value="${esc(c.emoji)}" maxlength="8" autocomplete="off"></label>
      </div>
      <div class="section-title">Grupo</div>
      <div class="seg four" id="c-group">${['fixo', 'variavel', 'receita', 'investimento'].map((g) => `<button type="button" data-g="${g}" class="${c.group === g ? 'on' : ''}">${GROUPS[g].short}</button>`).join('')}</div>
      <p class="note">Fixas: contas que se repetem com valor previsível (aluguel, plano, assinaturas). Variáveis: gastos do dia a dia (mercado, lazer).</p>
      <div class="section-title">Cor</div>
      <div class="swatches">${COLORS.map((col) => `<button type="button" data-col="${col}" class="${col === c.color ? 'on' : ''}" style="--c:${col}" aria-label="${col}"></button>`).join('')}</div>
      ${cat ? `<button class="btn ghost danger full" data-f="delete">Excluir categoria</button>${used ? `<p class="note center">${used} lançamento(s) usam esta categoria.</p>` : ''}` : ''}
    </div>`, (el, close) => {
    const tile = $('#c-tile', el);
    $('#c-emoji', el).addEventListener('input', (e) => { tile.textContent = e.target.value || '🏷️'; });
    el.addEventListener('click', async (e) => {
      const g = e.target.closest('[data-g]');
      if (g) { c.group = g.dataset.g; $$('#c-group button', el).forEach((b) => b.classList.toggle('on', b === g)); return; }
      const col = e.target.closest('[data-col]');
      if (col) { c.color = col.dataset.col; tile.style.setProperty('--c', c.color); $$('.swatches button', el).forEach((b) => b.classList.toggle('on', b === col)); return; }
      const act = e.target.closest('[data-f]');
      if (!act) return;
      if (act.dataset.f === 'save') {
        c.name = $('#c-name', el).value.trim();
        c.emoji = $('#c-emoji', el).value.trim() || '🏷️';
        if (!c.name) { toast('Dê um nome à categoria', 'err'); return; }
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
      const entry = o && store.entry(o.entryId);
      if (entry) {
        if (navigator.vibrate) navigator.vibrate(8);
        store.saveEntries(togglePaid(entry, o));
      }
      break;
    }
    case 'open-occ': openOccurrence(el.dataset.key); break;
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
