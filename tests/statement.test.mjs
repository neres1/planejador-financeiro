import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDate, parseAmount, parseParcel, parseOFX, parseCSV, readStatement, decodeBytes,
  splitTransactions, detectDueYM, planImport, importEntries, guessCategory, invoiceWindow,
} from '../js/statement.js';
import { invoiceItems, cardUsed } from '../js/cards.js';
import { expand } from '../js/recurrence.js';
import { defaultCategories } from '../js/store.js';

const card = (extra = {}) => ({ id: 'card-nu', name: 'Nubank', limit: 500000, dueDay: 3, closeDays: 7, ...extra });
const cats = defaultCategories();
let seq = 0;
const makeId = () => `e${++seq}`;

test('datas e valores em formatos brasileiros e OFX', () => {
  assert.equal(parseDate('15/03/2026'), '2026-03-15');
  assert.equal(parseDate('5/3/26'), '2026-03-05');
  assert.equal(parseDate('2026-03-15'), '2026-03-15');
  assert.equal(parseDate('20260315120000[-3:BRT]'), '2026-03-15');
  assert.equal(parseDate('15 mar 2026'), '2026-03-15');
  assert.equal(parseDate('abc'), null);
  assert.equal(parseAmount('R$ 1.234,56'), 123456);
  assert.equal(parseAmount('-45.90'), -4590);
  assert.equal(parseAmount('1,234.56'), 123456);
  assert.equal(parseAmount('1.234'), 123400);
  assert.equal(parseAmount('12,5'), 1250);
  assert.equal(parseAmount('(10,00)'), -1000);
  assert.equal(parseAmount('10,00 D'), -1000);
  assert.equal(parseAmount('-R$ 7,00'), -700);
  assert.equal(parseAmount(''), null);
});

test('parcela na descrição', () => {
  assert.deepEqual(parseParcel('Magazine Luiza - Parcela 3/10'), { k: 3, n: 10, base: 'Magazine Luiza' });
  assert.deepEqual(parseParcel('LOJA X PARC 02/06'), { k: 2, n: 6, base: 'LOJA X' });
  assert.deepEqual(parseParcel('AMAZON 1/3'), { k: 1, n: 3, base: 'AMAZON' });
  assert.equal(parseParcel('PADARIA 12/05/2026'), null);
  assert.equal(parseParcel('UBER TRIP'), null);
  assert.equal(parseParcel('LOJA 1/1'), null);
});

const OFX = `OFXHEADER:100
DATA:OFXSGML
CHARSET:1252

<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST>
<DTSTART>20260228<DTEND>20260327
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260305000000[-3:BRT]<TRNAMT>-52.30<FITID>a1<MEMO>Supermercado Bom Preço
</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260310<TRNAMT>-120.00<FITID>a2<MEMO>Loja &amp; Cia - Parcela 3/10
</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260306<TRNAMT>800.00<FITID>a3<MEMO>Pagamento recebido
</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260320<TRNAMT>-39.90<FITID>a4<NAME>NETFLIX.COM
</STMTTRN>
</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

test('OFX: transações, entidades e parcelas', () => {
  const txs = parseOFX(OFX);
  assert.equal(txs.length, 4);
  assert.deepEqual(txs[0], { date: '2026-03-05', description: 'Supermercado Bom Preço', amount: -5230, fitid: 'a1', parcel: null });
  assert.equal(txs[1].description, 'Loja & Cia - Parcela 3/10');
  assert.deepEqual(txs[1].parcel, { k: 3, n: 10, base: 'Loja & Cia' });
  assert.equal(txs[3].description, 'NETFLIX.COM');
  assert.equal(readStatement(OFX, 'fatura.ofx').format, 'OFX');
});

test('OFX do Nubank (tags fechadas, cabeçalho SGML, parcelas antigas no dia 1º)', () => {
  const t = (date, amt, id, memo, type = 'DEBIT') => `<STMTTRN>\n<TRNTYPE>${type}</TRNTYPE>\n<DTPOSTED>${date}000000[-3:BRT]</DTPOSTED>\n<TRNAMT>${amt}</TRNAMT>\n<FITID>${id}</FITID>\n<MEMO>${memo}</MEMO>\n</STMTTRN>`;
  const ofx = `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\n<OFX>\n<SIGNONMSGSRSV1>\n<SONRS>\n<STATUS>\n<CODE>0</CODE>\n</STATUS>\n<DTSERVER>20261001012451[0:GMT]</DTSERVER>\n<FI>\n<ORG>NU PAGAMENTOS S.A.</ORG>\n</FI>\n</SONRS>\n</SIGNONMSGSRSV1>\n`
    + `<CREDITCARDMSGSRSV1>\n<CCSTMTTRNRS>\n<CCSTMTRS>\n<CURDEF>BRL</CURDEF>\n<BANKTRANLIST>\n<DTSTART>20260901000000[-3:BRT]</DTSTART>\n<DTEND>20261001000000[-3:BRT]</DTEND>\n`
    + [t('20260923', '-16.90', 'f1', 'Dl*Google Youtub'), t('20260922', '70.56', 'f2', 'Pagamento recebido', 'CREDIT'),
      t('20260913', '-6.75', 'f3', 'Uber Uber *Trip Help.U'), t('20260909', '-28.48', 'f4', 'Almeidaatacarejo'),
      t('20260905', '-68.08', 'f5', 'Loja Exemplo - Parcela 1/12'), t('20260901', '-95.74', 'f6', 'Drogar Centro - Parcela 2/4'),
      t('20260901', '-134.45', 'f7', 'Mercado*Mercadolivre - Parcela 2/2')].join('\n')
    + `\n</BANKTRANLIST>\n<LEDGERBAL>\n<BALAMT>-2842.04</BALAMT>\n</LEDGERBAL>\n</CCSTMTRS>\n</CCSTMTTRNRS>\n</CREDITCARDMSGSRSV1>\n</OFX>\n`;
  const { format, txs } = readStatement(new TextEncoder().encode(ofx), 'Nubank_2026-10-08.ofx');
  assert.equal(format, 'OFX');
  assert.equal(txs.length, 7);
  const { purchases, credits } = splitTransactions(txs);
  assert.equal(purchases.length, 6);
  assert.equal(credits.length, 1);
  const c = card({ dueDay: 8 });
  assert.equal(detectDueYM(c, purchases), '2026-10');
  const items = planImport(purchases, c, [], '2026-10', cats);
  const by = (d) => items.find((i) => i.description === d);
  assert.equal(by('Dl*Google Youtub').categoryId, 'cat-assinaturas');
  assert.equal(by('Uber Uber *Trip Help.U').categoryId, 'cat-transporte');
  assert.equal(by('Almeidaatacarejo').categoryId, 'cat-mercado');
  assert.equal(by('Drogar Centro').categoryId, 'cat-farmacia');
  assert.equal(by('Mercado*Mercadolivre').categoryId, 'cat-compras');
  // parcela antiga com data 01/09 (antes do ciclo 02/09–01/10) entra na fatura e as próximas seguem
  const entries = importEntries(items, c, makeId);
  const drog = entries.find((e) => e.description === 'Drogar Centro');
  assert.equal(drog.recurrence.end.count, 3);
  assert.deepEqual(invoiceItems(c, entries, '2026-12').filter((o) => o.entryId === drog.id).map((o) => `${o.n}/${o.total}`), ['4/4']);
});

test('CSV do Nubank (vírgula, ponto decimal, compras positivas)', () => {
  const csv = 'date,title,amount\n2026-03-05,Ifood,45.90\n2026-03-06,Pagamento recebido,-800.00\n2026-03-08,"Mercado Livre - Parcela 2/3",99.97\n';
  const txs = parseCSV(csv);
  assert.equal(txs.length, 3);
  const { purchases, credits } = splitTransactions(txs);
  assert.deepEqual(purchases.map((p) => p.amount), [4590, 9997]);
  assert.equal(credits.length, 1);
  assert.deepEqual(purchases[1].parcel, { k: 2, n: 3, base: 'Mercado Livre' });
});

test('CSV do C6 (ponto e vírgula, coluna de parcela, valor em R$)', () => {
  const csv = 'Data de Compra;Nome no Cartão;Final do Cartão;Categoria;Descrição;Parcela;Valor (em US$);Cotação (em R$);Valor (em R$)\n'
    + '05/03/2026;FULANO;1234;Mercado;PAO DE ACUCAR;Única;0;0;152,30\n'
    + '10/01/2026;FULANO;1234;Eletro;KABUM;3/6;0;0;1.250,00\n';
  const txs = parseCSV(csv);
  assert.equal(txs[0].description, 'PAO DE ACUCAR');
  assert.equal(txs[0].amount, 15230);
  assert.equal(txs[1].amount, 125000);
  assert.deepEqual(txs[1].parcel, { k: 3, n: 6, base: 'KABUM' });
});

test('CSV sem cabeçalho e em Windows-1252', () => {
  const bytes = new Uint8Array([...Buffer.from('05/03/2026;Padaria S'), 0xe3, ...Buffer.from('o Jo'), 0xe3, ...Buffer.from('o;-12,50\n06/03/2026;Uber;-30,00\n')]);
  const txs = parseCSV(decodeBytes(bytes));
  assert.equal(txs[0].description, 'Padaria São João');
  assert.equal(txs[1].amount, -3000);
});

test('arquivo sem transações dá erro claro', () => {
  assert.throws(() => readStatement('a;b\n1;2\n', 'x.csv'), /data e valor|nenhuma/);
});

test('fatura detectada e janela de compras', () => {
  const { purchases } = splitTransactions(parseOFX(OFX));
  assert.equal(detectDueYM(card(), purchases), '2026-04'); // fecha 27/03, vence 03/04
  const w = invoiceWindow(card(), '2026-04');
  assert.equal(w.start, '2026-02-25');
  assert.equal(w.end, '2026-03-27');
});

test('categoria: histórico, palavras-chave e "Outros"', () => {
  const hist = new Map([['padaria do ze', 'cat-mercado']]);
  assert.equal(guessCategory('PADARIA DO ZE', cats, hist), 'cat-mercado');
  assert.equal(guessCategory('IFOOD *IFOOD', cats, new Map()), 'cat-restaurantes');
  assert.equal(guessCategory('NETFLIX.COM', cats, new Map()), 'cat-assinaturas');
  assert.equal(guessCategory('MERCADO PAGO*LOJA', cats, new Map()), 'cat-outros');
  assert.equal(guessCategory('XPTO LTDA', cats, new Map()), 'cat-outros');
});

test('parcelada: lança da parcela atual até a última, uma por fatura', () => {
  const c = card();
  const { purchases } = splitTransactions(parseOFX(OFX));
  const items = planImport(purchases, c, [], '2026-04', cats);
  assert.equal(items.length, 3);
  assert.ok(items.every((i) => i.include && i.status === 'new'));
  const entries = importEntries(items, c, makeId);
  const parc = entries.find((e) => e.installments);
  assert.equal(parc.description, 'Loja & Cia');
  assert.equal(parc.installments, 10);
  assert.equal(parc.totalAmount, 120000);
  assert.equal(parc.recurrence.end.count, 8);
  assert.equal(parc.ordinalOffset, 2);
  // 3/10 na fatura de abril, 10/10 na de novembro
  const at = (due) => invoiceItems(c, entries, due).filter((o) => o.entryId === parc.id).map((o) => `${o.n}/${o.total}`);
  assert.deepEqual(at('2026-04'), ['3/10']);
  assert.deepEqual(at('2026-05'), ['4/10']);
  assert.deepEqual(at('2026-11'), ['10/10']);
  assert.deepEqual(at('2026-12'), []);
  // limite ocupa as 8 parcelas que faltam
  assert.equal(cardUsed(c, entries, () => false, '2026-03-30'), 5230 + 3990 + 8 * 12000);
});

test('última parcela (10/10) também aparece como 10/10', () => {
  const c = card();
  const items = planImport([{ row: 0, date: '2026-03-10', description: 'TV 10/10', amount: 5000, fitid: null, parcel: { k: 10, n: 10, base: 'TV' } }], c, [], '2026-04', cats);
  const [e] = importEntries(items, c, makeId);
  const occ = expand(e, '2026-01-01', '2026-12-31');
  assert.equal(occ.length, 1);
  assert.equal(`${occ[0].n}/${occ[0].total}`, '10/10');
});

test('reimportar a mesma fatura ou a do mês seguinte não duplica', () => {
  const c = card();
  const { purchases } = splitTransactions(parseOFX(OFX));
  const first = importEntries(planImport(purchases, c, [], '2026-04', cats), c, makeId);
  const again = planImport(purchases, c, first, '2026-04', cats);
  assert.ok(again.every((i) => i.status === 'imported' && !i.include));
  // mês seguinte: parcela 4/10 já está lançada pela série
  const next = [{ row: 0, date: '2026-04-10', description: 'Loja & Cia - Parcela 4/10', amount: 12000, fitid: 'b9', parcel: { k: 4, n: 10, base: 'Loja & Cia' } }];
  const plan = planImport(next, c, first, '2026-05', cats);
  assert.equal(plan[0].status, 'imported');
});

test('compra lançada à mão é marcada como "parece já lançado"', () => {
  const c = card();
  const manual = { id: 'm1', type: 'despesa', payment: 'credito', cardId: 'card-nu', amount: 5230, description: 'mercado', categoryId: 'cat-mercado', date: '2026-03-04', recurrence: { freq: 'none' }, overrides: {} };
  const { purchases } = splitTransactions(parseOFX(OFX));
  const items = planImport(purchases, c, [manual], '2026-04', cats);
  assert.equal(items[0].status, 'probable');
  assert.equal(items[0].include, false);
});

test('data fora do ciclo é ajustada e anotada', () => {
  const c = card();
  const items = planImport([{ row: 0, date: '2026-03-29', description: 'Uber', amount: 1500, fitid: null, parcel: null }], c, [], '2026-04', cats);
  assert.equal(items[0].date, '2026-03-27');
  const [e] = importEntries(items, c, makeId);
  assert.match(e.notes, /29\/03\/2026/);
  assert.equal(e.importKey, items[0].key);
});
