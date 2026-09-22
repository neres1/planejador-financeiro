# Gera js/emoji.js a partir da lista oficial do Unicode, agrupando como o teclado do iPhone.
# Uso: baixe https://unicode.org/Public/emoji/latest/emoji-test.txt e rode
#   python tools/make-emoji.py caminho/para/emoji-test.txt
import json, re, sys

MAX_VERSION = 15.0  # emojis mais novos podem não aparecer em iPhones desatualizados
ORDER = [
    ('smileys', 'Carinhas e pessoas', ['Smileys & Emotion', 'People & Body'], '😀'),
    ('animais', 'Animais e natureza', ['Animals & Nature'], '🐻'),
    ('comida', 'Comidas e bebidas', ['Food & Drink'], '🍔'),
    ('atividades', 'Atividades', ['Activities'], '⚽'),
    ('viagens', 'Viagens e lugares', ['Travel & Places'], '🚗'),
    ('objetos', 'Objetos', ['Objects'], '💡'),
    ('simbolos', 'Símbolos', ['Symbols'], '🔣'),
    ('bandeiras', 'Bandeiras', ['Flags'], '🏳️'),
]

groups, g = {}, None
for line in open(sys.argv[1], encoding='utf-8'):
    if line.startswith('# group:'):
        g = line.split(':', 1)[1].strip()
        groups.setdefault(g, [])
        continue
    m = re.match(r'^([0-9A-F ]+?)\s*;\s*fully-qualified\s*#\s*\S+\s+E(\d+\.\d+)', line)
    if not m or g is None or float(m.group(2)) > MAX_VERSION:
        continue
    cps = [int(x, 16) for x in m.group(1).split()]
    if any(0x1F3FB <= c <= 0x1F3FF for c in cps):  # variações de tom de pele
        continue
    groups[g].append(''.join(chr(c) for c in cps))

rows = [
    '  { key: %s, label: %s, icon: %s, emojis: %s }' % (
        json.dumps(k), json.dumps(label, ensure_ascii=False), json.dumps(icon, ensure_ascii=False),
        json.dumps(' '.join(e for src in srcs for e in groups[src]), ensure_ascii=False))
    for k, label, srcs, icon in ORDER
]
js = ('// Emojis agrupados como no teclado do iPhone (fonte: Unicode emoji-test.txt, até a versão 15.0,\n'
      '// sem variações de tom de pele). Gerado por tools/make-emoji.py.\n'
      'export const EMOJI_GROUPS = [\n' + ',\n'.join(rows) + ',\n].map((g) => ({ ...g, emojis: g.emojis.split(\' \') }));\n')
open('js/emoji.js', 'w', encoding='utf-8').write(js)
