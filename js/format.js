import { parseISO, pad, weekday } from './recurrence.js';

export const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const WD_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
export const WD_LETTER = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const money = (cents) => brl.format((cents || 0) / 100);

export function moneyCompact(cents) {
  const v = Math.abs(cents) / 100;
  if (v >= 1000) return (v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + 'k';
  return v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

// Campo de valor estilo "caixa eletrônico": só dígitos, os dois últimos são centavos.
export function centsFromDigits(str) {
  const digits = String(str || '').replace(/\D/g, '').slice(0, 13);
  return digits ? parseInt(digits, 10) : 0;
}
export const digitsDisplay = (cents) => (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function fmtMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${cap(MONTHS[m - 1])} ${y}`;
}

export function fmtDayHeader(iso) {
  const { m, d } = parseISO(iso);
  return `${cap(WD_SHORT[weekday(iso)])}, ${d} de ${MONTHS[m - 1].slice(0, 3)}`;
}

export function fmtShort(iso) {
  const { m, d } = parseISO(iso);
  return `${pad(d)}/${pad(m)}`;
}

export function fmtFull(iso) {
  const { y, m, d } = parseISO(iso);
  return `${d} de ${MONTHS[m - 1]} de ${y}`;
}

export function fmtDateBR(iso) {
  const { y, m, d } = parseISO(iso);
  return `${pad(d)}/${pad(m)}/${y}`;
}

export function fmtRelativeTime(isoDateTime) {
  if (!isoDateTime) return 'nunca';
  const s = Math.round((Date.now() - new Date(isoDateTime).getTime()) / 1000);
  if (s < 45) return 'agora';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return new Date(isoDateTime).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}
