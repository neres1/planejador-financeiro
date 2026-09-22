// Documento de dados + persistência local + mesclagem (para sincronizar entre aparelhos).
//
// doc = { schema, updatedAt, categories: [...], entries: [...] }
// Cada item tem `id` e `updatedAt`; exclusões viram "lápides" { id, deleted: true, updatedAt }
// para que a exclusão também se propague para os outros aparelhos.

const KEY = 'pf:data:v1';
const EPOCH = '2000-01-01T00:00:00.000Z';

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const nowStamp = () => new Date().toISOString();

const cat = (id, name, emoji, group, color) => ({ id: `cat-${id}`, name, emoji, group, color, updatedAt: EPOCH });

export const GROUPS = {
  fixo: { label: 'Despesas fixas', short: 'Fixo' },
  variavel: { label: 'Despesas variáveis', short: 'Variável' },
  receita: { label: 'Receitas', short: 'Receita' },
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
  ];
}

export const emptyDoc = () => ({ schema: 1, updatedAt: EPOCH, categories: defaultCategories(), entries: [] });

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
  };
}

// Representação canônica usada para saber se dois documentos têm o mesmo conteúdo.
export const canon = (doc) => JSON.stringify([mergeList(doc.categories), mergeList(doc.entries)]);

export function validateDoc(doc) {
  return doc && typeof doc === 'object' && Array.isArray(doc.entries) && Array.isArray(doc.categories);
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const doc = JSON.parse(raw);
      if (validateDoc(doc)) return doc;
    }
  } catch { /* armazenamento indisponível */ }
  return emptyDoc();
}

const listeners = new Set();

export const store = {
  doc: load(),

  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  persist() {
    try { localStorage.setItem(KEY, JSON.stringify(this.doc)); } catch { /* cheio / privado */ }
  },

  // `local: true` = alteração feita pelo usuário (dispara sincronização).
  emit(local) { this.persist(); for (const fn of listeners) fn({ local }); },

  replace(doc, { local = false } = {}) {
    this.doc = { ...doc, categories: mergeList(doc.categories), entries: mergeList(doc.entries) };
    this.emit(local);
  },

  categories() { return this.doc.categories.filter((c) => !c.deleted); },
  entries() { return this.doc.entries.filter((e) => !e.deleted); },
  category(id) { return this.doc.categories.find((c) => c.id === id && !c.deleted) || null; },
  entry(id) { return this.doc.entries.find((e) => e.id === id && !e.deleted) || null; },

  _upsert(list, items) {
    const stamp = nowStamp();
    for (const item of items) {
      const next = { ...item, updatedAt: stamp };
      const i = this.doc[list].findIndex((x) => x.id === item.id);
      if (i >= 0) this.doc[list][i] = next; else this.doc[list].push(next);
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

  resetLocal() {
    try { localStorage.removeItem(KEY); } catch { /* nada */ }
    this.doc = emptyDoc();
    this.emit(false);
  },
};
