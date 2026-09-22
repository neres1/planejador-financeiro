// Leitura e gravação do arquivo de dados num repositório do GitHub (API de Contents).
// A configuração (inclusive o token) fica só neste aparelho, nunca vai para o arquivo de dados.

import { store, merge, canon, validateDoc, nowStamp } from './store.js';

const API = 'https://api.github.com';
const CFG_KEY = 'pf:github';
const META_KEY = 'pf:sync';

export class ConflictError extends Error {}

export function loadConfig() {
  try { return { branch: 'main', path: 'financas.json', ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') }; }
  catch { return { branch: 'main', path: 'financas.json' }; }
}
export function saveConfig(cfg) { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }
export function clearConfig() { localStorage.removeItem(CFG_KEY); localStorage.removeItem(META_KEY); }
export const isConfigured = (cfg = loadConfig()) => !!(cfg.token && cfg.owner && cfg.repo);

function loadMeta() { try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch { return {}; } }
function saveMeta(m) { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch { /* nada */ } }

const headers = (token, accept = 'application/vnd.github+json') => ({
  Authorization: `Bearer ${token}`,
  Accept: accept,
  'X-GitHub-Api-Version': '2022-11-28',
});

const contentsUrl = (cfg) =>
  `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${cfg.path.split('/').map(encodeURIComponent).join('/')}`;

async function apiError(res) {
  let msg = `${res.status}`;
  try { const j = await res.json(); if (j.message) msg += ` · ${j.message}`; } catch { /* nada */ }
  if (res.status === 401) msg = 'Token inválido ou expirado (401).';
  if (res.status === 403) msg = 'Sem permissão (403). O token precisa de "Contents: Read and write" neste repositório.';
  const err = new Error(msg);
  err.status = res.status;
  return err;
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export async function testRepo(cfg) {
  const res = await fetch(`${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`, { headers: headers(cfg.token), cache: 'no-store' });
  if (res.status === 404) throw new Error('Repositório não encontrado — confira usuário/nome e se o token tem acesso a ele.');
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  return { private: j.private, canPush: !!(j.permissions && j.permissions.push), fullName: j.full_name };
}

async function getFile(cfg) {
  const url = `${contentsUrl(cfg)}?ref=${encodeURIComponent(cfg.branch)}`;
  const res = await fetch(url, { headers: headers(cfg.token), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw await apiError(res);
  const j = await res.json();
  let text;
  if (j.content && j.encoding === 'base64') text = b64decode(j.content);
  else {
    // arquivos acima de 1 MB vêm sem conteúdo; busca a versão "raw"
    const raw = await fetch(url, { headers: headers(cfg.token, 'application/vnd.github.raw+json'), cache: 'no-store' });
    if (!raw.ok) throw await apiError(raw);
    text = await raw.text();
  }
  const doc = JSON.parse(text);
  if (!validateDoc(doc)) throw new Error('O arquivo no GitHub não parece ser um arquivo de dados deste app.');
  return { sha: j.sha, doc };
}

async function putFile(cfg, doc, sha) {
  const device = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : 'web';
  const body = {
    message: `Atualiza dados financeiros (${device})`,
    content: b64encode(JSON.stringify(doc, null, 1) + '\n'),
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;
  const res = await fetch(contentsUrl(cfg), { method: 'PUT', headers: { ...headers(cfg.token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 409 || res.status === 422) throw new ConflictError('conflito');
  if (!res.ok) throw await apiError(res);
  return (await res.json()).content.sha;
}

// ---------------------------------------------------------------------------
// Sincronizador: baixa, mescla com o local e envia se houver diferença.

const statusListeners = new Set();
export const sync = {
  state: 'idle', // idle | off | syncing | ok | error | offline
  message: '',
  meta: loadMeta(),
  _running: false,
  _again: false,
  _timer: null,

  onStatus(fn) { statusListeners.add(fn); },
  _set(state, message = '') {
    this.state = state;
    this.message = message;
    for (const fn of statusListeners) fn(this);
  },

  markDirty() {
    this.meta.dirty = true;
    saveMeta(this.meta);
    this.schedule();
  },

  schedule(delay = 1500) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.run(), delay);
  },

  async run() {
    const cfg = loadConfig();
    if (!isConfigured(cfg)) { this._set('off'); return; }
    if (!navigator.onLine) { this._set('offline', 'Sem internet — os dados estão salvos neste aparelho.'); return; }
    if (this._running) { this._again = true; return; }
    this._running = true;
    this._set('syncing');
    try {
      for (let attempt = 0; ; attempt++) {
        const remote = await getFile(cfg);
        const merged = remote ? merge(store.doc, remote.doc) : store.doc;
        if (canon(merged) !== canon(store.doc)) store.replace(merged);
        if (remote && canon(merged) === canon(remote.doc)) { this.meta.sha = remote.sha; break; }
        try {
          this.meta.sha = await putFile(cfg, { ...store.doc, updatedAt: nowStamp() }, remote && remote.sha);
          break;
        } catch (e) {
          if (!(e instanceof ConflictError) || attempt >= 3) throw e;
        }
      }
      this.meta.dirty = false;
      this.meta.lastSync = nowStamp();
      saveMeta(this.meta);
      this._set('ok');
    } catch (e) {
      this._set(navigator.onLine ? 'error' : 'offline', e.message || String(e));
    } finally {
      this._running = false;
      if (this._again) { this._again = false; this.schedule(200); }
    }
  },
};
