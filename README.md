# Planejador Financeiro

Organizador financeiro **pessoal** inspirado no Splitwise: em vez de dividir contas com outras pessoas, ele organiza as suas receitas e despesas, com **lançamentos recorrentes como eventos de agenda**, separação entre **despesas fixas e variáveis** e o **dia da cobrança** de cada conta.

É um site estático (HTML + CSS + JavaScript, sem build), hospedado no **GitHub Pages** e instalável no **iPhone pelo Safari** como um app. Os dados ficam no **Supabase**, com login próprio e **criptografia de ponta a ponta**.

## Funcionalidades

- **Resumo do mês**: saldo previsto e realizado, receitas × despesas, fixas × variáveis, % da renda comprometida com fixas, gastos por categoria, contas a pagar e atrasadas.
- **Lançamentos**: lista por dia, busca e filtros (despesas, receitas, fixas, variáveis, pendentes, recorrentes). Toque no círculo para marcar como **pago/recebido**.
- **Recorrência estilo agenda**:
  - todo dia, toda semana (escolhendo os dias), todo mês ou todo ano, com intervalo ("a cada 2 meses");
  - **dia da cobrança** no mês (1–31 ou "último dia do mês"; dia 31 cai no último dia dos meses curtos);
  - termina **nunca**, **após N vezes** (parcelas, mostradas como "3/10") ou **numa data**;
  - ao editar ou excluir uma ocorrência: **somente esta**, **esta e as próximas** ou **todas**.
- **Agenda**: calendário do mês com marcadores de receitas, despesas e contas atrasadas.
- **Recorrentes**: todas as contas fixas, assinaturas, salário e parcelas, com a próxima data e o compromisso mensal estimado.
- **Categorias** editáveis, agrupadas em *Despesas fixas*, *Despesas variáveis* e *Receitas*.
- **Funciona offline** (service worker); as alterações são enviadas quando a internet voltar.
- **Sincroniza entre aparelhos** (iPhone e computador): cada item guarda a data da última alteração e as versões são mescladas.
- Backup: exportar/importar JSON.
- Modo claro/escuro automático, áreas seguras do iPhone (notch / barra inferior), sem zoom indesejado nos campos.

## Contas, dados e privacidade

- **Login por e-mail e senha**, que fica salvo no aparelho até você tocar em **Sair**. Cada conta tem os próprios dados.
- **Cadastro fechado**: contas são criadas só por convite, no painel do Supabase.
- **Criptografia de ponta a ponta**: lançamentos e categorias são cifrados no aparelho (AES-256-GCM) antes de ir ao servidor; a chave de dados é protegida pela senha (PBKDF2, 310 mil iterações) e por uma **chave de recuperação**. O servidor só guarda texto ilegível — nem quem administra o banco consegue ler.
- **Esqueci a senha**: link por e-mail + chave de recuperação. Sem a chave, os dados antigos não podem ser recuperados (é o preço da criptografia de ponta a ponta).
- A cópia local (para funcionar offline) também é criptografada; a chave fica no IndexedDB do aparelho, marcada como não exportável.

### Infraestrutura

| Peça | Onde |
|---|---|
| Site (código) | GitHub Pages — `neres1/planejador-financeiro` (público, só código) |
| Banco + login | Supabase, projeto `planejador-financeiro`, região São Paulo (`sa-east-1`) |
| Esquema do banco | [`supabase/schema.sql`](supabase/schema.sql) — tabelas `vault` e `items`, RLS por usuário, função `push_items` |

A URL do projeto e a chave *publishable* ficam em [`js/supa.js`](js/supa.js). Elas são públicas por design: sem login não dão acesso a nada (RLS + cadastro desligado). A chave *secret* nunca vai para o app.

### Convidar alguém (ou você mesmo)

Supabase → projeto → **Authentication → Users → Add user → Send invitation** com o e-mail. A pessoa recebe o link (em inglês, "You have been invited"), abre, cria a senha no app e guarda a chave de recuperação.

### Instalar no iPhone

1. Abra `https://neres1.github.io/planejador-financeiro/` no **Safari**.
2. **Compartilhar** → **Adicionar à Tela de Início**.
3. Abra pelo ícone e entre com e-mail e senha (o app instalado tem armazenamento próprio, separado do Safari).

> Observação: no plano gratuito, o Supabase pausa o projeto após ~7 dias sem nenhum acesso. Nada é perdido; basta reativar no painel.

## Desenvolvimento

Não há dependências. Para rodar localmente (módulos ES não funcionam via `file://`):

```bash
python -m http.server 8080
```

e abra <http://localhost:8080>. Testes (recorrência e sincronização criptografada contra um Supabase simulado; Node 20+):

```bash
npm test
```

Estrutura:

```
index.html              página única
css/app.css             estilos (iPhone, modo escuro, safe areas)
js/app.js               interface: telas, formulários, folhas modais
js/recurrence.js        motor de recorrência (puro, testado)
js/series.js            editar/excluir "somente esta / próximas / todas"
js/store.js             dados, cópia local criptografada e mesclagem
js/crypto.js            criptografia de ponta a ponta (WebCrypto)
js/supa.js              login e acesso ao Supabase (fetch, sem dependências)
js/cloud.js             sincronização criptografada
js/keystore.js          chave de dados guardada no IndexedDB
supabase/schema.sql     tabelas e regras de acesso do banco
sw.js                   service worker (offline)
manifest.webmanifest    instalação como app
icons/                  ícones (gerados por tools/make-icons.mjs)
tests/                  testes (node --test)
```

O service worker usa "rede primeiro": com internet o app sempre carrega a versão mais nova publicada; sem internet usa a cópia em cache. Ao adicionar arquivos novos, inclua-os na lista `ASSETS` de `sw.js`.
