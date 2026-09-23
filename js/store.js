// Documento de dados + cópia local criptografada (por usuário) + mesclagem entre aparelhos.
//
// doc = { schema, updatedAt, categories: [...], entries: [...], cards: [...], invoices: [...] }
// (cartões de crédito e faturas pagas: { id: 'inv-<cartão>-<AAAA-MM do vencimento>', paid })
// Cada item tem `id` e `updatedAt`; exclusões viram "lápides" { id, deleted: true, updatedAt }
// para que a exclusão também se propague para os outros aparelhos.

import { encryptJSON, decryptJSON } from './crypto.js';

const PREFIX = 'pf:u:';
const LEGACY_KEYS = ['pf:data:v1', 'pf:github', 'pf:sync'];
const EPOCH = '2000-01-01T00:00:00.000Z';

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const nowStamp = () => new Date().toISOString();

const cat = (id, name, emoji, group, color) => ({ id: `cat-${id}`, name, emoji, group, color, updatedAt: EPOCH });

export const GROUPS = {
  fixo: { label: 'Despesas fixas', short: 'Fixo' },
  variavel: { label: 'Despesas variáveis', short: 'Variável' },
  receita: { label: 'Receitas', short: 'Receita' },
  investimento: { label: 'Investimentos', short: 'Investimento' },
};

export function defaultCategories() {
  return [
    cat('moradia', 'Moradia / Aluguel', '🏠', 'fixo', '#7c6cf2'),
    cat('contas', 'Luz, água e gás', '💡', 'fixo', '#f5a524'),
    cat('internet', 'Internet e celular', '📶', 'fixo', '#3b9dff'),
    cat('assinaturas', 'Assinaturas', '📺', 'fixo', '#e5484d'),
    cat('saude', 'Plano de saúde', '🩺', 'fixo', '#12a594'),
    cat('educacao', 'Educação', '🎓', 'fixo', '#8e4ec6'),
    cat('seguros', 'Seguros', '🛡️', 'fixo', '#6e56cf'),
    cat('parcelas', 'Parcelas / Empréstimos', '💳', 'fixo', '#d6409f'),
    cat('mercado', 'Mercado', '🛒', 'variavel', '#30a46c'),
    cat('restaurantes', 'Restaurantes', '🍽️', 'variavel', '#f76b15'),
    cat('transporte', 'Transporte', '🚗', 'variavel', '#0090ff'),
    cat('combustivel', 'Combustível', '⛽', 'variavel', '#ad7f58'),
    cat('compras', 'Compras', '🛍️', 'variavel', '#e93d82'),
    cat('lazer', 'Lazer', '🎉', 'variavel', '#ffb224'),
    cat('farmacia', 'Farmácia', '💊', 'variavel', '#46a758'),
    cat('viagem', 'Viagem', '✈️', 'variavel', '#00a2c7'),
    cat('presentes', 'Presentes', '🎁', 'variavel', '#e54666'),
    cat('outros', 'Outros', '📦', 'variavel', '#8b8d98'),
    cat('salario', 'Salário', '💼', 'receita', '#1cc29f'),
    cat('freela', 'Freelance / Extras', '💻', 'receita', '#29a383'),
    cat('investimentos', 'Rendimentos', '📈', 'receita', '#3e9b4f'),
    cat('outras-receitas', 'Outras receitas', '💰', 'receita', '#5bb98b'),
    cat('inv-cdb', 'CDB', '🏦', 'investimento', '#f97316'),
    cat('inv-cdi', 'Pós-fixado (CDI)', '📊', 'investimento', '#fb923c'),
    cat('inv-caixinha', 'Caixinha / Cofrinho', '🐷', 'investimento', '#f59e0b'),
    cat('inv-acoes', 'Ações', '💹', 'investimento', '#ea580c'),
    cat('inv-fii', 'Fundos imobiliários (FII)', '🏢', 'investimento', '#fdba74'),
    cat('inv-rendafixa', 'Renda fixa / Tesouro', '🧾', 'investimento', '#c2410c'),
  ];
}

export const emptyDoc = () => ({ schema: 1, updatedAt: EPOCH, categories: defaultCategories(), entries: [], cards: [], invoices: [] });

// Tipo de cada item (e a lista onde fica), pelo prefixo do id.
export const LISTS = { category: 'categories', card: 'cards', invoice: 'invoices', entry: 'entries' };
export const kindOf = (id) => (id.startsWith('cat-') ? 'category' : id.startsWith('card-') ? 'card' : id.startsWith('inv-') ? 'invoice' : 'entry');

// Documentos de versões anteriores não têm cartões nem faturas.
function withLists(doc) {
  return { ...doc, cards: doc.cards || [], invoices: doc.invoices || [] };
}

function mergeList(a = [], b = []) {
  const map = new Map();
  for (const x of [...a, ...b]) {
    if (!x || !x.id) continue;
    const cur = map.get(x.id);
    if (!cur || (x.updatedAt || '') > (cur.updatedAt || '')) map.set(x.id, x);
  }
  return [...map.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

// Mescla dois documentos: para cada item vence a versão alterada por último.
export function merge(a, b) {
  return {
    schema: 1,
    updatedAt: (a.updatedAt || '') > (b.updatedAt || '') ? a.updatedAt : b.updatedAt,
    categories: mergeList(a.categories, b.categories),
    entries: mergeList(a.entries, b.entries),
    cards: mergeList(a.cards, b.cards),
    invoices: mergeList(a.invoices, b.invoices),
  };
}

// Representação canônica usada para saber se dois documentos têm o mesmo conteúdo.
export const canon = (doc) => JSON.stringify([mergeList(doc.categories), mergeList(doc.entries), mergeList(doc.cards), mergeList(doc.invoices)]);

export function validateDoc(doc) {
  return doc && typeof doc === 'object' && Array.isArray(doc.entries) && Array.isArray(doc.categories);
}

const listeners = new Set();

export const store = {
  doc: emptyDoc(),
  uid: null,
  key: null,        // CryptoKey da chave de dados do usuário
  dirty: new Set(), // ids alterados aqui e ainda não enviados ao servidor
  cursor: null,     // até onde já baixamos do servidor
  _saving: Promise.resolve(),

  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  // Abre a cópia local (criptografada) do usuário.
  async open(uid, key) {
    this.uid = uid;
    this.key = key;
    this.doc = emptyDoc();
    this.dirty = new Set();
    this.cursor = null;
    try { for (const k of LEGACY_KEYS) localStorage.removeItem(k); } catch { /* nada */ }
    try {
      const blob = localStorage.getItem(PREFIX + uid);
      if (blob) {
        const saved = await decryptJSON(key, blob);
        if (validateDoc(saved.doc)) {
          this.doc = withLists(saved.doc);
          this.dirty = new Set(saved.dirty || []);
          this.cursor = saved.cursor || null;
        }
      }
    } catch { /* cópia local ilegível: recomeça e baixa tudo do servidor */ }
  },

  close({ wipe = false } = {}) {
    if (wipe && this.uid) { try { localStorage.removeItem(PREFIX + this.uid); } catch { /* nada */ } }
    this.uid = null;
    this.key = null;
    this.doc = emptyDoc();
    this.dirty = new Set();
    this.cursor = null;
  },

  persist() {
    if (!this.key || !this.uid) return this._saving;
    const uid = this.uid, key = this.key;
    const snapshot = { doc: this.doc, dirty: [...this.dirty], cursor: this.cursor };
    this._saving = this._saving
      .then(() => encryptJSON(key, snapshot))
      .then((b64) => { if (this.uid === uid) localStorage.setItem(PREFIX + uid, b64); })
      .catch(() => { /* cheio / privado */ });
    return this._saving;
  },

  // Item (lançamento, categoria, cartão ou fatura) pelo id, com o tipo.
  find(id) {
    const kind = kindOf(id);
    const item = this.doc[LISTS[kind]].find((x) => x.id === id);
    return item ? { kind, item } : null;
  },

  // Aplica itens vindos do servidor: vence a versão alterada por último.
  applyRemote(items) {
    let changed = false;
    for (const r of items) {
      const cur = this.find(r.item.id);
      if (cur && (cur.item.updatedAt || '') >= (r.item.updatedAt || '')) continue;
      const list = LISTS[kindOf(r.item.id)];
      const i = this.doc[list].findIndex((x) => x.id === r.item.id);
      if (i >= 0) this.doc[list][i] = r.item; else this.doc[list].push(r.item);
      this.dirty.delete(r.item.id);
      changed = true;
    }
    if (changed) this.emit(false); else this.persist();
    return changed;
  },

  // `local: true` = alteração feita pelo usuário (dispara sincronização).
  emit(local) { this.persist(); for (const fn of listeners) fn({ local }); },

  categories() { return this.doc.categories.filter((c) => !c.deleted); },
  entries() { return this.doc.entries.filter((e) => !e.deleted); },
  category(id) { return this.doc.categories.find((c) => c.id === id && !c.deleted) || null; },
  entry(id) { return this.doc.entries.find((e) => e.id === id && !e.deleted) || null; },
  allCards() { return this.doc.cards.filter((c) => !c.deleted); },
  cards() { return this.allCards().filter((c) => !c.archived); },
  card(id) { return this.doc.cards.find((c) => c.id === id && !c.deleted) || null; },
  invoicePaid(id) { const x = this.doc.invoices.find((i) => i.id === id); return !!(x && !x.deleted && x.paid); },

  _upsert(list, items) {
    const stamp = nowStamp();
    for (const item of items) {
      const next = { ...item, updatedAt: stamp };
      const i = this.doc[list].findIndex((x) => x.id === item.id);
      if (i >= 0) this.doc[list][i] = next; else this.doc[list].push(next);
      this.dirty.add(item.id);
    }
    this.doc.updatedAt = stamp;
    this.emit(true);
  },

  saveEntries(...entries) { this._upsert('entries', entries); },
  applyEntries(save = [], removeIds = []) {
    this._upsert('entries', [...save, ...removeIds.map((id) => ({ id, deleted: true }))]);
  },
  deleteEntry(id) { this._upsert('entries', [{ id, deleted: true }]); },
  saveCategory(c) { this._upsert('categories', [c]); },
  deleteCategory(id) { this._upsert('categories', [{ id, deleted: true }]); },
  saveCard(c) { this._upsert('cards', [c]); },
  deleteCard(id) { this._upsert('cards', [{ id, deleted: true }]); },
  setInvoicePaid(id, paid) { this._upsert('invoices', [{ id, paid: !!paid }]); },

  // Importa um backup JSON: tudo que for mais novo entra e é enviado ao servidor.
  importDoc(doc) {
    const merged = merge(this.doc, withLists(doc));
    for (const x of [...merged.categories, ...merged.entries, ...merged.cards, ...merged.invoices]) {
      const cur = this.find(x.id);
      if (!cur || cur.item !== x) this.dirty.add(x.id);
    }
    this.doc = merged;
    this.emit(true);
  },
};
