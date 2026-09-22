// Cliente mínimo do Supabase (Auth + REST) usando fetch — sem dependências externas.
// A chave "publishable" é pública por natureza: sem login ela não dá acesso a nada
// (Row Level Security + cadastro desligado no projeto).

export const SUPABASE_URL = 'https://sgipqbpqjjrtrhwouegz.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_iaBZk6H-NZEq-wnDvwqB7g_1Wu_oC7h';

const SESSION_KEY = 'pf:session';

export class AuthError extends Error {}

// Traduz as mensagens mais comuns do Supabase Auth.
function authMessage(j, status) {
  const code = j.error_code || j.code || j.error || '';
  const map = {
    invalid_credentials: 'E-mail ou senha incorretos.',
    invalid_grant: 'E-mail ou senha incorretos.',
    email_not_confirmed: 'E-mail ainda não confirmado — use o link do convite.',
    user_not_found: 'Usuário não encontrado.',
    weak_password: 'Senha fraca — use pelo menos 10 caracteres, misturando letras e números.',
    same_password: 'A nova senha deve ser diferente da atual.',
    over_email_send_rate_limit: 'Muitos e-mails enviados. Tente de novo em alguns minutos.',
    over_request_rate_limit: 'Muitas tentativas. Aguarde um pouco e tente de novo.',
    session_not_found: 'Sessão expirada. Entre novamente.',
    refresh_token_not_found: 'Sessão expirada. Entre novamente.',
    otp_expired: 'O link expirou. Peça um novo.',
  };
  if (map[code]) return map[code];
  if (status === 429) return map.over_request_rate_limit;
  return j.msg || j.message || j.error_description || `Erro ${status}`;
}

async function authFetch(path, { method = 'POST', body, token } = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method,
    headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new AuthError(authMessage(j, res.status)), { status: res.status, code: j.error_code });
  return j;
}

const toSession = (j) => ({
  access_token: j.access_token,
  refresh_token: j.refresh_token,
  expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
  user: j.user ? { id: j.user.id, email: j.user.email } : null,
});

export const auth = {
  session: (() => { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } })(),

  _save(s) {
    this.session = s;
    try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); } catch { /* nada */ }
  },

  async signIn(email, password) {
    const j = await authFetch('token?grant_type=password', { body: { email, password } });
    this._save(toSession(j));
    return this.session;
  },

  _refreshing: null,
  async refresh() {
    if (!this.session) throw new AuthError('Sem sessão.');
    if (!this._refreshing) {
      this._refreshing = authFetch('token?grant_type=refresh_token', { body: { refresh_token: this.session.refresh_token } })
        .then((j) => { this._save({ ...toSession(j), user: toSession(j).user || this.session.user }); return this.session; })
        .finally(() => { this._refreshing = null; });
    }
    return this._refreshing;
  },

  // Token de acesso válido (renova sozinho quando está para expirar).
  async token() {
    if (!this.session) throw new AuthError('Sem sessão.');
    if (this.session.expires_at - 60 < Date.now() / 1000) await this.refresh();
    return this.session.access_token;
  },

  async signOut() {
    const s = this.session;
    this._save(null);
    if (s) { try { await authFetch('logout', { body: {}, token: s.access_token }); } catch { /* offline: tudo bem */ } }
  },

  async setPassword(password) {
    await authFetch('user', { method: 'PUT', body: { password }, token: await this.token() });
  },

  async requestReset(email, redirectTo) {
    await authFetch(`recover?redirect_to=${encodeURIComponent(redirectTo)}`, { body: { email } });
  },

  // Links de convite/redefinição chegam como #access_token=…&type=invite|recovery
  // (ou #error=…). Retorna { type } ou { error }, e limpa o endereço.
  async consumeRedirect() {
    const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    if (!hash || !/access_token|error/.test(hash)) return null;
    const p = new URLSearchParams(hash);
    history.replaceState(null, '', location.pathname + location.search);
    if (p.get('error')) return { error: p.get('error_code') === 'otp_expired' ? 'O link expirou ou já foi usado. Peça um novo.' : (p.get('error_description') || p.get('error')).replace(/\+/g, ' ') };
    const session = {
      access_token: p.get('access_token'),
      refresh_token: p.get('refresh_token'),
      expires_at: Number(p.get('expires_at')) || Math.floor(Date.now() / 1000) + Number(p.get('expires_in') || 3600),
      user: null,
    };
    const u = await authFetch('user', { method: 'GET', token: session.access_token });
    session.user = { id: u.id, email: u.email };
    this._save(session);
    return { type: p.get('type') || 'magiclink' };
  },
};

// ---------------------------------------------------------------------------
// REST (PostgREST) — sempre com o token do usuário; RLS garante o isolamento.

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const doFetch = async () => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    cache: 'no-store',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${await auth.token()}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let res = await doFetch();
  if (res.status === 401) { await auth.refresh(); res = await doFetch(); }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw Object.assign(new Error(j.message || `Erro ${res.status} no servidor`), { status: res.status });
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const db = {
  async getVault() {
    const rows = await rest('vault?select=*');
    return rows[0] || null;
  },
  createVault(v) { return rest('vault', { method: 'POST', body: v, prefer: 'return=minimal' }); },
  updateVault(patch) {
    return rest(`vault?user_id=eq.${auth.session.user.id}`, { method: 'PATCH', body: { ...patch, updated_at: new Date().toISOString() }, prefer: 'return=minimal' });
  },
  // Itens alterados no servidor depois de `since` (em páginas de 1000).
  async pullItems(since) {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const q = `items?select=id,data,deleted,updated_at,server_updated_at&order=server_updated_at.asc,id.asc&limit=1000&offset=${offset}`
        + (since ? `&server_updated_at=gte.${encodeURIComponent(since)}` : '');
      const page = await rest(q);
      out.push(...page);
      if (page.length < 1000) return out;
    }
  },
  pushItems(rows) { return rest('rpc/push_items', { method: 'POST', body: { rows } }); },
  deleteAllItems() { return rest(`items?user_id=eq.${auth.session.user.id}`, { method: 'DELETE', prefer: 'return=minimal' }); },
};
