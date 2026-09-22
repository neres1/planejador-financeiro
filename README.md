# Planejador Financeiro

Organizador financeiro **pessoal** inspirado no Splitwise: em vez de dividir contas com outras pessoas, ele organiza as suas receitas e despesas, com **lançamentos recorrentes como eventos de agenda**, separação entre **despesas fixas e variáveis** e o **dia da cobrança** de cada conta.

É um site estático (HTML + CSS + JavaScript, sem build), feito para rodar no **GitHub Pages** e ser instalado no **iPhone pelo Safari** como um app. Os dados ficam salvos num **repositório privado seu no GitHub**.

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
- **Funciona offline** (service worker); as alterações são enviadas ao GitHub quando a internet voltar.
- **Sincroniza entre aparelhos** (iPhone e computador): cada item guarda a data da última alteração e as versões são mescladas.
- Backup: exportar/importar JSON.
- Modo claro/escuro automático, áreas seguras do iPhone (notch / barra inferior), sem zoom indesejado nos campos.

## Como publicar (uma vez só)

Você vai usar **dois repositórios**:

| Repositório | Visibilidade | Conteúdo |
|---|---|---|
| `planejador-financeiro` | público | o código do app (este projeto), publicado no GitHub Pages |
| `planejador-financeiro-dados` | **privado** | só o arquivo `financas.json` com seus dados |

> O GitHub Pages gratuito exige repositório público, por isso os dados ficam num repositório separado e privado.

### 1. Enviar o app para o GitHub

1. Crie em <https://github.com/new> um repositório **público** chamado `planejador-financeiro`, **sem** README.
2. Nesta pasta, rode (troque `SEU-USUARIO`):

   ```bash
   git remote add origin https://github.com/SEU-USUARIO/planejador-financeiro.git
   git push -u origin main
   ```

3. No repositório: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save**.
4. Em ~1 minuto o app estará em `https://SEU-USUARIO.github.io/planejador-financeiro/`.

### 2. Criar o repositório de dados

1. Crie em <https://github.com/new> um repositório **privado** chamado `planejador-financeiro-dados` (marque "Add a README file").
2. O arquivo `financas.json` é criado automaticamente pelo app na primeira sincronização.

### 3. Criar o token de acesso

1. Acesse **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token** (<https://github.com/settings/personal-access-tokens/new>).
2. **Repository access**: *Only select repositories* → `planejador-financeiro-dados`.
3. **Permissions → Repository permissions → Contents**: *Read and write*.
4. Defina uma validade (ex.: 1 ano), gere e copie o token (`github_pat_…`).

O token dá acesso **somente** ao repositório de dados. Ele fica guardado apenas no aparelho (no armazenamento local do navegador) e nunca é gravado no repositório.

### 4. Conectar o app

Abra o app → ícone de **Ajustes** (canto superior direito) → preencha usuário, `planejador-financeiro-dados`, branch `main`, arquivo `financas.json` e o token → **Salvar e conectar**.

O ícone de nuvem no canto superior esquerdo mostra o estado: ✓ sincronizado, girando = enviando, ! = erro, riscado = offline/não conectado.

### 5. Instalar no iPhone

1. Abra `https://SEU-USUARIO.github.io/planejador-financeiro/` no **Safari**.
2. Toque em **Compartilhar** → **Adicionar à Tela de Início**.
3. Abra pelo ícone e conecte o GitHub em Ajustes **de novo** — no iOS, o app instalado na tela de início tem armazenamento próprio, separado do Safari.

## Como os dados são salvos

- Cada alteração é salva na hora no aparelho e, ~1,5 s depois, enviada ao GitHub como um commit (`Atualiza dados financeiros (iPhone)`), então você tem **histórico completo** de versões no repositório de dados.
- Antes de enviar, o app baixa a versão do GitHub e mescla: para cada lançamento/categoria vence a alteração mais recente; exclusões são propagadas.
- Valores são guardados em centavos (inteiros) para evitar erros de arredondamento.

Formato resumido do `financas.json`:

```json
{
  "schema": 1,
  "categories": [{ "id": "cat-moradia", "name": "Moradia / Aluguel", "emoji": "🏠", "group": "fixo", "color": "#7c6cf2" }],
  "entries": [{
    "id": "…", "type": "despesa", "description": "Aluguel", "amount": 250000,
    "categoryId": "cat-moradia", "date": "2026-10-05",
    "recurrence": { "freq": "monthly", "interval": 1, "byMonthDay": 5, "end": { "type": "count", "count": 12 } },
    "overrides": { "2026-10-05": { "paid": true }, "2026-12-05": { "amount": 270000 } }
  }]
}
```

## Desenvolvimento

Não há dependências. Para rodar localmente (módulos ES não funcionam via `file://`):

```bash
python -m http.server 8080
```

e abra <http://localhost:8080>. Testes do motor de recorrência (Node 18+):

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
js/store.js             dados, persistência local e mesclagem
js/github.js            leitura/gravação no GitHub e sincronização
sw.js                   service worker (offline)
manifest.webmanifest    instalação como app
icons/                  ícones (gerados por tools/make-icons.mjs)
tests/                  testes (node --test)
```

O service worker usa "rede primeiro": com internet o app sempre carrega a versão mais nova publicada; sem internet usa a cópia em cache. Ao adicionar arquivos novos, inclua-os na lista `ASSETS` de `sw.js`.
