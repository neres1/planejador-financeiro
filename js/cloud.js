// Sincronização com o Supabase: baixa o que mudou no servidor, aplica (vence o mais recente)
// e envia o que mudou aqui. Tudo trafega e fica guardado criptografado.

import { store, nowStamp, kindOf } from './store.js';
import { db, auth, AuthError } from './supa.js';
import { encryptJSON, decryptJSON } from './crypto.js';

const iso = (t) => new Date(t).toISOString();
const BATCH = 200;

const listeners = new Set();

export const cloud = {
  state: 'idle', // idle | syncing | ok | error | offline | auth
  message: '',
  lastSync: null,
  _running: false,
  _again: false,
  _timer: null,

  onStatus(fn) { listeners.add(fn); },
  _set(state, message = '') {
    this.state = state;
    this.message = message;
    for (const fn of listeners) fn(this);
  },

  markDirty() { this.schedule(); },
  schedule(delay = 1200) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.run(), delay);
  },

  async run() {
    if (!store.key || !auth.session) return;
    if (!navigator.onLine) { this._set('offline', 'Sem internet — as alterações ficam salvas no aparelho e serão enviadas depois.'); return; }
    if (this._running) { this._again = true; return; }
    this._running = true;
    this._set('syncing');
    try {
      // 1) baixar
      const rows = await db.pullItems(store.cursor);
      let cursor = store.cursor;
      const incoming = [];
      for (const r of rows) {
        if (!cursor || r.server_updated_at > cursor) cursor = r.server_updated_at;
        if (r.deleted || !r.data) {
          incoming.push({ kind: kindOf(r.id), item: { id: r.id, deleted: true, updatedAt: iso(r.updated_at) } });
          continue;
        }
        try { incoming.push(await decryptJSON(store.key, r.data)); } catch { /* item ilegível: ignora */ }
      }
      store.applyRemote(incoming);

      // 2) enviar
      const sent = new Map();
      const payload = [];
      for (const id of store.dirty) {
        const f = store.find(id);
        if (!f) { store.dirty.delete(id); continue; }
        const it = f.item;
        sent.set(id, it);
        payload.push({
          id,
          deleted: !!it.deleted,
          updated_at: it.updatedAt || nowStamp(),
          data: it.deleted ? null : await encryptJSON(store.key, { kind: f.kind, item: it }),
        });
      }
      for (let i = 0; i < payload.length; i += BATCH) await db.pushItems(payload.slice(i, i + BATCH));
      // só limpa o que não foi alterado de novo enquanto enviava
      for (const [id, it] of sent) { const f = store.find(id); if (f && f.item === it) store.dirty.delete(id); }

      store.cursor = cursor;
      store.persist();
      this.lastSync = nowStamp();
      this._set('ok');
    } catch (e) {
      if (e instanceof AuthError || e.status === 401) this._set('auth', 'Sua sessão expirou. Saia e entre novamente.');
      else this._set(navigator.onLine ? 'error' : 'offline', e.message || String(e));
    } finally {
      this._running = false;
      if (this._again) { this._again = false; this.schedule(200); }
    }
  },
};
