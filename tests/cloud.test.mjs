// Sincronização criptografada contra um Supabase simulado (auth + RLS + push_items).
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- ambiente de navegador mínimo
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true, userAgent: 'node' }, configurable: true });

// ---- servidor simulado
const server = { users: { 'eu@x.com': { id: 'u1', pw: 'senha-forte-123' }, 'outro@x.com': { id: 'u2', pw: 'outra-senha-456' } }, vault: new Map(), items: [], clock: 0 };
const tokens = new Map();
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
const stamp = () => new Date(Date.UTC(2026, 0, 1) + ++server.clock * 1000).toISOString().replace('Z', '+00:00');

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method || 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  const bearer = (opts.headers.Authorization || '').replace('Bearer ', '');
  const uid = tokens.get(bearer);
  if (u.pathname === '/auth/v1/token') {
    const user = server.users[body.email];
    if (!user || user.pw !== body.password) return json({ error_code: 'invalid_credentials' }, 400);
    const t = `tok-${user.id}-${Math.random()}`;
    tokens.set(t, user.id);
    return json({ access_token: t, refresh_token: 'r', expires_in: 3600, user: { id: user.id, email: body.email } });
  }
  if (u.pathname === '/auth/v1/user' && method === 'PUT') {
    const user = Object.values(server.users).find((x) => x.id === uid);
    user.pw = body.password;
    return json({});
  }
  if (u.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
  if (!uid) return json({ message: 'permission denied' }, 401);
  if (u.pathname === '/rest/v1/vault') {
    if (method === 'GET') return json(server.vault.has(uid) ? [{ ...server.vault.get(uid), user_id: uid }] : []);
    if (method === 'POST') { server.vault.set(uid, body); return new Response(null, { status: 201 }); }
    if (method === 'PATCH') { server.vault.set(uid, { ...server.vault.get(uid), ...body }); return new Response(null, { status: 204 }); }
  }
  if (u.pathname === '/rest/v1/items') {
    if (method === 'DELETE') { server.items = server.items.filter((r) => r.user_id !== uid); return new Response(null, { status: 204 }); }
    const since = (u.searchParams.get('server_updated_at') || '').replace('gte.', '');
    const offset = Number(u.searchParams.get('offset') || 0);
    const rows = server.items.filter((r) => r.user_id === uid && (!since || r.server_updated_at >= since))
      .sort((a, b) => (a.server_updated_at < b.server_updated_at ? -1 : 1)).slice(offset, offset + 1000)
      .map(({ user_id, ...r }) => r);
    return json(rows);
  }
  if (u.pathname === '/rest/v1/rpc/push_items') {
    for (const r of body.rows) {
      const cur = server.items.find((x) => x.user_id === uid && x.id === r.id);
      if (!cur) server.items.push({ user_id: uid, ...r, server_updated_at: stamp() });
      else if (cur.updated_at < r.updated_at) Object.assign(cur, r, { server_updated_at: stamp() });
    }
    return new Response(null, { status: 204 });
  }
  return json({ message: 'not found' }, 404);
};

const { auth, db } = await import('../js/supa.js');
const { store } = await import('../js/store.js');
const { cloud } = await import('../js/cloud.js');
const C = await import('../js/crypto.js');

async function login(email, pw) {
  await auth.signIn(email, pw);
  let vault = await db.getVault();
  let recoveryKey = null;
  if (!vault) {
    const v = await C.createVault(pw);
    await db.createVault(v.vault);
    recoveryKey = v.recoveryKey;
    vault = v.vault;
  }
  const key = await C.importDataKey(await C.unlockWithPassword(vault, pw));
  await store.open(auth.session.user.id, key);
  return recoveryKey;
}
const entry = (id, description, amount) => ({ id, type: 'despesa', description, amount, categoryId: 'cat-moradia', date: '2026-10-05', recurrence: { freq: 'monthly', interval: 1, byMonthDay: 5, end: { type: 'never' } }, overrides: {} });

let recoveryKey;

test('aparelho A: cria conta, lança e envia criptografado', async () => {
  recoveryKey = await login('eu@x.com', 'senha-forte-123');
  assert.match(recoveryKey, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){4}$/);
  store.saveEntries(entry('e1', 'Aluguel', 250000));
  store.saveCategory({ id: 'cat-academia', name: 'Academia', emoji: '🏋️', group: 'fixo', color: '#000' });
  await cloud.run();
  assert.equal(cloud.state, 'ok');
  assert.equal(store.dirty.size, 0);
  const mine = server.items.filter((r) => r.user_id === 'u1');
  assert.equal(mine.length, 2);
  const everything = JSON.stringify(server.items) + JSON.stringify([...server.vault.values()]);
  assert.ok(!everything.includes('Aluguel') && !everything.includes('250000') && !everything.includes('Academia'), 'servidor não pode ver texto claro');
});

test('cópia local também é criptografada', () => {
  const blob = localStorage.getItem('pf:u:u1');
  assert.ok(blob && !blob.includes('Aluguel'));
});

test('aparelho B: entra com a mesma conta e recebe os dados', async () => {
  store.close({ wipe: true });
  await login('eu@x.com', 'senha-forte-123');
  await cloud.run();
  assert.equal(store.entry('e1').description, 'Aluguel');
  assert.equal(store.category('cat-academia').name, 'Academia');
  // B altera e exclui; A precisa ver
  store.saveEntries({ ...store.entry('e1'), amount: 270000 });
  store.saveCategory({ ...store.category('cat-academia') });
  store.deleteCategory('cat-academia');
  await cloud.run();
  store.close({ wipe: true });
  await login('eu@x.com', 'senha-forte-123');
  await cloud.run();
  assert.equal(store.entry('e1').amount, 270000);
  assert.equal(store.category('cat-academia'), null);
});

test('alteração mais antiga não sobrescreve a mais nova no servidor', async () => {
  const before = server.items.find((r) => r.id === 'e1').updated_at;
  await db.pushItems([{ id: 'e1', deleted: false, updated_at: '2020-01-01T00:00:00.000Z', data: 'lixo' }]);
  assert.equal(server.items.find((r) => r.id === 'e1').updated_at, before);
});

test('outro usuário não enxerga nada do primeiro', async () => {
  store.close({ wipe: true });
  await login('outro@x.com', 'outra-senha-456');
  await cloud.run();
  assert.equal(store.entries().length, 0);
});

test('esqueci a senha: chave de recuperação destrava com a senha nova', async () => {
  store.close({ wipe: true });
  await auth.signIn('eu@x.com', 'senha-forte-123');
  const vault = await db.getVault();
  await assert.rejects(C.unlockWithRecovery(vault, 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA'));
  const raw = await C.unlockWithRecovery(vault, recoveryKey.toLowerCase().replace(/-/g, ' '));
  await auth.setPassword('nova-senha-789');
  await db.updateVault(await C.rewrapPassword(raw, 'nova-senha-789'));
  store.close({ wipe: true });
  await login('eu@x.com', 'nova-senha-789');
  await cloud.run();
  assert.equal(store.entry('e1').amount, 270000);
  await assert.rejects(C.unlockWithPassword(await db.getVault(), 'senha-forte-123'));
});
