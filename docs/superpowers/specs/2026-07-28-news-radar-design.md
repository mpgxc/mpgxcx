# News Radar — design

**Data:** 2026-07-28
**Estado:** design aprovado, pré-implementação
**Base:** reaproveita a espinha arquitetural do `job-radar`

---

## 1. O que é

Um sistema serverless que vigia fontes abertas de notícia, casa o que encontra
contra assuntos nos quais você se inscreveu, e te notifica no Telegram quando
aparece algo novo que dá match.

MVP: ser alertado sobre notícias da cidade de **Oeiras, Piauí**.

## 2. A premissa que orienta o projeto

O `job-radar` nasceu de uma inversão: *vaga séria não se pega raspando HTML —
todo ATS grande já publica uma API JSON pública para as empresas embutirem o
board no próprio site.* A daqui é irmã, e mais forte:

**Notícia não se pega raspando portal. Praticamente todo veículo, blog e
agregador publica RSS/Atom — e o Google News expõe *busca* em RSS**, com query
arbitrária, sem chave e sem quota:

```
https://news.google.com/rss/search?q=<query>&hl=pt-BR&gl=BR&ceid=BR:pt-419
```

Esse endpoint sozinho cobre "Google, blogs indexados no Google, jornais, Google
Notícias, G1, outros jornais maiores" — porque tudo isso **já está indexado
nele**. Sete fontes viram um adapter.

E o trabalho difícil se desloca do mesmo jeito que no job-radar. Buscar é fácil.
O que custa é **não encher o usuário de lixo**:

1. **Desambiguar.** "Oeiras" é ambíguo — existe Oeiras no Piauí, Oeiras em
   Portugal (região metropolitana de Lisboa, com volume de imprensa muito
   maior) e Oeiras do Pará. Uma query crua enche o Telegram de notícia
   portuguesa e o sinal do Piauí some.
2. **Deduplicar entre veículos.** A mesma matéria chega pelo Google News *e*
   pelo RSS do próprio veículo, e a mesma pauta é republicada por vários
   portais. Sem tratamento, são cinco push da mesma notícia.

A arquitetura é desenhada para esses dois problemas.

## 3. Decisões travadas

| decisão | escolha | porquê |
|---|---|---|
| Fontes | Só RSS/JSON aberto | Sem anti-bot, sem proxy, sem parser de DOM. Meta fica fora: a Graph API só devolve páginas que você administra — busca de posts públicos de terceiros foi descontinuada. Raspar viola os ToS e é ativamente bloqueado. |
| Match | Regras determinísticas | Grátis, versionado, testável contra fixtures, reproduzível. LLM entra depois atrás de porta própria, só sobre o delta — mesmo padrão do `inferSeniority`. |
| Escopo | Mono-usuário, N perfis | Um destino, vários assuntos. Cada perfil é uma linha no DynamoDB. Multi-usuário cabe depois sem redesenhar. |
| Canal | Telegram, atrás de porta | Bot via BotFather, um `sendMessage`, push no celular. Trocar para Discord é um adapter de ~30 linhas. |
| Estágio de match | Stream-driven | Preserva o replay; usa Stream e `isContentChange()` que a base já tem. |
| Onde vive | Projeto novo, repo próprio | Domínio sem sobreposição com vagas. A espinha vai copiada (~600 linhas). |

### Alternativas descartadas

- **Match dentro do `normalize`** (menos peças, menor latência) — descartado
  porque **destrói o replay**: reprocessar payload antigo com parser corrigido
  dispararia notificação de notícia de meses atrás. Numa base cuja premissa é
  "guarde o bruto porque o dado some da origem", abrir mão disso custa caro.
- **Varredura agendada por cron + Query no GSI** (mais simples de operar) —
  descartado porque a latência do alerta vira o intervalo do cron e o custo da
  varredura cresce com o catálogo, o oposto do short-circuit que a base persegue.
- **LLM classificando relevância desde o MVP** — custo por item, não
  determinístico, impossível de testar contra fixture.
- **Embeddings / busca semântica** — exige vector store, e para desambiguação
  geográfica resolve *pior* que uma regra explícita: "Oeiras PT" e "Oeiras PI"
  são vetorialmente próximos.

## 4. Arquitetura

```
EventBridge Scheduler  (a cada 15–30 min)
        │
        ▼
   discovery ──── lê AlertProfile[] + SourceConfig[]
        │         expande no conjunto ÚNICO de queries × fontes
        │         (perfis que compartilham query não buscam duas vezes)
        ▼  [fetch queue]
     fetch ────── RSS/JSON com ETag / If-None-Match
        │         payload bruto ──► S3 (claim-check)  ──┐
        │◄─ paginação (quando a fonte tem)              │
        ▼  [normalize queue]  ◄── só o ponteiro ────────┘
   normalize ──── parse PURO ─► Article[] ─► upsert condicional por contentHash
        │
        ▼  [DynamoDB Stream, NEW_AND_OLD_IMAGES]
      match ───── isContentChange() descarta o que não mudou
        │         Article × AlertProfile[] ─► aplica MatchRule
        ▼  [notify queue]
     notify ───── NotificationLog: PutItem condicional (profileId, fingerprint)
        │         já existe? não envia.  não existe? envia e grava.
        ▼
     Telegram
```

Os três primeiros estágios são o `job-radar` com outro domínio dentro. `match` e
`notify` são novos — e o Stream que os alimenta já está previsto no CDK da base
com `NEW_AND_OLD_IMAGES`, com `isContentChange()` escrito exatamente para ser
este filtro.

A direção de dependência é a da base: `handlers → use-cases → domain`, e
`infra-aws → domain` (invertida por DIP). O domínio não importa nada.

### Dois modos de fonte

Existem duas naturezas de fonte, e `discovery` trata cada uma de um jeito:

| modo | exemplo | de onde vem o `selector` |
|---|---|---|
| **query-driven** | Google News RSS | do **perfil** — é o termo de busca |
| **feed-driven** | RSS do G1, portal piauiense | da **`SourceConfig`** — é a URL do feed |

Numa fonte *query-driven*, a query vem do perfil, não da fonte — é o inverso do
job-radar, onde o `selector` vinha sempre da `SourceConfig`. Se dois perfis
pedem "Oeiras Piauí", isso tem que virar **uma** busca, não duas: `discovery`
calcula a **união** das queries de todos os perfis habilitados e cruza com as
fontes query-driven habilitadas.

Numa fonte *feed-driven* não há query: o feed é o que é. `discovery` emite uma
tarefa por feed configurado, tudo que vier é ingerido, e o recorte acontece
depois no `match`.

Nos dois casos o `FetchTask` carrega o **selector efetivo** (a query ou a URL do
feed) e **nunca** o `profileId`. O casamento com perfis acontece só no `match`,
contra todos eles — é isso que mantém o fetch desacoplado dos perfis e evita
busca duplicada.

### Paginação

A porta preserva `RawBatch.next` da base, mas **no MVP nenhuma fonte pagina**:
o Google News devolve ~100 itens sem continuação (§10) e feeds RSS entregam a
janela corrente inteira. A capacidade fica porque o Reddit (fatia 3) usa cursor
`after`, e porque removê-la da porta para reintroduzir depois seria trabalho
puro.

## 5. Layout

```
packages/core/
  commons/                      Result, BusinessError, ErrorType   [copiado da base]
  contexts/news/
    domain/
      entities/article.ts             Article
      entities/alert-profile.ts       AlertProfile
      value-objects/
        match-rule.ts                 required / boost / exclude / minScore
        publisher.ts                  veículo normalizado
      ports/
        news-source.port.ts           discover / fetch / parse
        repositories.port.ts          ArticleRepository, ProfileRegistry,
                                      SourceRegistry, FetchCacheStore,
                                      RawStorage, WorkQueue, NotificationLog
        notifier.port.ts              NotifierPort
      news.errors.ts
      source-catalog.ts
    use-cases/
      discover-source-work.use-case.ts
      fetch-source-batch.use-case.ts
      normalize-and-store.use-case.ts
      match-article.use-case.ts       NOVO
      notify-match.use-case.ts        NOVO
packages/adapters/
  feed/           parser RSS/Atom compartilhado
  google-news/    client + ACL
  rss/            client + ACL (feed direto: G1, portais locais)
  reddit/         client + ACL (fatia 3)
  http/           HttpClient, CircuitBreaker   [copiado]
packages/infra-aws/
  dynamo/ s3/ sqs/ logger        [copiado, chaves adaptadas]
  telegram/                      TelegramNotifier
apps/ingestion/   handlers Lambda + composition root + ports em memória
infra/            stack CDK
fixtures/         payloads reais gravados, por fonte
```

## 6. Modelo de domínio

### `Article` — três identificadores

Mesma divisão de trabalho da base, com um deles ganhando peso muito maior:

| | o que é | para quê |
|---|---|---|
| `id` | `sha256(fonte + idExterno)` | idempotência de ingestão: reprocessar nunca duplica |
| `contentHash` | `sha256(título + resumo + publishedAt)` | a matéria foi **atualizada** |
| `fingerprint` | título normalizado (sem veículo) | **mesma notícia em veículos diferentes → um push só** |

O `fingerprint` aqui é mais crítico do que no job-radar. Lá ele agrupava na
leitura. Aqui ele é o que impede o flood: a normalização é agressiva
(minúsculas, sem acento, sem pontuação, stopwords removidas, espaços
colapsados) e **deliberadamente deixa de fora o veículo** — o objetivo é
justamente casar entre veículos.

### `AlertProfile` — o assunto inscrito

Criar assunto novo é um `PutItem`, **nunca** um deploy — mesma promessa do
registro de fontes da base:

```json
{
  "pk": "PROFILES", "sk": "oeiras-pi",
  "name": "Oeiras · Piauí",
  "queries": ["Oeiras Piauí", "Oeiras PI", "prefeitura de Oeiras Piauí"],
  "rule": {
    "required": ["oeiras"],
    "boost":    ["piauí", "pi", "picos", "teresina", "sertão"],
    "exclude":  ["lisboa", "portugal", "carcavelos", "paço de arcos", "algés"],
    "minScore": 1
  },
  "destinations": [{ "kind": "telegram", "chatId": "..." }],
  "enabled": true
}
```

### `MatchRule` — a regra

Função **pura** sobre `(Article, MatchRule) -> MatchVerdict`. Sem I/O, sem
relógio, sem aleatoriedade — pelo mesmo motivo que `parse` é puro: é o que
permite testá-la contra manchetes reais gravadas.

Avaliação sobre título + resumo, normalizados:

1. Se qualquer termo de `exclude` casa → **não é match**, encerra.
2. Se algum termo de `required` não casa → **não é match**, encerra.
3. `score` = número de termos de `boost` que casaram.
4. É match se `score >= minScore`.

`exclude` tem precedência sobre tudo: é ele que mata o falso positivo
português. `boost` é o que confirma o verdadeiro. Como a regra é **dado, não
código**, calibrar a precisão do alerta não passa por deploy — o que importa
muito nas primeiras semanas, quando você vai ajustar isso várias vezes.

## 7. Modelo de dados (single-table)

```
ARTICLE#<articleId>                 / ARTICLE     — a notícia
PROFILES                            / <profileId> — perfis de alerta (Query única)
SOURCES                             / <sourceId>#<selector> — registro de fontes
CACHE#<src>#<selector>#<page>       / CACHE       — ETag/Last-Modified, TTL
NOTIF#<profileId>#<fingerprint>     / NOTIF       — log de envio
```

Em fonte *feed-driven* o `selector` da `SourceConfig` é a URL do feed. Em fonte
*query-driven* ele nasce vazio na config, e o **selector efetivo** — o que entra
na chave de `CACHE` — é a query vinda do perfil (§4).

Todas as chaves nascem num `single-table.ts` só — nenhum outro arquivo
concatena chave, para que mudar o layout seja uma edição só.

### Sem GSI no MVP

Não é economia, é consequência do domínio. O `gsi1` do job-radar existe **só**
para o sweeper de expiração, e **notícia não expira: envelhece.** Nenhuma fonte
"some com a matéria" do jeito que um ATS some com a vaga.

Somem juntos: o sweeper, o índice que só ele usava, e a regra mais perigosa da
base — a de que chamar `expireNotSeenIn` depois de uma rodada parcial destrói o
catálogo inteiro. A limpeza vira TTL.

### TTLs

- `ARTICLE`: 180 dias.
- `NOTIF`: 1 ano — **deliberadamente maior que o do artigo**. Se fossem iguais,
  uma matéria reindexada perto do vencimento do log poderia notificar de novo.
  Os registros são minúsculos; o ano extra é irrelevante em custo.
- `CACHE`: 7 dias.

### O log de notificação é a peça que decide se o produto presta

`NOTIF#<profileId>#<fingerprint>` com escrita condicional
`attribute_not_exists(pk)`. A garantia vem do banco, não de um `if` no código, e
cobre três casos de uma vez:

- **sindicação** — a mesma pauta republicada por vários veículos tem `id`
  diferente e `fingerprint` igual → um push só;
- **replay** — reprocessar meses de S3 com um parser corrigido não re-notifica;
- **retry** — o SQS reentregando a mensagem depois de falha parcial no envio não
  duplica.

Note que a chave é `(profileId, fingerprint)` e **não** `(profileId, articleId)`.
Deduplicar por `articleId` é a falha clássica desse tipo de produto.

## 8. Tratamento de erro

Falhas de negócio esperadas são **valores**, não exceções: use-cases e adapters
devolvem `Result<T, BusinessError>`. `throw` fica para o genuinamente
excepcional.

| erro | `retryable` | por quê |
|---|---|---|
| `SOURCE_UNAVAILABLE` | sim | feed fora do ar, 5xx, 429, timeout |
| `SOURCE_CONTRACT_DRIFT` | **não** | XML inválido ou campo sumiu — retentar traz o mesmo payload; o que resolve é corrigir o parser. O log estruturado é o gancho do alarme. |
| `NOTIFICATION_FAILED` | sim | Telegram 5xx ou rede |
| `INVALID_PROFILE_CONFIG` | não | regra malformada no registro |

O `processBatch` com `ReportBatchItemFailures` é copiado sem alteração e passa a
servir também `match` e `notify` — a decisão de retentar continua vindo do erro,
não do handler.

Uma fonte que falha no `discover` é registrada em `skipped` e a rodada continua:
o Google News fora do ar não pode impedir o RSS do G1 de ser coletado.

**Telegram:** o 429 vem com `parameters.retry_after`. Com um usuário e poucos
alertas isso nunca encosta no limite, mas respeitar o campo é o comportamento
correto e custa um `if`.

**Circuit breaker por fonte**, nunca global — um breaker compartilhado faria a
queda do Google News cortar o RSS do G1, que está saudável.

## 9. Estratégia de teste

1. **`parse` puro contra fixtures gravadas** de cada feed — igual ao Gupy.
   Parser drift é o modo de falha número um de um agregador.

2. **Regra de match, table-driven.** É o teste que decide se o produto presta.
   As manchetes saem de fixture real do Google News, não inventadas:

   | manchete | esperado | porquê |
   |---|---|---|
   | `Prefeitura de Oeiras (PI) anuncia...` | ✅ match | `required` + `boost` |
   | `Câmara Municipal de Oeiras aprova orçamento` | ❌ | Portugal, sem reforço |
   | `Obras na marginal de Paço de Arcos, Oeiras` | ❌ | `exclude` |

3. **Dedupe:** dois `Article` com `id` diferente e `fingerprint` igual produzem
   **uma** notificação.

4. **`pnpm pipeline:local "Oeiras Piauí"`** — pipeline inteiro contra o Google
   News real, ports em memória, notifier que imprime no stdout. Critério de
   saúde, equivalente ao do job-radar apontado para o que importa aqui:
   **a segunda rodada tem que produzir zero notificações novas.** Se produzir,
   ou o `fingerprint` está instável, ou o log condicional não está segurando.

   Que esse comando seja possível é, por si só, o teste da arquitetura — o
   pipeline não sabe que a AWS existe.

## 10. Armadilhas a validar ao vivo

Precisam de validação contra a fonte real **antes** de virarem código, e depois
viram fixture e teste — o mesmo tratamento que o `pagination.total` do Gupy
recebeu:

- **O `<link>` do item do Google News é um redirect** (`news.google.com/rss/
  articles/CBMi...`), não a URL do veículo. Afeta o dedupe por URL e o link que
  chega até você na mensagem. Precisa decidir se resolve o redirect (custa uma
  requisição por item) ou se notifica com o link do Google.
- **O feed devolve ~100 itens sem paginação.** Não há backfill, e a cobertura
  passa a depender da frequência de polling — o que define o intervalo do cron.
- **O `<title>` costuma vir com sufixo ` - Veículo`.** Entra no `fingerprint` se
  não for removido, e aí a mesma matéria em dois veículos gera fingerprints
  diferentes — quebrando exatamente o dedupe que ele existe para fazer.
- **`pubDate` nem sempre é a data real de publicação** em feeds agregados.

## 11. Custo

Tudo escala a zero: Lambda ARM 512 MB, DynamoDB on-demand, S3 com lifecycle
(IA aos 30 dias, expira em 365). A cada 30 minutos são ~3–10 requisições. Ordem
de grandeza: **centavos a poucos dólares por mês.** Sem OpenSearch, sem NAT,
sem nada cobrando parado.

## 12. Fora de escopo no MVP (YAGNI explícito)

- OpenSearch / busca full-text — o match é por regra sobre o delta, e não existe
  API de busca. Remove a peça mais cara da arquitetura original.
- GSI e sweeper de expiração — ver §7.
- Multi-usuário, autenticação, cadastro, API pública.
- Digest / agregação de mensagens (fatia 3).
- Qualquer LLM (fatia 5).
- Meta / Facebook / Instagram (fatia 6).

## 13. Roadmap em fatias

1. **MVP — fatia vertical:** Google News RSS + perfil Oeiras/PI + match
   determinístico + Telegram, ponta a ponta, com fixtures e testes.
2. Feeds diretos (G1, portais piauienses) sobre o parser RSS/Atom que a fatia 1
   já deixa pronto.
3. Reddit JSON + **digest** (uma mensagem com N notícias em vez de push por item).
4. Perfis novos e calibragem das regras — só `PutItem`.
5. Enricher LLM atrás de porta própria, rodando só sobre o delta: resumo da
   notícia na mensagem e/ou relevância fina.
6. Meta atrás de feature flag, **desligada por padrão**. Raspar Facebook e
   Instagram viola os ToS da Meta e é ativamente bloqueado; ligar é decisão
   explícita de quem opera, e as outras fontes cobrem a maior parte do volume
   sem esse risco.
