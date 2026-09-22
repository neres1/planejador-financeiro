// Criptografia de ponta a ponta (WebCrypto).
//
// - Uma "chave de dados" AES-256-GCM aleatória cifra cada lançamento/categoria.
// - Essa chave é guardada no servidor duas vezes, sempre embrulhada (cifrada):
//   com uma chave derivada da senha (PBKDF2) e com uma derivada da chave de recuperação.
// - O servidor nunca vê a senha, a chave de recuperação nem a chave de dados.

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = globalThis.crypto.subtle;

export const PW_ITERATIONS = 310000;
const REC_ITERATIONS = 100000;

export function toB64(bytes) {
  let bin = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function fromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

async function deriveKek(secret, salt, iterations) {
  const base = await subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function seal(key, bytes) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return toB64(out);
}
async function open(key, b64) {
  const all = fromB64(b64);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12) }, key, all.subarray(12)));
}

// Chave de dados utilizável, sem possibilidade de exportação (fica guardada no aparelho).
export const importDataKey = (raw) => subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

export async function encryptJSON(key, obj) { return seal(key, enc.encode(JSON.stringify(obj))); }
export async function decryptJSON(key, b64) { return JSON.parse(dec.decode(await open(key, b64))); }

// ---- chave de recuperação: 25 caracteres base32 legíveis, ex. "K7QF-2M9X-…"
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O, 1/I
export function makeRecoveryKey() {
  const bytes = randomBytes(25);
  const chars = [...bytes].map((b) => ALPHABET[b % 32]).join('');
  return chars.match(/.{1,5}/g).join('-');
}
export const normalizeRecoveryKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---- cofre (linha da tabela `vault`)
export async function createVault(password) {
  const raw = randomBytes(32);
  const recoveryKey = makeRecoveryKey();
  const salt = randomBytes(16), recSalt = randomBytes(16);
  const vault = {
    kdf_iter: PW_ITERATIONS,
    salt: toB64(salt),
    rec_salt: toB64(recSalt),
    wrapped_key_pw: await seal(await deriveKek(password, salt, PW_ITERATIONS), raw),
    wrapped_key_rec: await seal(await deriveKek(normalizeRecoveryKey(recoveryKey), recSalt, REC_ITERATIONS), raw),
  };
  return { vault, raw, recoveryKey };
}

export async function unlockWithPassword(vault, password) {
  const kek = await deriveKek(password, fromB64(vault.salt), vault.kdf_iter);
  return open(kek, vault.wrapped_key_pw); // lança erro se a senha estiver errada
}

export async function unlockWithRecovery(vault, recoveryKey) {
  const kek = await deriveKek(normalizeRecoveryKey(recoveryKey), fromB64(vault.rec_salt), REC_ITERATIONS);
  return open(kek, vault.wrapped_key_rec);
}

// Reembrulha a chave de dados com uma nova senha (troca/redefinição de senha).
export async function rewrapPassword(raw, password) {
  const salt = randomBytes(16);
  return { kdf_iter: PW_ITERATIONS, salt: toB64(salt), wrapped_key_pw: await seal(await deriveKek(password, salt, PW_ITERATIONS), raw) };
}

// Gera uma nova chave de recuperação (a antiga deixa de funcionar).
export async function rewrapRecovery(raw) {
  const recoveryKey = makeRecoveryKey();
  const recSalt = randomBytes(16);
  return {
    recoveryKey,
    patch: { rec_salt: toB64(recSalt), wrapped_key_rec: await seal(await deriveKek(normalizeRecoveryKey(recoveryKey), recSalt, REC_ITERATIONS), raw) },
  };
}
