# News Radar — Fatia 1 (Plano A: núcleo local) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rodando `pnpm pipeline:local "Oeiras Piauí"` no laptop, sem nenhum recurso da AWS, chega uma mensagem real no Telegram com uma notícia de Oeiras/PI — e a segunda rodada não manda nada.

**Architecture:** Ports & adapters copiados da espinha do `job-radar`. `discovery → fetch → normalize` ingerem; `match` e `notify` são os estágios novos. O domínio (`packages/core`) não importa nada — nem AWS, nem HTTP, nem XML. `parse` e `evaluateMatch` são funções puras, testadas contra fixtures reais gravadas do Google News.

**Tech Stack:** Node >= 22, pnpm, TypeScript ESM (`NodeNext`), Vitest, Biome, `fast-xml-parser`. Nenhuma dependência de AWS nesta fatia.

**Repositório:** projeto novo em `/Users/mpgxc/Developer/news-radar`. O spec de referência é `/Users/mpgxc/mpgxcx/docs/superpowers/specs/2026-07-28-news-radar-design.md`.

**Escopo desta fatia (Plano A):** tudo local. Lambda, DynamoDB, S3, SQS, Stream e CDK ficam para o Plano B.

## Global Constraints

- Node >= 22, pnpm como gerenciador. `"type": "module"` em todo pacote.
- TypeScript `module: NodeNext`, `verbatimModuleSyntax`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. **Imports relativos carregam `.js` mesmo apontando para `.ts`.** `import type` para tipos.
- `exactOptionalPropertyTypes` proíbe `{ chave: undefined }`. Use spread condicional: `...(valor ? { chave: valor } : {})`.
- Pacotes exportam **fonte TypeScript direta** (`"exports": "./src/index.ts"`). Não há build entre pacotes do workspace.
- Ports são `abstract class`, nunca `interface` — são valores em runtime no composition root, e adapters usam `extends`.
- `packages/core` tem **zero dependências**. XML, HTTP e Telegram vivem em `packages/adapters`.
- Falhas de negócio esperadas são **valores**: `Result<T, BusinessError>`. `throw` só para o excepcional.
- Biome: 2 espaços, 100 colunas, `noConsole` é **erro** (escreva em `process.stdout.write`).
- **Comentários, mensagens de log e mensagens de erro em pt-BR.** Identificadores e tipos em inglês.
- Testes são `*.spec.ts` colocados ao lado do código. Teste de parser lê de `fixtures/` — **nunca** da rede.
- Nomes de pacote: `@news-radar/core`, `@news-radar/adapters`, `@news-radar/ingestion`.

---

## Emendas pós-validação (Task 2 executada em 2026-07-29)

O spike da Task 2 mediu a fonte real e **derrubou três suposições** deste plano.
As tasks seguintes valem com estas emendas; a evidência está em
`docs/validacao-google-news.md` no repo do projeto.

1. **`stripPublisherSuffix` ganha o veículo.** Em 200/200 itens o sufixo do
   `<title>` é *exatamente* o texto de `<source>`. Assinatura passa a
   `stripPublisherSuffix(title: string, publisher?: string): string` — corta
   `" - " + publisher` exato quando conhecido, e cai no último `" - "` como
   fallback (fonte feed-driven não tem `<source>`). Consequentemente
   `normalizeHeadline(title, publisher?)` e
   `Article.buildFingerprint(props)` — não mais `buildFingerprint(title)`.

2. **O haystack de match inclui o veículo, de propósito.** `evaluateMatch` monta
   `título + resumo + veículo`. Achado com um caso real na fixture
   (`Olhares de Lisboa` dispara `exclude: ["lisboa"]`, corretamente), e o
   inverso vale para veículos piauienses no `boost`.

3. **O mapper do Google News mapeia `summary = ""`.** Medido: 0 de 200
   `<description>` trazem qualquer coisa além do título mais o veículo. Copiar
   aquilo duplicaria o título dentro do `contentHash`. O parser genérico
   continua extraindo `description` — quem descarta é o ACL, que é onde
   peculiaridade de fonte deve morar.

4. **A regra do perfil `oeiras-pi` foi recalibrada contra manchete real.** A do
   spec §6 rejeitava 31 de 62 notícias legítimas de Oeiras/PI. A versão
   calibrada (55 de 62, ~89% de recall) está na §5.3 do doc de validação e é a
   que a Task 10b deve usar.

5. **A fonte não manda `ETag` nem `Last-Modified`** (`cache-control: no-store`).
   O ramo `not-modified` do `fetch` é código morto para o Google News e caminho
   quente para a fatia 2. Mantido.

---

## Estrutura de arquivos

```
news-radar/
  package.json  pnpm-workspace.yaml  tsconfig.base.json  tsconfig.json
  biome.json    vitest.config.ts     .gitignore          .env.example
  fixtures/google-news/                       payloads reais gravados
  docs/validacao-google-news.md               resultado do spike (Task 2)
  packages/core/src/
    commons/                                  Result, BusinessError, ErrorType
    contexts/news/
      domain/
        value-objects/text.ts                 normalizeForMatch, normalizeHeadline
        value-objects/match-rule.ts           MatchRule, evaluateMatch
        entities/article.ts                   Article (3 identificadores)
        entities/alert-profile.ts             AlertProfile, AlertDestination
        ports/news-source.port.ts             NewsSourcePort + tipos de tarefa
        ports/repositories.port.ts            7 ports de persistência
        ports/notifier.port.ts                NotifierPort
        news.errors.ts                        erros de negócio do contexto
        source-catalog.ts                     sourceId -> adapter
      use-cases/                              5 use-cases
  packages/adapters/src/
    http/                                     HttpClient, CircuitBreaker  [copiado]
    feed/feed.parser.ts                       RSS 2.0 -> FeedItem[]
    google-news/                              client + mapper + adapter
    telegram/telegram.notifier.ts             NotifierPort concreto
  apps/ingestion/src/local/
    in-memory-ports.ts                        ports em memória
    run-pipeline.ts                           o runner `pipeline:local`
```

**Desvio consciente do spec §5:** o `TelegramNotifier` fica em `packages/adapters/telegram/`, não em `packages/infra-aws/`. Telegram não é AWS, e criar um pacote inteiro nesta fatia só para ele não se paga. `packages/infra-aws` nasce no Plano B.

---

### Task 1: Scaffold do monorepo + commons

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `.gitignore`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`
- Create: `packages/core/src/commons/{result.ts,business-error.ts,index.ts}`
- Test: `packages/core/src/commons/business-error.spec.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `Result<T, E>` com `Result.ok(v)` / `Result.err(e)`, métodos `isOk()`, `isErr()`, `unwrapOrThrow()`; classes `Ok<T,E>` (campo `.value`) e `Err<T,E>` (campo `.error`). `abstract class BusinessError extends Error` com `abstract readonly type: ErrorType`, `abstract readonly code: string`, `readonly timestamp: string`, `readonly details: unknown`, getter `retryable`, `toJSON()`. `enum ErrorType { VALIDATION, NOT_FOUND, CONFLICT, SOURCE_UNAVAILABLE, SOURCE_CONTRACT_DRIFT, NOTIFICATION_FAILED, UNEXPECTED }`.

- [ ] **Step 1: Criar o diretório do projeto e inicializar o git**

```bash
mkdir -p /Users/mpgxc/Developer/news-radar
cd /Users/mpgxc/Developer/news-radar
git init
```

- [ ] **Step 2: Escrever os arquivos de configuração da raiz**

`package.json`:

```json
{
  "name": "news-radar",
  "version": "0.1.0",
  "private": true,
  "description": "Alertas de notícia serverless: vigia fontes abertas e notifica no Telegram",
  "packageManager": "pnpm@10.33.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc --build",
    "clean": "tsc --build --clean",
    "typecheck": "tsc --build --force",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "pipeline:local": "tsx apps/ingestion/src/local/run-pipeline.ts"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.5",
    "@types/node": "^22.19.1",
    "tsx": "^4.20.6",
    "typescript": "^5.9.3",
    "vitest": "^3.2.4"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`tsconfig.base.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "types": ["node"],

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,

    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`tsconfig.json` (raiz, só referências):

```json
{
  "files": [],
  "references": [{ "path": "./packages/core" }]
}
```

`biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.5/schema.json",
  "files": {
    "includes": ["**/*.ts", "**/*.json", "!**/dist", "!**/cdk.out", "!**/fixtures"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "preset": "recommended",
      "style": { "useNamingConvention": "off" },
      "suspicious": { "noConsole": "error" }
    }
  },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.spec.ts", "apps/**/*.spec.ts"],
    environment: "node",
  },
});
```

`.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
.env
.DS_Store
```

- [ ] **Step 3: Escrever o teste que falha**

`packages/core/src/commons/business-error.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BusinessError, ErrorType } from "./business-error.js";
import { Result } from "./result.js";

class FonteForaDoAr extends BusinessError {
  readonly type = ErrorType.SOURCE_UNAVAILABLE;
  readonly code = "SOURCE_UNAVAILABLE";
  static create(message: string) {
    return new FonteForaDoAr(message);
  }
}

class ContratoQuebrado extends BusinessError {
  readonly type = ErrorType.SOURCE_CONTRACT_DRIFT;
  readonly code = "SOURCE_CONTRACT_DRIFT";
  static create(message: string) {
    return new ContratoQuebrado(message);
  }
}

describe("BusinessError", () => {
  it("deriva retryable do tipo semântico, não de status HTTP", () => {
    expect(FonteForaDoAr.create("timeout").retryable).toBe(true);
    expect(ContratoQuebrado.create("campo sumiu").retryable).toBe(false);
  });

  it("preserva a cadeia de protótipo para instanceof funcionar", () => {
    const error = FonteForaDoAr.create("timeout");
    expect(error).toBeInstanceOf(FonteForaDoAr);
    expect(error).toBeInstanceOf(BusinessError);
    expect(error).toBeInstanceOf(Error);
  });

  it("serializa com código, tipo e timestamp", () => {
    const json = ContratoQuebrado.create("campo sumiu").toJSON();
    expect(json.code).toBe("SOURCE_CONTRACT_DRIFT");
    expect(json.type).toBe(ErrorType.SOURCE_CONTRACT_DRIFT);
    expect(json.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("Result", () => {
  it("Ok carrega o valor e não é Err", () => {
    const result = Result.ok<number>(42);
    expect(result.isOk()).toBe(true);
    expect(result.isErr()).toBe(false);
    if (result.isOk()) expect(result.value).toBe(42);
  });

  it("Err carrega o erro e explode em unwrapOrThrow", () => {
    const result = Result.err(FonteForaDoAr.create("timeout"));
    expect(result.isErr()).toBe(true);
    expect(() => result.unwrapOrThrow()).toThrow(FonteForaDoAr);
  });
});
```

- [ ] **Step 4: Rodar o teste e confirmar que falha**

```bash
pnpm install
pnpm vitest run packages/core/src/commons/business-error.spec.ts
```

Esperado: FAIL — `Failed to resolve import "./business-error.js"`.

- [ ] **Step 5: Escrever o pacote core e os commons**

`packages/core/package.json`:

```json
{
  "name": "@news-radar/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./commons": "./src/commons/index.ts",
    "./news": "./src/contexts/news/index.ts"
  }
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*.ts"]
}
```

`packages/core/src/commons/result.ts` — copiar **na íntegra** de
`/Users/mpgxc/mpgxcx/packages/core/src/commons/result.ts`, sem alteração.

`packages/core/src/commons/business-error.ts` — copiar de
`/Users/mpgxc/mpgxcx/packages/core/src/commons/business-error.ts` e acrescentar
dois membros ao enum `ErrorType`, logo antes de `UNEXPECTED`:

```ts
  /** O canal de notificação falhou (Telegram 5xx, rede). Vale retentar. */
  NOTIFICATION_FAILED = "NOTIFICATION_FAILED",
  /** Regra de alerta malformada no registro de perfis. Não adianta retentar. */
  INVALID_PROFILE_CONFIG = "INVALID_PROFILE_CONFIG",
```

E ampliar o getter `retryable`, porque agora dois tipos são retentáveis:

```ts
  /** Se vale a pena retentar. O pipeline usa isso para decidir DLQ vs backoff. */
  get retryable(): boolean {
    return (
      this.type === ErrorType.SOURCE_UNAVAILABLE || this.type === ErrorType.NOTIFICATION_FAILED
    );
  }
```

`packages/core/src/commons/index.ts`:

```ts
export { BusinessError, ErrorType } from "./business-error.js";
export { Err, Ok, Result } from "./result.js";
```

`packages/core/src/index.ts`:

```ts
export * from "./commons/index.js";
```

- [ ] **Step 6: Rodar o teste e confirmar que passa**

```bash
pnpm vitest run packages/core/src/commons/business-error.spec.ts
pnpm typecheck
pnpm lint
```

Esperado: 5 testes PASS, typecheck limpo, lint limpo.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold do monorepo e commons (Result, BusinessError)"
```

---

### Task 2: Spike de validação ao vivo do Google News

Antes de escrever uma linha de parser: bater na fonte real e responder as quatro
armadilhas do spec §10. Este task **não produz código de produção** — produz
fixtures e fatos. É o mesmo tratamento que o `pagination.total` do Gupy recebeu
no job-radar: a suposição errada custa caro depois.

**Files:**
- Create: `fixtures/google-news/oeiras-piaui.xml`
- Create: `fixtures/google-news/oeiras-cru.xml`
- Create: `fixtures/google-news/vazio.xml`
- Create: `docs/validacao-google-news.md`

**Interfaces:**
- Consumes: nada.
- Produces: as três fixtures que os testes das Tasks 3, 5 e 7 leem, e os fatos que
  decidem o mapper.

- [ ] **Step 1: Gravar a busca desambiguada**

```bash
mkdir -p fixtures/google-news
curl -sS --compressed \
  -H 'user-agent: news-radar/0.1 (validacao local)' \
  'https://news.google.com/rss/search?q=Oeiras%20Piau%C3%AD&hl=pt-BR&gl=BR&ceid=BR:pt-419' \
  -o fixtures/google-news/oeiras-piaui.xml
```

- [ ] **Step 2: Gravar a busca crua (a que traz Portugal junto)**

Esta fixture é a que prova que a regra de `exclude` presta — ela **precisa**
conter manchete portuguesa.

```bash
curl -sS --compressed \
  -H 'user-agent: news-radar/0.1 (validacao local)' \
  'https://news.google.com/rss/search?q=Oeiras&hl=pt-BR&gl=BR&ceid=BR:pt-419' \
  -o fixtures/google-news/oeiras-cru.xml
```

- [ ] **Step 3: Gravar uma busca sem resultado**

```bash
curl -sS --compressed \
  -H 'user-agent: news-radar/0.1 (validacao local)' \
  'https://news.google.com/rss/search?q=zzqqxx-termo-que-nao-existe-999&hl=pt-BR&gl=BR&ceid=BR:pt-419' \
  -o fixtures/google-news/vazio.xml
```

- [ ] **Step 4: Inspecionar e medir**

```bash
for f in fixtures/google-news/*.xml; do
  echo "== $f  ($(wc -c < "$f") bytes, $(grep -c '<item>' "$f") itens)"
done

# Um item inteiro, para ver a forma exata dos campos:
sed -n '/<item>/,/<\/item>/p' fixtures/google-news/oeiras-piaui.xml | head -20
```

- [ ] **Step 5: Responder as quatro armadilhas em `docs/validacao-google-news.md`**

Escreva o arquivo respondendo cada pergunta **com evidência copiada da fixture**,
não com suposição. Formato:

```markdown
# Validação ao vivo — Google News RSS

**Data:** <data de hoje>
**Endpoint:** `https://news.google.com/rss/search?q=<query>&hl=pt-BR&gl=BR&ceid=BR:pt-419`
**Fixtures:** `fixtures/google-news/{oeiras-piaui,oeiras-cru,vazio}.xml`

## 1. O `<link>` é redirect do Google?

- Valor observado: `<colar o link real de um item>`
- Decisão: **notificar com o link do Google, sem resolver o redirect.**
  Resolver custaria uma requisição HTTP por item, e o link do Google abre no
  veículo do mesmo jeito. Revisitar se o dedupe por URL virar necessário.

## 2. Quantos itens vêm, e há paginação?

- Itens em `oeiras-piaui.xml`: `<N>`
- Itens em `oeiras-cru.xml`: `<N>`
- Existe `<atom:link rel="next">` ou cursor no canal? `<sim/não + evidência>`
- Consequência: `RawBatch.next` é sempre `null` nesta fonte; a cobertura
  depende da frequência do cron.

## 3. O `<title>` tem sufixo ` - Veículo`?

- Exemplo cru: `<colar 3 títulos>`
- O sufixo casa com o texto de `<source>`? `<sim/não>`
- Consequência para `stripPublisherSuffix` (Task 3): `<regra confirmada>`

## 4. `pubDate` é confiável?

- Formato observado: `<colar um pubDate>`
- Todos os itens têm `pubDate`? `<sim/não>`
- Consequência: `publishedAt` é `Date | null`, e entra no `contentHash` como
  string ISO (ou `""` quando ausente).

## 5. Achados extras

- `<guid>`: `<forma e se é estável>`
- `<description>`: `<contém HTML? qual?>`
- `<source url="...">`: `<forma>`
- Resposta de busca vazia: `<HTTP 200 com canal sem item? confirmar>`
- Cabeçalhos de cache (`etag` / `last-modified`): `<presentes?>`
```

Rode isto para responder o item de cabeçalhos:

```bash
curl -sSI --compressed \
  'https://news.google.com/rss/search?q=Oeiras%20Piau%C3%AD&hl=pt-BR&gl=BR&ceid=BR:pt-419' \
  | grep -iE '^(etag|last-modified|cache-control|content-type)'
```

- [ ] **Step 6: Commit**

```bash
git add fixtures docs
git commit -m "test: grava fixtures reais do Google News e documenta a validação ao vivo"
```

---

### Task 3: Normalizadores de texto (puros, no domínio)

Dois normalizadores **distintos**, e confundi-los é bug. `normalizeForMatch`
serve à regra de alerta e **não pode** remover stopwords, porque termos de
`exclude` legítimos as contêm — `"paço de arcos"` vira `"paco arcos"` e deixa de
casar. `normalizeHeadline` serve só ao `fingerprint`, e aí a agressividade é
desejada: é ela que faz a mesma matéria em dois veículos colidir.

**Files:**
- Create: `packages/core/src/contexts/news/domain/value-objects/text.ts`
- Test: `packages/core/src/contexts/news/domain/value-objects/text.spec.ts`

**Interfaces:**
- Consumes: nada (função pura, zero import).
- Produces:
  - `normalizeForMatch(value: string): string`
  - `stripPublisherSuffix(title: string): string`
  - `normalizeHeadline(title: string): string`
  - `containsTerm(haystack: string, term: string): boolean` — `haystack` já
    normalizado por `normalizeForMatch`; `term` é normalizado dentro.

- [ ] **Step 1: Escrever o teste que falha**

`packages/core/src/contexts/news/domain/value-objects/text.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  containsTerm,
  normalizeForMatch,
  normalizeHeadline,
  stripPublisherSuffix,
} from "./text.js";

describe("normalizeForMatch", () => {
  it("baixa a caixa, tira acento e pontuação, colapsa espaço", () => {
    expect(normalizeForMatch("Prefeitura de Oeiras (PI) anuncia obras!")).toBe(
      "prefeitura de oeiras pi anuncia obras",
    );
  });

  it("NÃO remove stopwords — termos de exclude dependem delas", () => {
    expect(normalizeForMatch("Paço de Arcos")).toBe("paco de arcos");
  });

  it("devolve string vazia para entrada só de pontuação", () => {
    expect(normalizeForMatch("—  ...  —")).toBe("");
  });
});

describe("stripPublisherSuffix", () => {
  it("remove o sufixo ' - Veículo' que o Google News anexa", () => {
    expect(stripPublisherSuffix("Prefeitura de Oeiras anuncia obras - G1")).toBe(
      "Prefeitura de Oeiras anuncia obras",
    );
  });

  it("remove só o ÚLTIMO separador, preservando hífen interno do título", () => {
    expect(stripPublisherSuffix("Oeiras - PI recebe investimento - Cidadeverde.com")).toBe(
      "Oeiras - PI recebe investimento",
    );
  });

  it("não mexe em título sem sufixo", () => {
    expect(stripPublisherSuffix("Chuva forte atinge Oeiras")).toBe("Chuva forte atinge Oeiras");
  });

  it("não engole o título inteiro quando o sufixo é tudo que existe", () => {
    expect(stripPublisherSuffix("- G1")).toBe("- G1");
  });
});

describe("normalizeHeadline", () => {
  it("faz a mesma matéria em veículos diferentes colidir", () => {
    const g1 = normalizeHeadline("Prefeitura de Oeiras anuncia obras na PI-245 - G1");
    const cv = normalizeHeadline("Prefeitura de Oeiras anuncia obras na PI-245 - Cidadeverde.com");
    expect(g1).toBe(cv);
  });

  it("remove stopwords do pt-BR", () => {
    expect(normalizeHeadline("A Prefeitura de Oeiras e o Estado do Piauí")).toBe(
      "prefeitura oeiras estado piaui",
    );
  });

  it("não colide manchetes de assuntos diferentes", () => {
    expect(normalizeHeadline("Chuva forte atinge Oeiras - G1")).not.toBe(
      normalizeHeadline("Prefeitura de Oeiras anuncia obras - G1"),
    );
  });
});

describe("containsTerm", () => {
  const haystack = normalizeForMatch("Prefeitura de Oeiras (PI) anuncia obras no Piauí");

  it("casa termo de uma palavra", () => {
    expect(containsTerm(haystack, "oeiras")).toBe(true);
  });

  it("casa termo de várias palavras", () => {
    expect(containsTerm(haystack, "prefeitura de oeiras")).toBe(true);
  });

  it("respeita fronteira de palavra: 'pi' não casa dentro de 'piaui'", () => {
    expect(containsTerm(normalizeForMatch("Notícia do Piauí"), "pi")).toBe(false);
    expect(containsTerm(haystack, "pi")).toBe(true);
  });

  it("normaliza o termo antes de comparar (acento e caixa)", () => {
    expect(containsTerm(haystack, "Piauí")).toBe(true);
  });

  it("termo vazio nunca casa", () => {
    expect(containsTerm(haystack, "   ")).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

```bash
pnpm vitest run packages/core/src/contexts/news/domain/value-objects/text.spec.ts
```

Esperado: FAIL — `Failed to resolve import "./text.js"`.

- [ ] **Step 3: Escrever a implementação**

`packages/core/src/contexts/news/domain/value-objects/text.ts`:

```ts
/**
 * Duas normalizações, propósitos opostos — misturá-las é bug.
 *
 * `normalizeForMatch` alimenta a regra de alerta e PRESERVA stopwords: termos
 * de `exclude` legítimos as contêm ("paço de arcos"), e removê-las faria a
 * regra deixar de casar exatamente onde ela mais importa.
 *
 * `normalizeHeadline` alimenta só o `fingerprint`, e aí a agressividade é o
 * objetivo: é ela que faz a mesma matéria publicada por dois veículos produzir
 * o mesmo fingerprint — o que impede o flood de notificação.
 */

/** Stopwords do pt-BR, já sem acento (a remoção roda depois de normalizeForMatch). */
const PT_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "ao", "aos", "as", "com", "como", "da", "das", "de", "do", "dos", "e",
  "em", "entre", "na", "nas", "no", "nos", "num", "numa", "o", "os", "ou",
  "para", "pela", "pelas", "pelo", "pelos", "por", "que", "se", "sem", "sob",
  "sobre", "um", "uma", "umas", "uns",
]);

/**
 * Minúsculas, sem acento, sem pontuação, espaços colapsados.
 * Nunca aplicada ao dado exibido — só ao casamento.
 */
export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * O Google News anexa ` - Veículo` ao `<title>` de todo item. Se isso entrar no
 * fingerprint, a MESMA matéria em dois veículos gera fingerprints diferentes —
 * quebrando justamente o dedupe que ele existe para fazer.
 *
 * Corta no ÚLTIMO ` - `, porque o próprio título pode conter hífen
 * ("Oeiras - PI recebe investimento - Cidadeverde.com").
 */
export function stripPublisherSuffix(title: string): string {
  const cut = title.lastIndexOf(" - ");
  if (cut <= 0) return title;

  const head = title.slice(0, cut).trim();
  // Sufixo sem título antes dele não é sufixo: devolve o original.
  return head.length > 0 ? head : title;
}

/** Normalização do fingerprint: sem veículo, sem stopword. */
export function normalizeHeadline(title: string): string {
  return normalizeForMatch(stripPublisherSuffix(title))
    .split(" ")
    .filter((word) => word.length > 0 && !PT_STOPWORDS.has(word))
    .join(" ");
}

/**
 * Casamento com fronteira de palavra, sem regex montada em runtime.
 *
 * Envelopar os dois lados em espaço dá semântica de palavra inteira e funciona
 * igual para termo de uma ou várias palavras — então "pi" não casa dentro de
 * "piaui", que é exatamente o falso positivo que a desambiguação de Oeiras
 * não pode ter.
 */
export function containsTerm(haystack: string, term: string): boolean {
  const needle = normalizeForMatch(term);
  if (needle.length === 0) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

```bash
pnpm vitest run packages/core/src/contexts/news/domain/value-objects/text.spec.ts
```

Esperado: 15 testes PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/contexts/news
git commit -m "feat(news): normalizadores de texto para match e fingerprint"
```

---

### Task 4: Entidade `Article` — os três identificadores

**Files:**
- Create: `packages/core/src/contexts/news/domain/entities/article.ts`
- Test: `packages/core/src/contexts/news/domain/entities/article.spec.ts`

**Interfaces:**
- Consumes: `normalizeHeadline` de `../value-objects/text.js` (Task 3).
- Produces:
  - `type SourceId = string`
  - `interface ArticleSource { id: SourceId; externalId: string; url: string }`
  - `interface ArticleProps { source: ArticleSource; title: string; summary: string;
    publisher: string; publishedAt: Date | null; seenAt: Date }`
  - `class Article` com `readonly id`, `readonly fingerprint`, `readonly contentHash`,
    `readonly props`; estáticos `Article.create(props)`, `Article.buildId(source)`,
    `Article.buildFingerprint(title)`, `Article.buildContentHash(props)`; método de
    instância `hasChangedFrom(previousContentHash: string | null | undefined): boolean`.

- [ ] **Step 1: Escrever o teste que falha**

`packages/core/src/contexts/news/domain/entities/article.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Article, type ArticleProps } from "./article.js";

function props(overrides: Partial<ArticleProps> = {}): ArticleProps {
  return {
    source: {
      id: "google-news",
      externalId: "CBMiK2h0dHBzOi8vZzEuZ2xvYm8uY29t",
      url: "https://news.google.com/rss/articles/CBMiK2h0dHBz",
    },
    title: "Prefeitura de Oeiras anuncia obras na PI-245 - G1",
    summary: "A prefeitura confirmou o início das obras para o próximo mês.",
    publisher: "G1",
    publishedAt: new Date("2026-07-28T12:00:00.000Z"),
    seenAt: new Date("2026-07-28T15:30:00.000Z"),
    ...overrides,
  };
}

describe("Article.id", () => {
  it("é determinístico por (fonte, idExterno) — reprocessar não duplica", () => {
    expect(Article.create(props()).id).toBe(Article.create(props()).id);
  });

  it("não depende de nada além de fonte e idExterno", () => {
    const base = Article.create(props());
    const outroTitulo = Article.create(props({ title: "Título totalmente diferente - G1" }));
    expect(outroTitulo.id).toBe(base.id);
  });

  it("difere quando a fonte difere, mesmo com idExterno igual", () => {
    const a = Article.create(props());
    const b = Article.create(props({ source: { ...props().source, id: "rss-g1" } }));
    expect(a.id).not.toBe(b.id);
  });
});

describe("Article.contentHash", () => {
  it("não muda quando só o seenAt muda — é o curto-circuito do pipeline", () => {
    const a = Article.create(props());
    const b = Article.create(props({ seenAt: new Date("2026-08-01T09:00:00.000Z") }));
    expect(b.contentHash).toBe(a.contentHash);
    expect(b.hasChangedFrom(a.contentHash)).toBe(false);
  });

  it("muda quando a matéria é atualizada", () => {
    const a = Article.create(props());
    const b = Article.create(props({ summary: "A prefeitura adiou o início das obras." }));
    expect(b.hasChangedFrom(a.contentHash)).toBe(true);
  });

  it("trata publishedAt ausente sem virar não-determinístico", () => {
    const a = Article.create(props({ publishedAt: null }));
    const b = Article.create(props({ publishedAt: null }));
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("considera novo quando não há hash anterior", () => {
    expect(Article.create(props()).hasChangedFrom(null)).toBe(true);
  });
});

describe("Article.fingerprint", () => {
  it("é IGUAL para a mesma matéria em veículos diferentes — o que impede o flood", () => {
    const g1 = Article.create(props());
    const cv = Article.create(
      props({
        source: { id: "google-news", externalId: "OUTRO_GUID", url: "https://news.google.com/x" },
        title: "Prefeitura de Oeiras anuncia obras na PI-245 - Cidadeverde.com",
        publisher: "Cidadeverde.com",
      }),
    );

    expect(cv.id).not.toBe(g1.id);
    expect(cv.fingerprint).toBe(g1.fingerprint);
  });

  it("difere para matérias diferentes do mesmo veículo", () => {
    const a = Article.create(props());
    const b = Article.create(props({ title: "Chuva forte atinge Oeiras - G1" }));
    expect(b.fingerprint).not.toBe(a.fingerprint);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

```bash
pnpm vitest run packages/core/src/contexts/news/domain/entities/article.spec.ts
```

Esperado: FAIL — `Failed to resolve import "./article.js"`.

- [ ] **Step 3: Escrever a implementação**

`packages/core/src/contexts/news/domain/entities/article.ts`:

```ts
import { createHash } from "node:crypto";
import { normalizeHeadline } from "../value-objects/text.js";

export type SourceId = string;

export interface ArticleSource {
  /** Qual adapter produziu isso (ex.: "google-news", "rss-g1"). */
  readonly id: SourceId;
  /** Id da notícia NA fonte (o `<guid>` do item). Estável entre rodadas. */
  readonly externalId: string;
  readonly url: string;
}

export interface ArticleProps {
  readonly source: ArticleSource;
  /** Título como a fonte devolveu, sufixo de veículo incluso. É o que se exibe. */
  readonly title: string;
  readonly summary: string;
  /** Veículo que publicou ("G1", "Cidadeverde.com"). */
  readonly publisher: string;
  readonly publishedAt: Date | null;
  readonly seenAt: Date;
}

/**
 * Uma notícia normalizada, independente da fonte que a produziu.
 *
 * Três identificadores, cada um resolvendo um problema diferente:
 *
 * - `id`          determinístico por (fonte, idExterno). Reprocessar o mesmo
 *                 payload nunca duplica — é o que torna a ingestão idempotente.
 * - `contentHash` muda quando a matéria é ATUALIZADA. É o curto-circuito que
 *                 evita re-casar e re-notificar o que não mudou.
 * - `fingerprint` a MESMA matéria publicada por veículos diferentes. Aqui ele é
 *                 mais crítico que no job-radar: sindicação de notícia é a
 *                 regra, não a exceção, e é ele que impede cinco push da mesma
 *                 pauta. Por isso ignora deliberadamente o veículo.
 *
 * `seenAt` fica FORA do `contentHash` de propósito: ele muda toda rodada, e
 * incluí-lo faria 100% do catálogo parecer alterado a cada 30 minutos —
 * destruindo o modelo de custo inteiro.
 */
export class Article {
  private constructor(
    readonly id: string,
    readonly fingerprint: string,
    readonly contentHash: string,
    readonly props: ArticleProps,
  ) {}

  static create(props: ArticleProps): Article {
    return new Article(
      Article.buildId(props.source),
      Article.buildFingerprint(props.title),
      Article.buildContentHash(props),
      props,
    );
  }

  static buildId(source: ArticleSource): string {
    return sha256(`${source.id}:${source.externalId}`);
  }

  static buildFingerprint(title: string): string {
    return sha256(normalizeHeadline(title));
  }

  static buildContentHash(props: ArticleProps): string {
    return sha256(
      [
        props.title.trim(),
        props.summary.trim(),
        props.publishedAt?.toISOString() ?? "",
      ].join(" "),
    );
  }

  /** True quando o conteúdo mudou de fato — é o que libera match e notificação. */
  hasChangedFrom(previousContentHash: string | null | undefined): boolean {
    return previousContentHash !== this.contentHash;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

```bash
pnpm vitest run packages/core/src/contexts/news/domain/entities/article.spec.ts
```

Esperado: 9 testes PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/contexts/news/domain/entities
git commit -m "feat(news): entidade Article com id, contentHash e fingerprint"
```

---

### Task 5: `MatchRule`, `evaluateMatch` e `AlertProfile`

Este é o teste que decide se o produto presta. A regra é **dado, não código** —
calibrar a precisão do alerta é `PutItem`, nunca deploy.

**Files:**
- Create: `packages/core/src/contexts/news/domain/value-objects/match-rule.ts`
- Create: `packages/core/src/contexts/news/domain/entities/alert-profile.ts`
- Test: `packages/core/src/contexts/news/domain/value-objects/match-rule.spec.ts`

**Interfaces:**
- Consumes: `containsTerm`, `normalizeForMatch` de `./text.js` (Task 3); `Article` de
  `../entities/article.js` (Task 4).
- Produces:
  - `interface MatchRule { required: readonly string[]; boost: readonly string[];
    exclude: readonly string[]; minScore: number }`
  - `type MatchReason = "excluded" | "missing-required" | "below-min-score" | "matched"`
  - `interface MatchVerdict { matched: boolean; score: number; reason: MatchReason;
    matchedTerms: readonly string[]; excludedBy?: string }`
  - `evaluateMatch(article: Article, rule: MatchRule): MatchVerdict`
  - `interface AlertDestination { kind: "telegram"; chatId: string }`
  - `interface AlertProfile { profileId: string; name: string; queries: readonly string[];
    rule: MatchRule; destinations: readonly AlertDestination[]; enabled: boolean }`

- [ ] **Step 1: Escrever o teste que falha**

`packages/core/src/contexts/news/domain/value-objects/match-rule.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Article, type ArticleProps } from "../entities/article.js";
import { evaluateMatch, type MatchRule } from "./match-rule.js";

/** A regra real do perfil oeiras-pi, como ela vive no registro. */
const OEIRAS_PI: MatchRule = {
  required: ["oeiras"],
  boost: ["piauí", "pi", "picos", "teresina", "sertão"],
  exclude: ["lisboa", "portugal", "carcavelos", "paço de arcos", "algés"],
  minScore: 1,
};

function artigo(title: string, summary = ""): Article {
  const props: ArticleProps = {
    source: { id: "google-news", externalId: title, url: "https://news.google.com/x" },
    title,
    summary,
    publisher: "G1",
    publishedAt: null,
    seenAt: new Date("2026-07-28T00:00:00.000Z"),
  };
  return Article.create(props);
}

describe("evaluateMatch — desambiguação de Oeiras", () => {
  it("casa Oeiras do Piauí: required presente e boost confirma", () => {
    const verdict = evaluateMatch(artigo("Prefeitura de Oeiras (PI) anuncia obras"), OEIRAS_PI);
    expect(verdict.matched).toBe(true);
    expect(verdict.reason).toBe("matched");
    expect(verdict.score).toBeGreaterThanOrEqual(1);
  });

  it("rejeita Oeiras de Portugal quando nada reforça o Piauí", () => {
    const verdict = evaluateMatch(artigo("Câmara Municipal de Oeiras aprova orçamento"), OEIRAS_PI);
    expect(verdict.matched).toBe(false);
    expect(verdict.reason).toBe("below-min-score");
    expect(verdict.score).toBe(0);
  });

  it("exclude tem precedência sobre tudo, mesmo com boost casando", () => {
    const verdict = evaluateMatch(
      artigo("Obras na marginal de Paço de Arcos, Oeiras", "Reportagem de Teresina de Portugal"),
      OEIRAS_PI,
    );
    expect(verdict.matched).toBe(false);
    expect(verdict.reason).toBe("excluded");
    expect(verdict.excludedBy).toBe("paço de arcos");
  });

  it("rejeita quando o required não aparece", () => {
    const verdict = evaluateMatch(artigo("Governo do Piauí anuncia obras em Picos"), OEIRAS_PI);
    expect(verdict.matched).toBe(false);
    expect(verdict.reason).toBe("missing-required");
  });
});

describe("evaluateMatch — mecânica", () => {
  it("avalia título E resumo juntos", () => {
    const verdict = evaluateMatch(artigo("Nova ponte é inaugurada em Oeiras", "Cidade do Piauí"), OEIRAS_PI);
    expect(verdict.matched).toBe(true);
  });

  it("conta cada termo de boost uma vez só, ainda que repetido", () => {
    const verdict = evaluateMatch(artigo("Oeiras, Piauí", "Piauí, Piauí, Piauí"), OEIRAS_PI);
    expect(verdict.score).toBe(1);
    expect(verdict.matchedTerms).toEqual(["piauí"]);
  });

  it("respeita fronteira de palavra: 'pi' não casa dentro de 'piaui'", () => {
    const verdict = evaluateMatch(artigo("Oeiras no Piauí"), {
      ...OEIRAS_PI,
      boost: ["pi"],
    });
    expect(verdict.score).toBe(0);
  });

  it("minScore 0 casa sem nenhum boost, desde que required passe", () => {
    const verdict = evaluateMatch(artigo("Câmara Municipal de Oeiras"), {
      ...OEIRAS_PI,
      minScore: 0,
    });
    expect(verdict.matched).toBe(true);
  });

  it("regra vazia com minScore 0 casa tudo — é a regra 'ingerir sem filtro'", () => {
    const verdict = evaluateMatch(artigo("Qualquer notícia"), {
      required: [],
      boost: [],
      exclude: [],
      minScore: 0,
    });
    expect(verdict.matched).toBe(true);
  });

  it("é pura: a mesma entrada devolve o mesmo veredito", () => {
    const a = artigo("Prefeitura de Oeiras (PI) anuncia obras");
    expect(evaluateMatch(a, OEIRAS_PI)).toEqual(evaluateMatch(a, OEIRAS_PI));
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

```bash
pnpm vitest run packages/core/src/contexts/news/domain/value-objects/match-rule.spec.ts
```

Esperado: FAIL — `Failed to resolve import "./match-rule.js"`.

- [ ] **Step 3: Escrever `match-rule.ts`**

```ts
import type { Article } from "../entities/article.js";
import { containsTerm, normalizeForMatch } from "./text.js";

/**
 * A regra de alerta. É DADO, não código: vive no registro de perfis, e calibrar
 * a precisão do alerta é um PutItem — nunca um deploy. Isso importa muito nas
 * primeiras semanas, quando a regra é ajustada várias vezes.
 */
export interface MatchRule {
  /** Todos precisam casar. Ausência de qualquer um reprova. */
  readonly required: readonly string[];
  /** Cada um que casa soma 1 ao score. É o que CONFIRMA o verdadeiro positivo. */
  readonly boost: readonly string[];
  /** Qualquer um que case reprova na hora. É o que MATA o falso positivo. */
  readonly exclude: readonly string[];
  readonly minScore: number;
}

export type MatchReason = "excluded" | "missing-required" | "below-min-score" | "matched";

export interface MatchVerdict {
  readonly matched: boolean;
  readonly score: number;
  readonly reason: MatchReason;
  /** Termos de boost que casaram — vai para o log, é o que permite calibrar. */
  readonly matchedTerms: readonly string[];
  /** Preenchido só quando `reason === "excluded"`. */
  readonly excludedBy?: string;
}

/**
 * Função PURA sobre (Article, MatchRule). Sem I/O, sem relógio, sem
 * aleatoriedade — pelo mesmo motivo que `parse` é puro: é o que permite testá-la
 * contra manchetes reais gravadas.
 *
 * Ordem de avaliação, e ela importa:
 *   1. `exclude` casou  -> reprova imediatamente, ANTES de qualquer outra coisa.
 *   2. `required` faltou -> reprova.
 *   3. score = boosts que casaram.
 *   4. match se score >= minScore.
 *
 * `exclude` vir primeiro é o que faz "Obras em Paço de Arcos, Oeiras" ser
 * rejeitada mesmo tendo o `required` e algum boost.
 */
export function evaluateMatch(article: Article, rule: MatchRule): MatchVerdict {
  const haystack = normalizeForMatch(`${article.props.title} ${article.props.summary}`);

  const excludedBy = rule.exclude.find((term) => containsTerm(haystack, term));
  if (excludedBy !== undefined) {
    return { matched: false, score: 0, reason: "excluded", matchedTerms: [], excludedBy };
  }

  const missingRequired = rule.required.some((term) => !containsTerm(haystack, term));
  if (missingRequired) {
    return { matched: false, score: 0, reason: "missing-required", matchedTerms: [] };
  }

  // Set: um termo repetido na manchete não infla o score.
  const matchedTerms = [...new Set(rule.boost.filter((term) => containsTerm(haystack, term)))];
  const score = matchedTerms.length;

  return score >= rule.minScore
    ? { matched: true, score, reason: "matched", matchedTerms }
    : { matched: false, score, reason: "below-min-score", matchedTerms };
}
```

- [ ] **Step 4: Escrever `alert-profile.ts`**

```ts
import type { MatchRule } from "../value-objects/match-rule.js";

export interface AlertDestination {
  readonly kind: "telegram";
  readonly chatId: string;
}

/**
 * Um assunto inscrito. Criar assunto novo é um PutItem, NUNCA um deploy —
 * mesma promessa do registro de fontes.
 *
 * `queries` é o que vai para as fontes query-driven (Google News). `rule` é o
 * recorte aplicado depois, sobre tudo que entrou — inclusive sobre o que veio
 * de fonte feed-driven, que não tem query nenhuma.
 */
export interface AlertProfile {
  readonly profileId: string;
  readonly name: string;
  readonly queries: readonly string[];
  readonly rule: MatchRule;
  readonly destinations: readonly AlertDestination[];
  readonly enabled: boolean;
}
```

- [ ] **Step 5: Rodar o teste e confirmar que passa**

```bash
pnpm vitest run packages/core/src/contexts/news/domain/value-objects/match-rule.spec.ts
pnpm typecheck
```

Esperado: 10 testes PASS, typecheck limpo.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/contexts/news
git commit -m "feat(news): regra de match determinística e perfil de alerta"
```

---

### Task 6a: Erros do contexto + `NewsSourcePort`

**Files:**
- Create: `packages/core/src/contexts/news/domain/news.errors.ts`
- Create: `packages/core/src/contexts/news/domain/ports/news-source.port.ts`

**Interfaces:**
- Consumes: `BusinessError`, `ErrorType`, `Result` dos commons (Task 1); `Article`,
  `SourceId` (Task 4).
- Produces:
  - Erros: `SourceUnavailable.create(sourceId, { status, message })`,
    `SourceContractDrift.create(sourceId, reason, sample?)`,
    `InvalidSourceConfig.create(sourceId, reason)`, `UnknownSource.create(sourceId)`,
    `InvalidProfileConfig.create(profileId, reason)`,
    `NotificationFailed.create(kind, { status, message })`.
  - `type SourceMode = "query-driven" | "feed-driven"`
  - `interface SourceConfig { sourceId: SourceId; mode: SourceMode; selector: string;
    enabled: boolean; params: Readonly<Record<string, string>> }`
  - `interface FetchTask { sourceId: SourceId; selector: string; page: number; runId: string;
    params: Readonly<Record<string, string>> }`
  - `interface CacheMetadata { etag: string | null; lastModified: string | null }`
  - `interface RawBatch { task: FetchTask; payload: string; contentType: string;
    fetchedAt: Date; cache: CacheMetadata; next: FetchTask | null }`
  - `type FetchOutcome = { kind: "fetched"; batch: RawBatch } | { kind: "not-modified"; task: FetchTask }`
  - `interface FetchPolicy { minDelayMs: number; maxAttempts: number; respectsRobotsTxt: boolean;
    requiresAttribution: boolean }`
  - `abstract class NewsSourcePort` com `readonly id`, `readonly mode`, `readonly policy`,
    `discover(config, selectors, runId)`, `fetch(task, cache)`, `parse(batch)`.

- [ ] **Step 1: Escrever `news.errors.ts`**

Copiar `/Users/mpgxc/mpgxcx/packages/core/src/contexts/ingestion/domain/ingestion.errors.ts`
sem alteração (as quatro classes `SourceUnavailable`, `SourceContractDrift`,
`InvalidSourceConfig`, `UnknownSource`), trocando o import para
`../../../commons/business-error.js`, e acrescentar as duas classes novas:

```ts
/** Regra de alerta malformada no registro de perfis. Retentar não conserta. */
export class InvalidProfileConfig extends BusinessError {
  readonly type = ErrorType.INVALID_PROFILE_CONFIG;
  readonly code = "INVALID_PROFILE_CONFIG";

  static create(profileId: string, reason: string) {
    return new InvalidProfileConfig({
      message: `Perfil ${profileId} inválido: ${reason}`,
      details: { profileId, reason },
    });
  }
}

/** O canal de notificação recusou o envio. Vale retentar (5xx, rede, 429). */
export class NotificationFailed extends BusinessError {
  readonly type = ErrorType.NOTIFICATION_FAILED;
  readonly code = "NOTIFICATION_FAILED";

  static create(kind: string, cause: { status: number | null; message: string }) {
    return new NotificationFailed({
      message: `Envio por ${kind} falhou: ${cause.message}`,
      details: { kind, ...cause },
    });
  }
}
```

- [ ] **Step 2: Escrever `ports/news-source.port.ts`**

Partir de `/Users/mpgxc/mpgxcx/packages/core/src/contexts/ingestion/domain/ports/job-source.port.ts`
com quatro mudanças, e **só** essas:

1. `JobPosting` → `Article` no retorno de `parse`.
2. `SourceConfig` ganha `readonly mode: SourceMode`.
3. `discover` recebe `selectors: readonly string[]` além da config.
4. Comentários reescritos para o domínio de notícia.

```ts
import type { BusinessError } from "../../../../commons/business-error.js";
import type { Result } from "../../../../commons/result.js";
import type { Article, SourceId } from "../entities/article.js";

/**
 * Duas naturezas de fonte, e o `discovery` trata cada uma de um jeito:
 *
 * - `query-driven` (Google News): a query vem do PERFIL, não da fonte. É o
 *   inverso do job-radar. Perfis que compartilham query têm que virar UMA busca.
 * - `feed-driven` (RSS do G1, portal local): não há query. O `selector` da
 *   config é a URL do feed, tudo que vier é ingerido, e o recorte acontece
 *   depois, no `match`.
 */
export type SourceMode = "query-driven" | "feed-driven";

/** Uma linha do registro de fontes. Habilitar fonte nova é inserir uma linha. */
export interface SourceConfig {
  readonly sourceId: SourceId;
  readonly mode: SourceMode;
  /** URL do feed em fonte feed-driven; vazio em fonte query-driven. */
  readonly selector: string;
  readonly enabled: boolean;
  readonly params: Readonly<Record<string, string>>;
}

/** Uma unidade de trabalho buscável: uma requisição HTTP, uma página. */
export interface FetchTask {
  readonly sourceId: SourceId;
  /**
   * O selector EFETIVO: a query (query-driven) ou a URL do feed (feed-driven).
   *
   * Nunca carrega `profileId`. O casamento com perfis acontece só no `match`,
   * contra todos eles — é isso que mantém o fetch desacoplado dos perfis e
   * evita buscar a mesma query duas vezes.
   */
  readonly selector: string;
  /** 0-based. Fonte sem paginação usa sempre 0. */
  readonly page: number;
  /** Correlaciona todas as tarefas de uma mesma rodada. */
  readonly runId: string;
  readonly params: Readonly<Record<string, string>>;
}

/** O que permite pular o payload inteiro numa próxima rodada. */
export interface CacheMetadata {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface RawBatch {
  readonly task: FetchTask;
  /** O corpo exatamente como a fonte devolveu. Vai cru para a zona raw. */
  readonly payload: string;
  readonly contentType: string;
  readonly fetchedAt: Date;
  readonly cache: CacheMetadata;
  /**
   * Continuação da paginação, ou `null` no fim.
   *
   * No MVP NENHUMA fonte pagina: o Google News devolve a janela inteira sem
   * cursor e feeds RSS entregam a janela corrente. A capacidade fica porque o
   * Reddit (fatia 3) usa cursor `after` — tirá-la da porta para reintroduzir
   * depois seria trabalho puro.
   */
  readonly next: FetchTask | null;
}

export type FetchOutcome =
  | { readonly kind: "fetched"; readonly batch: RawBatch }
  /** A fonte respondeu 304: nada mudou desde o último ETag/Last-Modified. */
  | { readonly kind: "not-modified"; readonly task: FetchTask };

/** Política de educação com a fonte. Vive no adapter porque varia por fonte. */
export interface FetchPolicy {
  readonly minDelayMs: number;
  readonly maxAttempts: number;
  readonly respectsRobotsTxt: boolean;
  /** Alguns feeds exigem crédito e link de volta nos Termos de Uso. */
  readonly requiresAttribution: boolean;
}

/**
 * A porta única de fonte de notícia.
 *
 * A separação entre `fetch` e `parse` é o ponto mais importante do desenho:
 * `fetch` faz I/O; `parse` é PURA e roda contra fixtures gravadas. Parser drift
 * — a fonte muda o XML e o pipeline degrada em silêncio — é o modo de falha
 * número um de um agregador.
 */
export abstract class NewsSourcePort {
  abstract readonly id: SourceId;
  abstract readonly mode: SourceMode;
  abstract readonly policy: FetchPolicy;

  /**
   * Explode a config em tarefas iniciais.
   *
   * `selectors` são os selectors EFETIVOS que o use-case já resolveu: a união
   * das queries dos perfis (query-driven) ou `[config.selector]` (feed-driven).
   * O adapter não conhece perfil.
   */
  abstract discover(
    config: SourceConfig,
    selectors: readonly string[],
    runId: string,
  ): Result<FetchTask[], BusinessError>;

  /** Camada 1 (client): só transporte. */
  abstract fetch(
    task: FetchTask,
    cache: CacheMetadata,
  ): Promise<Result<FetchOutcome, BusinessError>>;

  /** Camada 2 (ACL): sem I/O, sem relógio, sem aleatoriedade. */
  abstract parse(batch: RawBatch): Result<Article[], BusinessError>;
}
```

- [ ] **Step 3: Verificar que compila**

```bash
pnpm typecheck
```

Esperado: limpo.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/contexts/news/domain
git commit -m "feat(news): erros do contexto e porta de fonte de notícia"
```

---

### Task 6b: Ports de persistência, notificação e o catálogo

**Files:**
- Create: `packages/core/src/contexts/news/domain/ports/repositories.port.ts`
- Create: `packages/core/src/contexts/news/domain/ports/notifier.port.ts`
- Create: `packages/core/src/contexts/news/domain/source-catalog.ts`
- Create: `packages/core/src/contexts/news/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/contexts/news/domain/source-catalog.spec.ts`

**Interfaces:**
- Consumes: tudo das Tasks 4, 5 e 6a.
- Produces:
  - `type UpsertOutcome = "created" | "updated" | "unchanged"`
  - `abstract class ArticleRepository { upsert(article, runId): Promise<UpsertOutcome> }`
  - `abstract class ProfileRegistry { listEnabled(): Promise<AlertProfile[]>;
    get(profileId): Promise<AlertProfile | null> }`
  - `abstract class SourceRegistry { listEnabled(): Promise<SourceConfig[]> }`
  - `abstract class FetchCacheStore { get(task); put(task, cache) }`
  - `interface RawObjectRef { bucket: string; key: string }`
  - `abstract class RawStorage { put(task, payload, contentType); get(ref) }`
  - `interface NormalizeMessage { task: FetchTask; ref: RawObjectRef; fetchedAt: Date }`
  - `interface NotifyTask { profileId: string; articleId: string; fingerprint: string;
    title: string; url: string; publisher: string; publishedAt: string | null; score: number }`
  - `abstract class WorkQueue { enqueueFetch; enqueueNormalize; enqueueNotify }`
  - `abstract class NotificationLog { claim(profileId, fingerprint): Promise<boolean>;
    release(profileId, fingerprint): Promise<void> }`
  - `interface Notification { profileName; title; publisher; url; publishedAt: string | null }`
  - `abstract class NotifierPort { readonly kind: string;
    send(destination, notification): Promise<Result<void, BusinessError>> }`
  - `class SourceCatalog` com `constructor(sources)`, `get(sourceId)`, getter `ids`.

- [ ] **Step 1: Escrever `repositories.port.ts`**

```ts
import type { Article } from "../entities/article.js";
import type { AlertProfile } from "../entities/alert-profile.js";
import type { CacheMetadata, FetchTask, SourceConfig } from "./news-source.port.js";

/** Resultado de um upsert — é o que diz se vale casar com perfis e alertar. */
export type UpsertOutcome = "created" | "updated" | "unchanged";

export abstract class ArticleRepository {
  /**
   * Escrita condicional pelo `contentHash`: se o conteúdo não mudou, devolve
   * `unchanged` e o estágio de match nem roda. É este curto-circuito que evita
   * re-casar o catálogo inteiro a cada rodada.
   */
  abstract upsert(article: Article, runId: string): Promise<UpsertOutcome>;
}

export abstract class ProfileRegistry {
  abstract listEnabled(): Promise<AlertProfile[]>;
  abstract get(profileId: string): Promise<AlertProfile | null>;
}

export abstract class SourceRegistry {
  abstract listEnabled(): Promise<SourceConfig[]>;
}

/** Metadados de cache HTTP por tarefa, para conseguir mandar If-None-Match. */
export abstract class FetchCacheStore {
  abstract get(task: FetchTask): Promise<CacheMetadata | null>;
  abstract put(task: FetchTask, cache: CacheMetadata): Promise<void>;
}

export interface RawObjectRef {
  readonly bucket: string;
  readonly key: string;
}

/**
 * Zona raw. Guarda o XML cru para permitir reprocessar um parser corrigido sem
 * bater na fonte de novo — o que importa aqui mais do que no job-radar, porque
 * o feed do Google News só mostra a janela corrente: o que saiu dela, sumiu.
 */
export abstract class RawStorage {
  abstract put(task: FetchTask, payload: string, contentType: string): Promise<RawObjectRef>;
  abstract get(ref: RawObjectRef): Promise<{ payload: string; contentType: string }>;
}

export interface NormalizeMessage {
  readonly task: FetchTask;
  readonly ref: RawObjectRef;
  readonly fetchedAt: Date;
}

/**
 * O que trafega até o `notify`. É um instantâneo achatado de propósito: notícia
 * é pequena, então não precisa de claim-check, e o `notify` não deve depender
 * de reler o artigo do banco.
 */
export interface NotifyTask {
  readonly profileId: string;
  readonly articleId: string;
  /** A chave do dedupe. NÃO é o articleId — ver NotificationLog. */
  readonly fingerprint: string;
  readonly title: string;
  readonly url: string;
  readonly publisher: string;
  readonly publishedAt: string | null;
  readonly score: number;
}

export abstract class WorkQueue {
  abstract enqueueFetch(tasks: readonly FetchTask[], correlationId: string): Promise<void>;
  abstract enqueueNormalize(
    messages: readonly NormalizeMessage[],
    correlationId: string,
  ): Promise<void>;
  abstract enqueueNotify(tasks: readonly NotifyTask[], correlationId: string): Promise<void>;
}

/**
 * O log de notificação é a peça que decide se o produto presta.
 *
 * A chave é `(profileId, fingerprint)` e NÃO `(profileId, articleId)`.
 * Deduplicar por id é a falha clássica desse tipo de produto: sindicação dá à
 * mesma pauta ids diferentes em cada veículo, e o usuário recebe cinco push.
 *
 * `claim` é uma escrita CONDICIONAL — a garantia vem do banco, não de um `if`.
 * Cobre três casos de uma vez: sindicação, replay de payload antigo, e
 * reentrega do SQS depois de falha parcial.
 */
export abstract class NotificationLog {
  /** `true` = registrou agora, pode enviar. `false` = já existia, não envie. */
  abstract claim(profileId: string, fingerprint: string): Promise<boolean>;

  /**
   * Desfaz um `claim` cujo envio falhou, para a reentrega poder tentar de novo.
   *
   * Sem isso, a ordem "claim, envia, falha" perderia o alerta em silêncio: a
   * reentrega veria o claim e pularia. A janela entre claim e release é curta;
   * morrer dentro dela custa um alerta, o que é preferível a duplicar.
   */
  abstract release(profileId: string, fingerprint: string): Promise<void>;
}
```

- [ ] **Step 2: Escrever `notifier.port.ts`**

```ts
import type { BusinessError } from "../../../../commons/business-error.js";
import type { Result } from "../../../../commons/result.js";
import type { AlertDestination } from "../entities/alert-profile.js";

/** O que o usuário vê. Já formatado pelo domínio, sem saber de Telegram. */
export interface Notification {
  readonly profileName: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly publishedAt: string | null;
}

/**
 * O canal de saída. Trocar Telegram por Discord é escrever outra implementação
 * desta porta — o pipeline não muda.
 */
export abstract class NotifierPort {
  /** Casa com `AlertDestination.kind`. */
  abstract readonly kind: string;

  abstract send(
    destination: AlertDestination,
    notification: Notification,
  ): Promise<Result<void, BusinessError>>;
}
```

- [ ] **Step 3: Escrever `source-catalog.ts`**

Copiar `/Users/mpgxc/mpgxcx/packages/core/src/contexts/ingestion/domain/source-catalog.ts`,
trocando `JobSourcePort` por `NewsSourcePort` e o import de erros para
`./news.errors.js`.

- [ ] **Step 4: Escrever o teste do catálogo**

`packages/core/src/contexts/news/domain/source-catalog.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Result } from "../../../commons/result.js";
import type { BusinessError } from "../../../commons/business-error.js";
import type { Article } from "./entities/article.js";
import {
  type CacheMetadata,
  type FetchOutcome,
  type FetchPolicy,
  type FetchTask,
  NewsSourcePort,
  type RawBatch,
  type SourceConfig,
  type SourceMode,
} from "./ports/news-source.port.js";
import { SourceCatalog } from "./source-catalog.js";

class FonteFalsa extends NewsSourcePort {
  readonly mode: SourceMode = "query-driven";
  readonly policy: FetchPolicy = {
    minDelayMs: 0,
    maxAttempts: 1,
    respectsRobotsTxt: false,
    requiresAttribution: false,
  };

  constructor(readonly id: string) {
    super();
  }

  discover(
    _config: SourceConfig,
    _selectors: readonly string[],
    _runId: string,
  ): Result<FetchTask[], BusinessError> {
    throw new Error("não usado");
  }
  async fetch(_t: FetchTask, _c: CacheMetadata): Promise<Result<FetchOutcome, BusinessError>> {
    throw new Error("não usado");
  }
  parse(_b: RawBatch): Result<Article[], BusinessError> {
    throw new Error("não usado");
  }
}

describe("SourceCatalog", () => {
  const catalog = new SourceCatalog([new FonteFalsa("google-news"), new FonteFalsa("rss-g1")]);

  it("resolve o adapter pelo sourceId", () => {
    const found = catalog.get("google-news");
    expect(found.isOk()).toBe(true);
    if (found.isOk()) expect(found.value.id).toBe("google-news");
  });

  it("devolve UnknownSource como valor, não como exceção", () => {
    const found = catalog.get("tiktok");
    expect(found.isErr()).toBe(true);
    if (found.isErr()) expect(found.error.code).toBe("UNKNOWN_SOURCE");
  });

  it("lista os ids registrados", () => {
    expect(catalog.ids).toEqual(["google-news", "rss-g1"]);
  });
});
```

- [ ] **Step 5: Escrever o barrel `contexts/news/index.ts`**

Exportar, com `export type` para tipos: `Article`, `ArticleProps`, `ArticleSource`,
`SourceId`; `AlertProfile`, `AlertDestination`; `MatchRule`, `MatchVerdict`,
`MatchReason`, `evaluateMatch`; `normalizeForMatch`, `normalizeHeadline`,
`stripPublisherSuffix`, `containsTerm`; os seis erros; tudo de
`news-source.port.js`, `repositories.port.js` e `notifier.port.js`; `SourceCatalog`.
Os use-cases entram aqui nas Tasks 8 e 9.

E em `packages/core/src/index.ts`:

```ts
export * from "./commons/index.js";
export * from "./contexts/news/index.js";
```

- [ ] **Step 6: Rodar tudo**

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Esperado: todos PASS, typecheck e lint limpos.

- [ ] **Step 7: Commit**

```bash
git add packages/core
git commit -m "feat(news): ports de persistência e notificação, catálogo de fontes"
```

---

### Task 7a: Pacote `adapters` + parser de RSS

**Files:**
- Create: `packages/adapters/package.json`, `packages/adapters/tsconfig.json`
- Create: `packages/adapters/src/http/http-client.ts`, `packages/adapters/src/http/circuit-breaker.ts`
- Create: `packages/adapters/src/feed/feed.parser.ts`
- Create: `packages/adapters/src/index.ts`
- Modify: `tsconfig.json` (raiz) — acrescentar `{ "path": "./packages/adapters" }`
- Test: `packages/adapters/src/feed/feed.parser.spec.ts`

**Interfaces:**
- Consumes: `@news-radar/core`.
- Produces:
  - `class SourceHttpError extends Error` com `readonly status: number | null`,
    `readonly body?: string`, getter `isRetryable`.
  - `class HttpClient` com `get(request): Promise<HttpResponse>`; `const NOT_MODIFIED = 304`.
  - `class CircuitBreaker` com `execute<T>(op): Promise<T>`, getter `currentState`.
  - `class FeedParseError extends Error`
  - `interface FeedItem { title: string; link: string; guid: string; pubDate: string | null;
    description: string; sourceName: string | null; sourceUrl: string | null }`
  - `parseRssFeed(xml: string): FeedItem[]` — lança `FeedParseError`.
  - `stripHtml(value: string): string`

**Escopo consciente:** só RSS 2.0 nesta fatia. Atom entra na fatia 2, junto com a
primeira fixture Atom real — parser sem fixture para testar é pior que parser
ausente.

- [ ] **Step 1: Criar o pacote e instalar a dependência**

`packages/adapters/package.json`:

```json
{
  "name": "@news-radar/adapters",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@news-radar/core": "workspace:*",
    "fast-xml-parser": "^5.2.5"
  }
}
```

`packages/adapters/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../core" }]
}
```

```bash
pnpm install
```

- [ ] **Step 2: Copiar a camada HTTP**

`packages/adapters/src/http/http-client.ts` e
`packages/adapters/src/http/circuit-breaker.ts` — copiar **na íntegra** de
`/Users/mpgxc/mpgxcx/packages/adapters/src/http/`, com duas alterações no client:

1. `accept` default vira `"application/rss+xml, application/xml, text/xml, */*"`.
2. Nos comentários, trocar "Gupy/Greenhouse" por "Google News/G1".

- [ ] **Step 3: Escrever o teste do parser**

`packages/adapters/src/feed/feed.parser.spec.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FeedParseError, parseRssFeed, stripHtml } from "./feed.parser.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../fixtures/google-news/${name}`, import.meta.url), "utf8");

describe("parseRssFeed", () => {
  it("extrai os itens da fixture real do Google News", () => {
    const items = parseRssFeed(fixture("oeiras-piaui.xml"));

    expect(items.length).toBeGreaterThan(0);
    const first = items[0];
    expect(first).toBeDefined();
    if (!first) return;

    expect(first.title.length).toBeGreaterThan(0);
    expect(first.guid.length).toBeGreaterThan(0);
    expect(first.link).toMatch(/^https?:\/\//);
  });

  it("preserva a ordem dos itens do feed", () => {
    const items = parseRssFeed(fixture("oeiras-piaui.xml"));
    const again = parseRssFeed(fixture("oeiras-piaui.xml"));
    expect(items.map((i) => i.guid)).toEqual(again.map((i) => i.guid));
  });

  it("é puro: duas passagens sobre o mesmo XML dão o mesmo resultado", () => {
    expect(parseRssFeed(fixture("oeiras-piaui.xml"))).toEqual(
      parseRssFeed(fixture("oeiras-piaui.xml")),
    );
  });

  it("feed sem item é lista vazia, não erro", () => {
    expect(parseRssFeed(fixture("vazio.xml"))).toEqual([]);
  });

  it("trata item único (o parser não devolve array quando só há um)", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <title>t</title>
      <item><title>Só um</title><link>https://x/1</link><guid>g1</guid></item>
    </channel></rss>`;
    const items = parseRssFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("Só um");
  });

  it("cai no link quando o item não tem guid", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item><title>Sem guid</title><link>https://x/1</link></item>
    </channel></rss>`;
    expect(parseRssFeed(xml)[0]?.guid).toBe("https://x/1");
  });

  it("lança FeedParseError em XML inválido", () => {
    expect(() => parseRssFeed("<rss><channel><item></rss")).toThrow(FeedParseError);
  });

  it("lança FeedParseError quando não é um feed RSS", () => {
    expect(() => parseRssFeed(`<?xml version="1.0"?><html><body>oi</body></html>`)).toThrow(
      FeedParseError,
    );
  });
});

describe("stripHtml", () => {
  it("tira tags e decodifica as entidades que o Google News usa", () => {
    expect(stripHtml('<a href="x">Título</a>&nbsp;&nbsp;<font>G1</font>')).toBe("Título G1");
  });

  it("decodifica &amp; &lt; &gt; &quot; &#39;", () => {
    expect(stripHtml("Tom &amp; Jerry &lt;b&gt; &quot;x&quot; &#39;y&#39;")).toBe(
      'Tom & Jerry <b> "x" \'y\'',
    );
  });

  it("colapsa espaço e apara as pontas", () => {
    expect(stripHtml("  a   \n  b  ")).toBe("a b");
  });
});
```

- [ ] **Step 4: Rodar e confirmar que falha**

```bash
pnpm vitest run packages/adapters/src/feed/feed.parser.spec.ts
```

Esperado: FAIL — módulo não resolvido.

- [ ] **Step 5: Escrever o parser**

`packages/adapters/src/feed/feed.parser.ts`:

```ts
import { XMLParser, XMLValidator } from "fast-xml-parser";

/**
 * Camada 1 do lado do XML: transforma bytes em estrutura, e nada mais. Não
 * conhece `Article` nem `BusinessError` — a tradução acontece no adapter.
 */
export class FeedParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedParseError";
  }
}

export interface FeedItem {
  readonly title: string;
  readonly link: string;
  /** `<guid>`, ou o link quando o feed não traz guid. */
  readonly guid: string;
  readonly pubDate: string | null;
  readonly description: string;
  /** `<source>` — o veículo. Presente no Google News, ausente em feed próprio. */
  readonly sourceName: string | null;
  readonly sourceUrl: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Sem isso, "123" e "true" viram number/boolean e o código quebra em runtime.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

/** RSS 2.0. Atom entra na fatia 2, junto com a primeira fixture Atom real. */
export function parseRssFeed(xml: string): FeedItem[] {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    throw new FeedParseError(`XML inválido: ${valid.err.msg} (linha ${valid.err.line})`);
  }

  const doc = parser.parse(xml) as Record<string, unknown>;
  const channel = (doc.rss as Record<string, unknown> | undefined)?.channel;
  if (!isRecord(channel)) {
    throw new FeedParseError("payload não é um feed RSS: rss.channel ausente");
  }

  // fast-xml-parser devolve objeto (não array) quando há um item só.
  return asArray(channel.item).filter(isRecord).map(toFeedItem);
}

function toFeedItem(raw: Record<string, unknown>): FeedItem {
  const link = text(raw.link);
  const source = raw.source;

  return {
    title: text(raw.title),
    link,
    guid: text(raw.guid) || link,
    pubDate: text(raw.pubDate) || null,
    description: stripHtml(text(raw.description)),
    sourceName: isRecord(source) ? text(source["#text"]) || null : text(source) || null,
    sourceUrl: isRecord(source) ? text(source["@_url"]) || null : null,
  };
}

/**
 * O `<description>` do Google News é HTML escapado. Guardar HTML no resumo
 * envenenaria o `contentHash` e a regra de match com marcação.
 */
export function stripHtml(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // &amp; por ÚLTIMO: antes disso, "&amp;lt;" viraria "<" indevidamente.
    .replace(/&amp;/g, "&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isRecord(value) && typeof value["#text"] === "string") return value["#text"];
  return "";
}
```

- [ ] **Step 6: Escrever o barrel e rodar**

`packages/adapters/src/index.ts` (o do Google News entra na Task 7b):

```ts
export {
  FeedParseError,
  type FeedItem,
  parseRssFeed,
  stripHtml,
} from "./feed/feed.parser.js";
export { CircuitBreaker, type CircuitState } from "./http/circuit-breaker.js";
export {
  HttpClient,
  type HttpResponse,
  NOT_MODIFIED,
  SourceHttpError,
} from "./http/http-client.js";
```

```bash
pnpm vitest run packages/adapters/src/feed/feed.parser.spec.ts
pnpm typecheck
```

Esperado: 11 testes PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/adapters tsconfig.json
git commit -m "feat(adapters): parser de RSS 2.0 e camada HTTP"
```

---

### Task 7b: `GoogleNewsAdapter` — client, mapper e ACL

**Files:**
- Create: `packages/adapters/src/google-news/google-news.client.ts`
- Create: `packages/adapters/src/google-news/google-news.mapper.ts`
- Create: `packages/adapters/src/google-news/google-news.adapter.ts`
- Modify: `packages/adapters/src/index.ts`
- Test: `packages/adapters/src/google-news/google-news.adapter.spec.ts`

**Interfaces:**
- Consumes: `parseRssFeed`, `FeedItem`, `HttpClient`, `CircuitBreaker`, `SourceHttpError`,
  `NOT_MODIFIED` (Task 7a); `NewsSourcePort`, `Article`, erros (Tasks 4 e 6a).
- Produces:
  - `const GOOGLE_NEWS_SOURCE_ID = "google-news"`
  - `class GoogleNewsClient` com
    `search(input: { query: string; etag: string | null; lastModified: string | null }): Promise<HttpResponse>`
    e `static buildUrl(query: string): string`.
  - `toArticle(item: FeedItem, fetchedAt: Date): Article`
  - `class GoogleNewsAdapter extends NewsSourcePort` com `constructor(client: GoogleNewsClient)`.

- [ ] **Step 1: Escrever o teste que falha**

`packages/adapters/src/google-news/google-news.adapter.spec.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RawBatch, SourceConfig } from "@news-radar/core";
import { GoogleNewsAdapter } from "./google-news.adapter.js";
import { GoogleNewsClient } from "./google-news.client.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../../../../fixtures/google-news/${name}`, import.meta.url), "utf8");

/** O client não é exercitado no parse — `parse` é puro e não faz I/O. */
const adapter = new GoogleNewsAdapter(null as unknown as GoogleNewsClient);

const config: SourceConfig = {
  sourceId: "google-news",
  mode: "query-driven",
  selector: "",
  enabled: true,
  params: {},
};

function batch(name: string, selector = "Oeiras Piauí"): RawBatch {
  return {
    task: { sourceId: "google-news", selector, page: 0, runId: "r1", params: {} },
    payload: fixture(name),
    contentType: "application/xml",
    fetchedAt: new Date("2026-07-28T15:00:00.000Z"),
    cache: { etag: null, lastModified: null },
    next: null,
  };
}

describe("GoogleNewsClient.buildUrl", () => {
  it("usa o endpoint pt-BR e escapa a query", () => {
    const url = GoogleNewsClient.buildUrl("Oeiras Piauí");
    expect(url).toContain("https://news.google.com/rss/search?q=");
    expect(url).toContain("hl=pt-BR");
    expect(url).toContain("gl=BR");
    expect(url).toContain("ceid=BR%3Apt-419");
    expect(url).toContain(encodeURIComponent("Oeiras Piauí"));
  });
});

describe("GoogleNewsAdapter.discover", () => {
  it("emite uma tarefa por selector efetivo — a união das queries dos perfis", () => {
    const result = adapter.discover(config, ["Oeiras Piauí", "Oeiras PI"], "r1");
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value).toHaveLength(2);
    expect(result.value.map((t) => t.selector)).toEqual(["Oeiras Piauí", "Oeiras PI"]);
    expect(result.value.every((t) => t.page === 0 && t.runId === "r1")).toBe(true);
  });

  it("ignora selector vazio ou só de espaço", () => {
    const result = adapter.discover(config, ["Oeiras Piauí", "   ", ""], "r1");
    if (!result.isOk()) throw new Error("esperava ok");
    expect(result.value).toHaveLength(1);
  });

  it("reprova quando nenhuma query sobra — não existe busca sem termo", () => {
    const result = adapter.discover(config, ["  "], "r1");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("INVALID_SOURCE_CONFIG");
  });
});

describe("GoogleNewsAdapter.parse", () => {
  it("transforma a fixture real em Articles completos", () => {
    const result = adapter.parse(batch("oeiras-piaui.xml"));
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value.length).toBeGreaterThan(0);
    const article = result.value[0];
    if (!article) return;

    expect(article.props.source.id).toBe("google-news");
    expect(article.props.source.externalId.length).toBeGreaterThan(0);
    expect(article.props.title.length).toBeGreaterThan(0);
    expect(article.id).toHaveLength(64);
    expect(article.fingerprint).toHaveLength(64);
    expect(article.contentHash).toHaveLength(64);
    // O resumo não pode carregar HTML: envenenaria hash e regra de match.
    expect(article.props.summary).not.toContain("<");
  });

  it("é PURO: duas passagens sobre o mesmo payload dão os mesmos hashes", () => {
    const primeira = adapter.parse(batch("oeiras-piaui.xml"));
    const segunda = adapter.parse(batch("oeiras-piaui.xml"));
    if (!primeira.isOk() || !segunda.isOk()) throw new Error("esperava ok");

    expect(segunda.value.map((a) => a.contentHash)).toEqual(
      primeira.value.map((a) => a.contentHash),
    );
  });

  it("não usa o relógio: fetchedAt diferente não muda o contentHash", () => {
    const a = adapter.parse(batch("oeiras-piaui.xml"));
    const b = adapter.parse({ ...batch("oeiras-piaui.xml"), fetchedAt: new Date("2027-01-01") });
    if (!a.isOk() || !b.isOk()) throw new Error("esperava ok");

    expect(b.value.map((x) => x.contentHash)).toEqual(a.value.map((x) => x.contentHash));
  });

  it("feed sem resultado devolve lista vazia, não erro", () => {
    const result = adapter.parse(batch("vazio.xml"));
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });

  it("traduz XML quebrado em SOURCE_CONTRACT_DRIFT, que NÃO é retentável", () => {
    const result = adapter.parse({ ...batch("vazio.xml"), payload: "<rss><channel></rss" });
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;

    expect(result.error.code).toBe("SOURCE_CONTRACT_DRIFT");
    expect(result.error.retryable).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
pnpm vitest run packages/adapters/src/google-news/google-news.adapter.spec.ts
```

Esperado: FAIL — módulo não resolvido.

- [ ] **Step 3: Escrever o client (camada 1)**

`packages/adapters/src/google-news/google-news.client.ts`:

```ts
import type { CircuitBreaker } from "../http/circuit-breaker.js";
import type { HttpClient, HttpResponse } from "../http/http-client.js";

/**
 * Camada 1 — só transporte. Não conhece `Article` nem `BusinessError`.
 *
 * A premissa do projeto mora nesta URL: o Google News expõe BUSCA em RSS, com
 * query arbitrária, sem chave e sem quota. Um adapter cobre jornais, blogs
 * indexados, G1 e o próprio Google Notícias — porque tudo isso já está indexado
 * ali.
 */
export interface GoogleNewsSearchInput {
  readonly query: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export class GoogleNewsClient {
  constructor(
    private readonly http: HttpClient,
    private readonly breaker: CircuitBreaker,
  ) {}

  static buildUrl(query: string): string {
    const params = new URLSearchParams({
      q: query,
      hl: "pt-BR",
      gl: "BR",
      ceid: "BR:pt-419",
    });
    return `https://news.google.com/rss/search?${params.toString()}`;
  }

  async search(input: GoogleNewsSearchInput): Promise<HttpResponse> {
    return this.breaker.execute(() =>
      this.http.get({
        url: GoogleNewsClient.buildUrl(input.query),
        etag: input.etag,
        lastModified: input.lastModified,
      }),
    );
  }
}
```

- [ ] **Step 4: Escrever o mapper (camada 2 — o ACL)**

`packages/adapters/src/google-news/google-news.mapper.ts`:

```ts
import { Article } from "@news-radar/core";
import type { FeedItem } from "../feed/feed.parser.js";

export const GOOGLE_NEWS_SOURCE_ID = "google-news";

/**
 * `FeedItem` -> `Article`. É aqui que o formato da fonte para de existir: o
 * core nunca vê `pubDate`, `guid` nem `<source>`.
 *
 * O `<link>` é o redirect do Google (`news.google.com/rss/articles/CBMi...`),
 * não a URL do veículo. Notificamos com ele mesmo: resolver o redirect custaria
 * uma requisição HTTP por item, e o link abre no veículo do mesmo jeito.
 * Ver `docs/validacao-google-news.md`.
 */
export function toArticle(item: FeedItem, fetchedAt: Date): Article {
  return Article.create({
    source: {
      id: GOOGLE_NEWS_SOURCE_ID,
      externalId: item.guid,
      url: item.link,
    },
    // Título CRU, sufixo de veículo incluso: é o que se exibe. O sufixo só é
    // removido dentro do fingerprint, por `normalizeHeadline`.
    title: item.title,
    summary: item.description,
    publisher: item.sourceName ?? "",
    publishedAt: parsePubDate(item.pubDate),
    seenAt: fetchedAt,
  });
}

/**
 * `pubDate` nem sempre existe e nem sempre é a data real de publicação em feed
 * agregado. Data ilegível vira `null` em vez de `Invalid Date` — que
 * envenenaria o `contentHash` com `"Invalid Date"` e o tornaria instável.
 */
function parsePubDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
```

- [ ] **Step 5: Escrever o adapter**

`packages/adapters/src/google-news/google-news.adapter.ts`:

```ts
import {
  type Article,
  type BusinessError,
  type CacheMetadata,
  type FetchOutcome,
  type FetchPolicy,
  type FetchTask,
  InvalidSourceConfig,
  NewsSourcePort,
  type RawBatch,
  Result,
  type SourceConfig,
  SourceContractDrift,
  type SourceMode,
  SourceUnavailable,
} from "@news-radar/core";
import { parseRssFeed } from "../feed/feed.parser.js";
import { NOT_MODIFIED, SourceHttpError } from "../http/http-client.js";
import type { GoogleNewsClient } from "./google-news.client.js";
import { GOOGLE_NEWS_SOURCE_ID, toArticle } from "./google-news.mapper.js";

/**
 * Camada 2 — o ACL. Implementa a porta usando o client, traduz erro de
 * transporte em `BusinessError` e mantém o formato do Google News contido aqui.
 */
export class GoogleNewsAdapter extends NewsSourcePort {
  readonly id = GOOGLE_NEWS_SOURCE_ID;

  /** A query vem do PERFIL, não da config da fonte. */
  readonly mode: SourceMode = "query-driven";

  readonly policy: FetchPolicy = {
    minDelayMs: 1_000,
    maxAttempts: 3,
    // É o feed RSS público do próprio produto, não crawling de página.
    respectsRobotsTxt: false,
    requiresAttribution: false,
  };

  constructor(private readonly client: GoogleNewsClient) {
    super();
  }

  /**
   * Uma tarefa por query. O use-case já entregou a UNIÃO das queries de todos
   * os perfis habilitados, então dois perfis pedindo "Oeiras Piauí" produzem
   * uma busca só.
   */
  discover(
    _config: SourceConfig,
    selectors: readonly string[],
    runId: string,
  ): Result<FetchTask[], BusinessError> {
    const queries = selectors.map((s) => s.trim()).filter((s) => s.length > 0);

    if (queries.length === 0) {
      return Result.err(
        InvalidSourceConfig.create(this.id, "nenhuma query: a fonte é de busca, exige termo"),
      );
    }

    return Result.ok(
      queries.map((query) => ({
        sourceId: this.id,
        selector: query,
        page: 0,
        runId,
        params: {},
      })),
    );
  }

  async fetch(task: FetchTask, cache: CacheMetadata): Promise<Result<FetchOutcome, BusinessError>> {
    try {
      const response = await this.client.search({
        query: task.selector,
        etag: cache.etag,
        lastModified: cache.lastModified,
      });

      if (response.status === NOT_MODIFIED) {
        return Result.ok({ kind: "not-modified", task });
      }

      const batch: RawBatch = {
        task,
        payload: response.body,
        contentType: response.contentType || "application/xml",
        fetchedAt: new Date(),
        cache: { etag: response.etag, lastModified: response.lastModified },
        // O feed devolve a janela inteira sem cursor: não há continuação, e não
        // há backfill. A cobertura depende da frequência do agendador.
        next: null,
      };

      return Result.ok({ kind: "fetched", batch });
    } catch (error) {
      return Result.err(this.translateError(error));
    }
  }

  parse(batch: RawBatch): Result<Article[], BusinessError> {
    try {
      const items = parseRssFeed(batch.payload);
      return Result.ok(items.map((item) => toArticle(item, batch.fetchedAt)));
    } catch (error) {
      return Result.err(
        SourceContractDrift.create(
          this.id,
          error instanceof Error ? error.message : String(error),
          batch.payload.slice(0, 200),
        ),
      );
    }
  }

  /** Erro de transporte -> erro de negócio. Único ponto de tradução. */
  private translateError(error: unknown): BusinessError {
    if (error instanceof SourceHttpError) {
      if (error.isRetryable) {
        return SourceUnavailable.create(this.id, {
          status: error.status,
          message: error.message,
        });
      }
      // 4xx: a fonte está viva e recusou. Retentar devolve o mesmo — o que
      // resolve é corrigir a requisição.
      return SourceContractDrift.create(
        this.id,
        `resposta ${error.status}: ${error.message}`,
        error.body,
      );
    }

    return SourceUnavailable.create(this.id, {
      status: null,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
```

- [ ] **Step 6: Exportar do barrel e rodar**

Acrescentar ao topo de `packages/adapters/src/index.ts`:

```ts
export { GoogleNewsAdapter } from "./google-news/google-news.adapter.js";
export { GoogleNewsClient, type GoogleNewsSearchInput } from "./google-news/google-news.client.js";
export { GOOGLE_NEWS_SOURCE_ID, toArticle } from "./google-news/google-news.mapper.js";
```

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Esperado: 10 testes novos PASS, suíte inteira verde.

- [ ] **Step 7: Commit**

```bash
git add packages/adapters
git commit -m "feat(adapters): adapter do Google News RSS com testes contra fixture"
```

---

### Task 8: Use-cases de ingestão — discover, fetch, normalize

O `discover` é o único que muda de verdade em relação à base: ele precisa
resolver os **dois modos de fonte** e calcular a união das queries.

**Files:**
- Create: `packages/core/src/contexts/news/use-cases/discover-source-work.use-case.ts`
- Create: `packages/core/src/contexts/news/use-cases/fetch-source-batch.use-case.ts`
- Create: `packages/core/src/contexts/news/use-cases/normalize-and-store.use-case.ts`
- Modify: `packages/core/src/contexts/news/index.ts`
- Test: `packages/core/src/contexts/news/use-cases/discover-source-work.use-case.spec.ts`

**Interfaces:**
- Consumes: `SourceCatalog`, `SourceRegistry`, `ProfileRegistry`, `WorkQueue`,
  `FetchCacheStore`, `RawStorage`, `ArticleRepository` (Tasks 6a/6b).
- Produces:
  - `DiscoverSourceWorkUseCase` — `constructor(sources: SourceRegistry, profiles: ProfileRegistry,
    catalog: SourceCatalog, queue: WorkQueue)`;
    `execute({ runId, correlationId, onlySourceId? }): Promise<Result<{ tasksEnqueued: number;
    queries: readonly string[]; skipped: ReadonlyArray<{ sourceId: string; reason: string }> }, BusinessError>>`
  - `FetchSourceBatchUseCase` — `constructor(catalog, cache, raw, queue)`;
    `execute({ task, correlationId }): Promise<Result<{ status: "stored" | "not-modified";
    hasNextPage: boolean }, BusinessError>>`
  - `NormalizeAndStoreUseCase` — `constructor(catalog, raw, repository)`;
    `execute({ task, ref, fetchedAt }): Promise<Result<{ parsed: number; created: number;
    updated: number; unchanged: number; changed: readonly Article[] }, BusinessError>>`

- [ ] **Step 1: Escrever o teste do discover**

`packages/core/src/contexts/news/use-cases/discover-source-work.use-case.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { BusinessError } from "../../../commons/business-error.js";
import { Result } from "../../../commons/result.js";
import type { AlertProfile } from "../domain/entities/alert-profile.js";
import type { Article } from "../domain/entities/article.js";
import {
  type CacheMetadata,
  type FetchOutcome,
  type FetchPolicy,
  type FetchTask,
  NewsSourcePort,
  type RawBatch,
  type SourceConfig,
  type SourceMode,
} from "../domain/ports/news-source.port.js";
import {
  type NormalizeMessage,
  type NotifyTask,
  ProfileRegistry,
  SourceRegistry,
  WorkQueue,
} from "../domain/ports/repositories.port.js";
import { SourceCatalog } from "../domain/source-catalog.js";
import { DiscoverSourceWorkUseCase } from "./discover-source-work.use-case.js";

class FonteFake extends NewsSourcePort {
  readonly policy: FetchPolicy = {
    minDelayMs: 0,
    maxAttempts: 1,
    respectsRobotsTxt: false,
    requiresAttribution: false,
  };
  /** O que o use-case entregou — é o que o teste inspeciona. */
  recebidos: string[][] = [];

  constructor(
    readonly id: string,
    readonly mode: SourceMode,
    private readonly falha = false,
  ) {
    super();
  }

  discover(
    _config: SourceConfig,
    selectors: readonly string[],
    runId: string,
  ): Result<FetchTask[], BusinessError> {
    this.recebidos.push([...selectors]);
    if (this.falha) {
      return Result.err({ message: "fonte quebrada" } as unknown as BusinessError);
    }
    return Result.ok(
      selectors.map((selector) => ({
        sourceId: this.id,
        selector,
        page: 0,
        runId,
        params: {},
      })),
    );
  }
  async fetch(_t: FetchTask, _c: CacheMetadata): Promise<Result<FetchOutcome, BusinessError>> {
    throw new Error("não usado");
  }
  parse(_b: RawBatch): Result<Article[], BusinessError> {
    throw new Error("não usado");
  }
}

class RegistroFake extends SourceRegistry {
  constructor(private readonly configs: SourceConfig[]) {
    super();
  }
  async listEnabled(): Promise<SourceConfig[]> {
    return this.configs;
  }
}

class PerfisFake extends ProfileRegistry {
  constructor(private readonly profiles: AlertProfile[]) {
    super();
  }
  async listEnabled(): Promise<AlertProfile[]> {
    return this.profiles;
  }
  async get(profileId: string): Promise<AlertProfile | null> {
    return this.profiles.find((p) => p.profileId === profileId) ?? null;
  }
}

class FilaFake extends WorkQueue {
  readonly fetchTasks: FetchTask[] = [];
  async enqueueFetch(tasks: readonly FetchTask[]): Promise<void> {
    this.fetchTasks.push(...tasks);
  }
  async enqueueNormalize(_m: readonly NormalizeMessage[]): Promise<void> {}
  async enqueueNotify(_t: readonly NotifyTask[]): Promise<void> {}
}

function perfil(profileId: string, queries: string[]): AlertProfile {
  return {
    profileId,
    name: profileId,
    queries,
    rule: { required: [], boost: [], exclude: [], minScore: 0 },
    destinations: [{ kind: "telegram", chatId: "1" }],
    enabled: true,
  };
}

const QUERY_DRIVEN: SourceConfig = {
  sourceId: "google-news",
  mode: "query-driven",
  selector: "",
  enabled: true,
  params: {},
};
const FEED_DRIVEN: SourceConfig = {
  sourceId: "rss-g1",
  mode: "feed-driven",
  selector: "https://g1.globo.com/rss/g1/pi/piaui/",
  enabled: true,
  params: {},
};

describe("DiscoverSourceWorkUseCase", () => {
  it("dá à fonte query-driven a UNIÃO das queries — query compartilhada não busca duas vezes", async () => {
    const fonte = new FonteFake("google-news", "query-driven");
    const fila = new FilaFake();
    const useCase = new DiscoverSourceWorkUseCase(
      new RegistroFake([QUERY_DRIVEN]),
      new PerfisFake([perfil("oeiras-pi", ["Oeiras Piauí", "Oeiras PI"]), perfil("outro", ["Oeiras Piauí"])]),
      new SourceCatalog([fonte]),
      fila,
    );

    const result = await useCase.execute({ runId: "r1", correlationId: "c1" });
    if (!result.isOk()) throw new Error("esperava ok");

    expect(fonte.recebidos[0]).toEqual(["Oeiras Piauí", "Oeiras PI"]);
    expect(result.value.tasksEnqueued).toBe(2);
    expect(fila.fetchTasks).toHaveLength(2);
  });

  it("dá à fonte feed-driven o selector da CONFIG, ignorando queries de perfil", async () => {
    const fonte = new FonteFake("rss-g1", "feed-driven");
    const useCase = new DiscoverSourceWorkUseCase(
      new RegistroFake([FEED_DRIVEN]),
      new PerfisFake([perfil("oeiras-pi", ["Oeiras Piauí"])]),
      new SourceCatalog([fonte]),
      new FilaFake(),
    );

    await useCase.execute({ runId: "r1", correlationId: "c1" });
    expect(fonte.recebidos[0]).toEqual(["https://g1.globo.com/rss/g1/pi/piaui/"]);
  });

  it("uma fonte que falha vai para skipped e NÃO derruba as outras", async () => {
    const boa = new FonteFake("rss-g1", "feed-driven");
    const useCase = new DiscoverSourceWorkUseCase(
      new RegistroFake([QUERY_DRIVEN, FEED_DRIVEN]),
      new PerfisFake([perfil("oeiras-pi", ["Oeiras Piauí"])]),
      new SourceCatalog([new FonteFake("google-news", "query-driven", true), boa]),
      new FilaFake(),
    );

    const result = await useCase.execute({ runId: "r1", correlationId: "c1" });
    if (!result.isOk()) throw new Error("esperava ok");

    expect(result.value.skipped).toHaveLength(1);
    expect(result.value.skipped[0]?.sourceId).toBe("google-news");
    expect(result.value.tasksEnqueued).toBe(1);
  });

  it("fonte sem adapter registrado também só é pulada", async () => {
    const useCase = new DiscoverSourceWorkUseCase(
      new RegistroFake([{ ...QUERY_DRIVEN, sourceId: "tiktok" }]),
      new PerfisFake([perfil("oeiras-pi", ["Oeiras Piauí"])]),
      new SourceCatalog([]),
      new FilaFake(),
    );

    const result = await useCase.execute({ runId: "r1", correlationId: "c1" });
    if (!result.isOk()) throw new Error("esperava ok");
    expect(result.value.skipped[0]?.sourceId).toBe("tiktok");
  });

  it("sem perfil habilitado, a fonte query-driven não gera trabalho", async () => {
    const fonte = new FonteFake("google-news", "query-driven");
    const useCase = new DiscoverSourceWorkUseCase(
      new RegistroFake([QUERY_DRIVEN]),
      new PerfisFake([]),
      new SourceCatalog([fonte]),
      new FilaFake(),
    );

    const result = await useCase.execute({ runId: "r1", correlationId: "c1" });
    if (!result.isOk()) throw new Error("esperava ok");

    expect(result.value.tasksEnqueued).toBe(0);
    expect(fonte.recebidos).toHaveLength(0);
  });

  it("onlySourceId restringe a rodada", async () => {
    const google = new FonteFake("google-news", "query-driven");
    const g1 = new FonteFake("rss-g1", "feed-driven");
    const useCase = new DiscoverSourceWorkUseCase(
      new RegistroFake([QUERY_DRIVEN, FEED_DRIVEN]),
      new PerfisFake([perfil("oeiras-pi", ["Oeiras Piauí"])]),
      new SourceCatalog([google, g1]),
      new FilaFake(),
    );

    await useCase.execute({ runId: "r1", correlationId: "c1", onlySourceId: "rss-g1" });
    expect(google.recebidos).toHaveLength(0);
    expect(g1.recebidos).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
pnpm vitest run packages/core/src/contexts/news/use-cases/discover-source-work.use-case.spec.ts
```

Esperado: FAIL — módulo não resolvido.

- [ ] **Step 3: Escrever `discover-source-work.use-case.ts`**

```ts
import type { BusinessError } from "../../../commons/business-error.js";
import { Result } from "../../../commons/result.js";
import type { FetchTask } from "../domain/ports/news-source.port.js";
import type {
  ProfileRegistry,
  SourceRegistry,
  WorkQueue,
} from "../domain/ports/repositories.port.js";
import type { SourceCatalog } from "../domain/source-catalog.js";

export type DiscoverSourceWorkInput = {
  /** Correlaciona a rodada inteira. */
  readonly runId: string;
  readonly correlationId: string;
  /** Restringe a rodada a uma fonte. Vazio = todas as habilitadas. */
  readonly onlySourceId?: string;
};

export type DiscoverSourceWorkOutput = {
  readonly tasksEnqueued: number;
  /** A união efetivamente buscada — útil para conferir que não houve duplicata. */
  readonly queries: readonly string[];
  /** Fontes que falharam no discover, sem derrubar as outras. */
  readonly skipped: ReadonlyArray<{ sourceId: string; reason: string }>;
};

/**
 * Ponto de entrada da rodada.
 *
 * A diferença central em relação ao job-radar está aqui: numa fonte
 * query-driven o selector vem do PERFIL, não da config. Dois perfis pedindo
 * "Oeiras Piauí" têm que virar UMA busca, então o use-case calcula a união das
 * queries de todos os perfis habilitados antes de chamar o adapter.
 *
 * O `FetchTask` resultante nunca carrega `profileId`: o casamento acontece só
 * no `match`, contra todos os perfis.
 */
export class DiscoverSourceWorkUseCase {
  constructor(
    private readonly sources: SourceRegistry,
    private readonly profiles: ProfileRegistry,
    private readonly catalog: SourceCatalog,
    private readonly queue: WorkQueue,
  ) {}

  async execute(
    input: DiscoverSourceWorkInput,
  ): Promise<Result<DiscoverSourceWorkOutput, BusinessError>> {
    const configs = await this.sources.listEnabled();
    const selected = input.onlySourceId
      ? configs.filter((config) => config.sourceId === input.onlySourceId)
      : configs;

    const queries = await this.unionOfQueries();

    const tasks: FetchTask[] = [];
    const skipped: Array<{ sourceId: string; reason: string }> = [];

    for (const config of selected) {
      const source = this.catalog.get(config.sourceId);
      if (source.isErr()) {
        skipped.push({ sourceId: config.sourceId, reason: source.error.message });
        continue;
      }

      const selectors =
        source.value.mode === "query-driven" ? queries : [config.selector];

      // Fonte de busca sem nenhuma query inscrita não tem o que fazer.
      if (selectors.length === 0) continue;

      const discovered = source.value.discover(config, selectors, input.runId);
      if (discovered.isErr()) {
        skipped.push({ sourceId: config.sourceId, reason: discovered.error.message });
        continue;
      }

      tasks.push(...discovered.value);
    }

    if (tasks.length > 0) {
      await this.queue.enqueueFetch(tasks, input.correlationId);
    }

    return Result.ok({ tasksEnqueued: tasks.length, queries, skipped });
  }

  /** Set preserva a ordem de inserção: a saída é estável entre rodadas. */
  private async unionOfQueries(): Promise<string[]> {
    const profiles = await this.profiles.listEnabled();
    const union = new Set<string>();

    for (const profile of profiles) {
      for (const query of profile.queries) {
        const trimmed = query.trim();
        if (trimmed.length > 0) union.add(trimmed);
      }
    }

    return [...union];
  }
}
```

- [ ] **Step 4: Escrever `fetch-source-batch.use-case.ts`**

Copiar `/Users/mpgxc/mpgxcx/packages/core/src/contexts/ingestion/use-cases/fetch-source-batch.use-case.ts`
**sem mudança estrutural**. Só ajustar os imports (`../domain/ports/news-source.port.js`,
`../domain/ports/repositories.port.js`) e trocar o comentário do claim-check pelo
motivo daqui:

```ts
/**
 * Busca uma página, grava o bruto na zona raw e passa adiante só o ponteiro.
 *
 * A zona raw importa mais aqui do que no job-radar: o feed do Google News só
 * mostra a janela corrente. O que saiu dela sumiu da fonte — e o payload
 * guardado é a única forma de reprocessar com um parser corrigido.
 */
```

- [ ] **Step 5: Escrever `normalize-and-store.use-case.ts`**

Partir de `/Users/mpgxc/mpgxcx/packages/core/src/contexts/ingestion/use-cases/normalize-and-store.use-case.ts`
com **uma mudança de contrato**: além da contagem, devolver os artigos que
mudaram — é o que alimenta o `match` no runner local (na AWS quem faz esse papel
é o Stream do DynamoDB).

```ts
export type NormalizeAndStoreOutput = {
  readonly parsed: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  /**
   * Só o que foi `created` ou `updated`.
   *
   * É o mesmo delta que o DynamoDB Stream entrega no Plano B; devolvê-lo aqui
   * permite ao runner local encadear o `match` sem simular Stream nenhum, e
   * deixa explícito no tipo que o `match` roda sobre o DELTA, nunca sobre o
   * catálogo inteiro.
   */
  readonly changed: readonly Article[];
};
```

No corpo, acumular num array:

```ts
    const changed: Article[] = [];
    const tally: Record<UpsertOutcome, number> = { created: 0, updated: 0, unchanged: 0 };

    for (const article of parsed.value) {
      const outcome = await this.repository.upsert(article, input.task.runId);
      tally[outcome] += 1;
      if (outcome !== "unchanged") changed.push(article);
    }
```

- [ ] **Step 6: Exportar do barrel, rodar e commitar**

Acrescentar os três use-cases a `packages/core/src/contexts/news/index.ts`.

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Esperado: 6 testes novos PASS, suíte inteira verde.

```bash
git add packages/core
git commit -m "feat(news): use-cases de descoberta, fetch e normalização"
```

---

### Task 9: Use-cases novos — `match` e `notify`

Os dois estágios que não existem no job-radar. O `notify` é onde mora a decisão
que define se o produto presta.

**Files:**
- Create: `packages/core/src/contexts/news/use-cases/match-article.use-case.ts`
- Create: `packages/core/src/contexts/news/use-cases/notify-match.use-case.ts`
- Modify: `packages/core/src/contexts/news/index.ts`
- Test: `packages/core/src/contexts/news/use-cases/notify-match.use-case.spec.ts`

**Interfaces:**
- Consumes: `evaluateMatch` (Task 5), `ProfileRegistry`, `WorkQueue`, `NotificationLog`,
  `NotifierPort`, `NotifyTask` (Task 6b), `NotificationFailed` (Task 6a).
- Produces:
  - `MatchArticleUseCase` — `constructor(profiles: ProfileRegistry, queue: WorkQueue)`;
    `execute({ article, correlationId }): Promise<Result<{ evaluated: number;
    matched: ReadonlyArray<{ profileId: string; score: number }> }, BusinessError>>`
  - `NotifyMatchUseCase` — `constructor(profiles: ProfileRegistry, log: NotificationLog,
    notifiers: readonly NotifierPort[])`;
    `execute({ task }): Promise<Result<{ sent: boolean; reason: "sent" | "duplicate" |
    "profile-missing" | "no-destination" }, BusinessError>>`

- [ ] **Step 1: Escrever `match-article.use-case.ts`**

```ts
import type { BusinessError } from "../../../commons/business-error.js";
import { Result } from "../../../commons/result.js";
import type { Article } from "../domain/entities/article.js";
import type { NotifyTask, ProfileRegistry, WorkQueue } from "../domain/ports/repositories.port.js";
import { evaluateMatch } from "../domain/value-objects/match-rule.js";

export type MatchArticleInput = {
  readonly article: Article;
  readonly correlationId: string;
};

export type MatchArticleOutput = {
  readonly evaluated: number;
  readonly matched: ReadonlyArray<{ profileId: string; score: number }>;
};

/**
 * Casa UM artigo contra todos os perfis habilitados.
 *
 * Roda sobre o DELTA, nunca sobre o catálogo: quem chama já filtrou por
 * `isContentChange()` (o Stream, no Plano B) ou pelo `changed` do
 * `NormalizeAndStore` (o runner local). Sem esse filtro, o custo cresceria com
 * o tamanho do catálogo em vez de com o volume de notícia nova — o oposto do
 * que a arquitetura persegue.
 *
 * Um artigo pode casar com vários perfis; cada match vira uma tarefa de notify
 * própria, porque o dedupe é por perfil.
 */
export class MatchArticleUseCase {
  constructor(
    private readonly profiles: ProfileRegistry,
    private readonly queue: WorkQueue,
  ) {}

  async execute(input: MatchArticleInput): Promise<Result<MatchArticleOutput, BusinessError>> {
    const profiles = await this.profiles.listEnabled();
    const { article } = input;

    const matched: Array<{ profileId: string; score: number }> = [];
    const tasks: NotifyTask[] = [];

    for (const profile of profiles) {
      const verdict = evaluateMatch(article, profile.rule);
      if (!verdict.matched) continue;

      matched.push({ profileId: profile.profileId, score: verdict.score });
      tasks.push({
        profileId: profile.profileId,
        articleId: article.id,
        fingerprint: article.fingerprint,
        title: article.props.title,
        url: article.props.source.url,
        publisher: article.props.publisher,
        publishedAt: article.props.publishedAt?.toISOString() ?? null,
        score: verdict.score,
      });
    }

    if (tasks.length > 0) {
      await this.queue.enqueueNotify(tasks, input.correlationId);
    }

    return Result.ok({ evaluated: profiles.length, matched });
  }
}
```

- [ ] **Step 2: Escrever o teste do notify**

`packages/core/src/contexts/news/use-cases/notify-match.use-case.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { BusinessError } from "../../../commons/business-error.js";
import { Result } from "../../../commons/result.js";
import type { AlertDestination, AlertProfile } from "../domain/entities/alert-profile.js";
import { NotificationFailed } from "../domain/news.errors.js";
import type { Notification } from "../domain/ports/notifier.port.js";
import { NotifierPort } from "../domain/ports/notifier.port.js";
import {
  NotificationLog,
  ProfileRegistry,
  type NotifyTask,
} from "../domain/ports/repositories.port.js";
import { NotifyMatchUseCase } from "./notify-match.use-case.js";

/** Log condicional em memória — o mesmo contrato do PutItem com attribute_not_exists. */
class LogFake extends NotificationLog {
  readonly chaves = new Set<string>();
  async claim(profileId: string, fingerprint: string): Promise<boolean> {
    const key = `${profileId}#${fingerprint}`;
    if (this.chaves.has(key)) return false;
    this.chaves.add(key);
    return true;
  }
  async release(profileId: string, fingerprint: string): Promise<void> {
    this.chaves.delete(`${profileId}#${fingerprint}`);
  }
}

class NotifierFake extends NotifierPort {
  readonly kind = "telegram";
  readonly enviadas: Notification[] = [];
  constructor(private readonly falha = false) {
    super();
  }
  async send(
    _destination: AlertDestination,
    notification: Notification,
  ): Promise<Result<void, BusinessError>> {
    if (this.falha) {
      return Result.err(NotificationFailed.create("telegram", { status: 503, message: "fora" }));
    }
    this.enviadas.push(notification);
    return Result.ok(undefined);
  }
}

class PerfisFake extends ProfileRegistry {
  constructor(private readonly profiles: AlertProfile[]) {
    super();
  }
  async listEnabled(): Promise<AlertProfile[]> {
    return this.profiles;
  }
  async get(profileId: string): Promise<AlertProfile | null> {
    return this.profiles.find((p) => p.profileId === profileId) ?? null;
  }
}

const PERFIL: AlertProfile = {
  profileId: "oeiras-pi",
  name: "Oeiras · Piauí",
  queries: ["Oeiras Piauí"],
  rule: { required: ["oeiras"], boost: ["piauí"], exclude: [], minScore: 1 },
  destinations: [{ kind: "telegram", chatId: "123" }],
  enabled: true,
};

function tarefa(overrides: Partial<NotifyTask> = {}): NotifyTask {
  return {
    profileId: "oeiras-pi",
    articleId: "artigo-g1",
    fingerprint: "fp-mesma-materia",
    title: "Prefeitura de Oeiras anuncia obras - G1",
    url: "https://news.google.com/x",
    publisher: "G1",
    publishedAt: "2026-07-28T12:00:00.000Z",
    score: 1,
    ...overrides,
  };
}

describe("NotifyMatchUseCase", () => {
  it("envia na primeira vez e registra o claim", async () => {
    const log = new LogFake();
    const notifier = new NotifierFake();
    const useCase = new NotifyMatchUseCase(new PerfisFake([PERFIL]), log, [notifier]);

    const result = await useCase.execute({ task: tarefa() });
    if (!result.isOk()) throw new Error("esperava ok");

    expect(result.value.sent).toBe(true);
    expect(notifier.enviadas).toHaveLength(1);
    expect(notifier.enviadas[0]?.profileName).toBe("Oeiras · Piauí");
  });

  it("SINDICAÇÃO: mesma pauta em veículos diferentes = um push só", async () => {
    const log = new LogFake();
    const notifier = new NotifierFake();
    const useCase = new NotifyMatchUseCase(new PerfisFake([PERFIL]), log, [notifier]);

    await useCase.execute({ task: tarefa({ articleId: "artigo-g1", publisher: "G1" }) });
    const segundo = await useCase.execute({
      // id DIFERENTE, fingerprint IGUAL — é exatamente o caso da sindicação.
      task: tarefa({ articleId: "artigo-cidadeverde", publisher: "Cidadeverde.com" }),
    });

    if (!segundo.isOk()) throw new Error("esperava ok");
    expect(segundo.value.sent).toBe(false);
    expect(segundo.value.reason).toBe("duplicate");
    expect(notifier.enviadas).toHaveLength(1);
  });

  it("o dedupe é POR PERFIL: dois perfis interessados recebem cada um", async () => {
    const outro: AlertProfile = { ...PERFIL, profileId: "outro", name: "Outro" };
    const notifier = new NotifierFake();
    const useCase = new NotifyMatchUseCase(new PerfisFake([PERFIL, outro]), new LogFake(), [
      notifier,
    ]);

    await useCase.execute({ task: tarefa() });
    await useCase.execute({ task: tarefa({ profileId: "outro" }) });

    expect(notifier.enviadas).toHaveLength(2);
  });

  it("envio que falha LIBERA o claim, para a reentrega poder tentar de novo", async () => {
    const log = new LogFake();
    const useCase = new NotifyMatchUseCase(new PerfisFake([PERFIL]), log, [new NotifierFake(true)]);

    const result = await useCase.execute({ task: tarefa() });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.retryable).toBe(true);

    // Sem o release, a reentrega veria o claim e o alerta se perderia em silêncio.
    expect(log.chaves.size).toBe(0);
  });

  it("depois de liberar o claim, a reentrega envia de verdade", async () => {
    const log = new LogFake();
    await new NotifyMatchUseCase(new PerfisFake([PERFIL]), log, [
      new NotifierFake(true),
    ]).execute({ task: tarefa() });

    const notifier = new NotifierFake();
    const result = await new NotifyMatchUseCase(new PerfisFake([PERFIL]), log, [notifier]).execute({
      task: tarefa(),
    });

    if (!result.isOk()) throw new Error("esperava ok");
    expect(result.value.sent).toBe(true);
    expect(notifier.enviadas).toHaveLength(1);
  });

  it("perfil sumido do registro não é erro retentável, só não envia", async () => {
    const useCase = new NotifyMatchUseCase(new PerfisFake([]), new LogFake(), [new NotifierFake()]);
    const result = await useCase.execute({ task: tarefa() });

    if (!result.isOk()) throw new Error("esperava ok");
    expect(result.value.sent).toBe(false);
    expect(result.value.reason).toBe("profile-missing");
  });

  it("destino sem notifier registrado não trava o pipeline", async () => {
    const useCase = new NotifyMatchUseCase(new PerfisFake([PERFIL]), new LogFake(), []);
    const result = await useCase.execute({ task: tarefa() });

    if (!result.isOk()) throw new Error("esperava ok");
    expect(result.value.reason).toBe("no-destination");
  });
});
```

- [ ] **Step 3: Rodar e confirmar que falha**

```bash
pnpm vitest run packages/core/src/contexts/news/use-cases/notify-match.use-case.spec.ts
```

Esperado: FAIL — módulo não resolvido.

- [ ] **Step 4: Escrever `notify-match.use-case.ts`**

```ts
import type { BusinessError } from "../../../commons/business-error.js";
import { Result } from "../../../commons/result.js";
import type { NotifierPort } from "../domain/ports/notifier.port.js";
import type { NotificationLog, NotifyTask, ProfileRegistry } from "../domain/ports/repositories.port.js";

export type NotifyMatchInput = {
  readonly task: NotifyTask;
};

export type NotifyMatchOutput = {
  readonly sent: boolean;
  readonly reason: "sent" | "duplicate" | "profile-missing" | "no-destination";
};

/**
 * O último estágio — e a peça que decide se o produto presta.
 *
 * O dedupe é por `(profileId, fingerprint)` e NÃO por `(profileId, articleId)`.
 * Deduplicar por id é a falha clássica: a mesma pauta republicada por cinco
 * veículos tem cinco ids e um fingerprint só, e o usuário levaria cinco push.
 *
 * A garantia vem do `claim` — uma escrita condicional no banco, não um `if`
 * aqui — e cobre três casos de uma vez: sindicação, replay de payload antigo e
 * reentrega do SQS depois de falha parcial.
 *
 * Ordem: claim ANTES de enviar, e `release` se o envio falhar. Enviar antes de
 * registrar duplicaria na reentrega, que é justamente o que este use-case
 * existe para impedir; registrar sem liberar perderia o alerta em silêncio.
 */
export class NotifyMatchUseCase {
  constructor(
    private readonly profiles: ProfileRegistry,
    private readonly log: NotificationLog,
    private readonly notifiers: readonly NotifierPort[],
  ) {}

  async execute(input: NotifyMatchInput): Promise<Result<NotifyMatchOutput, BusinessError>> {
    const { task } = input;

    const profile = await this.profiles.get(task.profileId);
    // Perfil desligado entre o match e o notify: consome a mensagem sem enviar.
    if (!profile) return Result.ok({ sent: false, reason: "profile-missing" });

    const targets = profile.destinations.flatMap((destination) => {
      const notifier = this.notifiers.find((n) => n.kind === destination.kind);
      return notifier ? [{ destination, notifier }] : [];
    });
    if (targets.length === 0) return Result.ok({ sent: false, reason: "no-destination" });

    const claimed = await this.log.claim(task.profileId, task.fingerprint);
    if (!claimed) return Result.ok({ sent: false, reason: "duplicate" });

    const notification = {
      profileName: profile.name,
      title: task.title,
      publisher: task.publisher,
      url: task.url,
      publishedAt: task.publishedAt,
    };

    for (const { destination, notifier } of targets) {
      const sent = await notifier.send(destination, notification);
      if (sent.isErr()) {
        await this.log.release(task.profileId, task.fingerprint);
        return Result.err(sent.error);
      }
    }

    return Result.ok({ sent: true, reason: "sent" });
  }
}
```

- [ ] **Step 5: Rodar, exportar e commitar**

Acrescentar os dois use-cases a `packages/core/src/contexts/news/index.ts`.

```bash
pnpm test
pnpm typecheck
pnpm lint
```

Esperado: 7 testes novos PASS, suíte inteira verde.

```bash
git add packages/core
git commit -m "feat(news): estágios de match e notify com dedupe por fingerprint"
```

---

### Task 10a: `TelegramNotifier`

**Files:**
- Create: `packages/adapters/src/telegram/telegram.notifier.ts`
- Modify: `packages/adapters/src/index.ts`
- Test: `packages/adapters/src/telegram/telegram.notifier.spec.ts`

**Interfaces:**
- Consumes: `NotifierPort`, `Notification`, `AlertDestination`, `NotificationFailed`, `Result`.
- Produces: `class TelegramNotifier extends NotifierPort` com
  `constructor(options: { botToken: string; fetchImpl?: typeof fetch; timeoutMs?: number })`,
  `readonly kind = "telegram"`; e `formatMessage(notification: Notification): string` exportada.

- [ ] **Step 1: Escrever o teste que falha**

`packages/adapters/src/telegram/telegram.notifier.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatMessage, TelegramNotifier } from "./telegram.notifier.js";

const notificacao = {
  profileName: "Oeiras · Piauí",
  title: "Prefeitura de Oeiras anuncia obras - G1",
  publisher: "G1",
  url: "https://news.google.com/rss/articles/CBMi",
  publishedAt: "2026-07-28T12:00:00.000Z",
};

function fetchFake(status: number, body: unknown) {
  const chamadas: Array<{ url: string; body: unknown }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    chamadas.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, chamadas };
}

describe("formatMessage", () => {
  it("escapa o que quebraria o HTML do Telegram", () => {
    const message = formatMessage({ ...notificacao, title: "Tom & Jerry <b>x</b>" });
    expect(message).toContain("Tom &amp; Jerry &lt;b&gt;x&lt;/b&gt;");
  });

  it("traz perfil, título, veículo e link", () => {
    const message = formatMessage(notificacao);
    expect(message).toContain("Oeiras · Piauí");
    expect(message).toContain("G1");
    expect(message).toContain(notificacao.url);
  });

  it("omite a linha de data quando publishedAt é null", () => {
    expect(formatMessage({ ...notificacao, publishedAt: null })).not.toContain("📅");
  });
});

describe("TelegramNotifier", () => {
  it("chama sendMessage com o chatId do destino", async () => {
    const { impl, chamadas } = fetchFake(200, { ok: true });
    const notifier = new TelegramNotifier({ botToken: "TOKEN", fetchImpl: impl });

    const result = await notifier.send({ kind: "telegram", chatId: "123" }, notificacao);

    expect(result.isOk()).toBe(true);
    expect(chamadas[0]?.url).toBe("https://api.telegram.org/botTOKEN/sendMessage");
    expect((chamadas[0]?.body as { chat_id: string }).chat_id).toBe("123");
  });

  it("5xx vira NOTIFICATION_FAILED retentável", async () => {
    const { impl } = fetchFake(503, { ok: false, description: "fora do ar" });
    const notifier = new TelegramNotifier({ botToken: "T", fetchImpl: impl });

    const result = await notifier.send({ kind: "telegram", chatId: "1" }, notificacao);

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.code).toBe("NOTIFICATION_FAILED");
    expect(result.error.retryable).toBe(true);
  });

  it("429 preserva retry_after nos detalhes do erro", async () => {
    const { impl } = fetchFake(429, {
      ok: false,
      description: "Too Many Requests",
      parameters: { retry_after: 17 },
    });
    const notifier = new TelegramNotifier({ botToken: "T", fetchImpl: impl });

    const result = await notifier.send({ kind: "telegram", chatId: "1" }, notificacao);
    if (!result.isErr()) throw new Error("esperava erro");

    expect((result.error.details as { retryAfterSeconds: number | null }).retryAfterSeconds).toBe(17);
  });

  it("400 (chat_id errado) NÃO é retentável — retentar devolve o mesmo 400", async () => {
    const { impl } = fetchFake(400, { ok: false, description: "chat not found" });
    const notifier = new TelegramNotifier({ botToken: "T", fetchImpl: impl });

    const result = await notifier.send({ kind: "telegram", chatId: "errado" }, notificacao);
    if (!result.isErr()) throw new Error("esperava erro");

    expect(result.error.retryable).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

```bash
pnpm vitest run packages/adapters/src/telegram/telegram.notifier.spec.ts
```

Esperado: FAIL — módulo não resolvido.

- [ ] **Step 3: Escrever o notifier**

`packages/adapters/src/telegram/telegram.notifier.ts`:

```ts
import {
  type AlertDestination,
  type BusinessError,
  InvalidProfileConfig,
  type Notification,
  NotificationFailed,
  NotifierPort,
  Result,
} from "@news-radar/core";

export interface TelegramNotifierOptions {
  readonly botToken: string;
  /** Injetável para o teste não tocar a rede. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface TelegramResponse {
  readonly ok: boolean;
  readonly description?: string;
  readonly parameters?: { readonly retry_after?: number };
}

/**
 * Trocar Telegram por Discord é escrever outra classe com esta forma. O
 * pipeline não muda — ele fala só com `NotifierPort`.
 */
export class TelegramNotifier extends NotifierPort {
  readonly kind = "telegram";

  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: TelegramNotifierOptions) {
    super();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(
    destination: AlertDestination,
    notification: Notification,
  ): Promise<Result<void, BusinessError>> {
    if (!destination.chatId) {
      return Result.err(InvalidProfileConfig.create(notification.profileName, "chatId vazio"));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(
        `https://api.telegram.org/bot${this.options.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            chat_id: destination.chatId,
            text: formatMessage(notification),
            parse_mode: "HTML",
            // O preview duplicaria o título em cada mensagem.
            disable_web_page_preview: true,
          }),
        },
      );

      const payload = (await response.json().catch(() => ({ ok: false }))) as TelegramResponse;
      if (response.ok && payload.ok) return Result.ok(undefined);

      // 4xx que não seja 429 é recusa definitiva (chat errado, bot bloqueado):
      // retentar devolve o mesmo erro, então não vale ocupar a fila.
      const definitivo = response.status >= 400 && response.status < 500 && response.status !== 429;
      const message = payload.description ?? `HTTP ${response.status}`;

      if (definitivo) {
        return Result.err(
          InvalidProfileConfig.create(destination.chatId, `Telegram recusou: ${message}`),
        );
      }

      return Result.err(
        NotificationFailed.create(this.kind, {
          status: response.status,
          message,
          // O 429 do Telegram diz quanto esperar. Respeitar custa um campo.
          retryAfterSeconds: payload.parameters?.retry_after ?? null,
        } as never),
      );
    } catch (error) {
      const isAbort = error instanceof Error && error.name === "AbortError";
      return Result.err(
        NotificationFailed.create(this.kind, {
          status: null,
          message: isAbort
            ? `Timeout de ${this.timeoutMs}ms no envio`
            : error instanceof Error
              ? error.message
              : String(error),
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** HTML simples — o único `parse_mode` do Telegram com escape previsível. */
export function formatMessage(notification: Notification): string {
  const lines = [
    `<b>${escapeHtml(notification.profileName)}</b>`,
    "",
    escapeHtml(notification.title),
  ];

  if (notification.publisher) lines.push(`📰 ${escapeHtml(notification.publisher)}`);
  if (notification.publishedAt) lines.push(`📅 ${escapeHtml(notification.publishedAt)}`);

  lines.push("", notification.url);
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
```

**Nota de implementação:** `NotificationFailed.create` da Task 6a aceita
`{ status, message }`. Amplie a assinatura para
`{ status: number | null; message: string; retryAfterSeconds?: number | null }`
e remova o `as never` acima — o cast está aqui só para marcar o ponto.

- [ ] **Step 4: Rodar, exportar e commitar**

Acrescentar a `packages/adapters/src/index.ts`:

```ts
export { formatMessage, TelegramNotifier } from "./telegram/telegram.notifier.js";
```

```bash
pnpm test
pnpm typecheck
pnpm lint
git add packages
git commit -m "feat(adapters): notifier do Telegram"
```

---

### Task 10b: Ports em memória e o runner `pipeline:local`

O fecho da fatia. Que este comando seja possível é, por si só, o teste da
arquitetura: o pipeline inteiro roda sem saber que a AWS existe.

**Files:**
- Create: `apps/ingestion/package.json`, `apps/ingestion/tsconfig.json`
- Create: `apps/ingestion/src/local/in-memory-ports.ts`
- Create: `apps/ingestion/src/local/run-pipeline.ts`
- Create: `.env.example`
- Modify: `tsconfig.json` (raiz) — acrescentar `{ "path": "./apps/ingestion" }`

**Interfaces:**
- Consumes: todos os use-cases e ports.
- Produces: `InMemorySourceRegistry`, `InMemoryProfileRegistry`, `InMemoryFetchCacheStore`,
  `InMemoryRawStorage`, `InMemoryArticleRepository`, `InMemoryWorkQueue`,
  `InMemoryNotificationLog`, `ConsoleNotifier`.

- [ ] **Step 1: Criar o app**

`apps/ingestion/package.json`:

```json
{
  "name": "@news-radar/ingestion",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@news-radar/adapters": "workspace:*",
    "@news-radar/core": "workspace:*"
  }
}
```

`apps/ingestion/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "./src", "outDir": "./dist" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../../packages/core" }, { "path": "../../packages/adapters" }]
}
```

`.env.example`:

```
# Bot criado no @BotFather. Sem estes dois, o runner imprime no stdout.
TELEGRAM_BOT_TOKEN=
# Seu chat id (fale com o bot e leia em api.telegram.org/bot<TOKEN>/getUpdates).
TELEGRAM_CHAT_ID=
```

```bash
pnpm install
```

- [ ] **Step 2: Escrever `in-memory-ports.ts`**

Partir de `/Users/mpgxc/mpgxcx/apps/ingestion/src/local/in-memory-ports.ts`
(mesma estrutura, `JobPosting` → `Article`, sem `expireNotSeenIn`) e acrescentar
os três novos:

```ts
export class InMemoryProfileRegistry extends ProfileRegistry {
  constructor(private readonly profiles: readonly AlertProfile[]) {
    super();
  }
  async listEnabled(): Promise<AlertProfile[]> {
    return this.profiles.filter((profile) => profile.enabled);
  }
  async get(profileId: string): Promise<AlertProfile | null> {
    return this.profiles.find((profile) => profile.profileId === profileId) ?? null;
  }
}

/**
 * Mesmo contrato do PutItem condicional com `attribute_not_exists(pk)`: o
 * `claim` só devolve true na primeira vez. Se esta implementação e a do
 * DynamoDB divergirem, o runner local para de provar qualquer coisa.
 */
export class InMemoryNotificationLog extends NotificationLog {
  readonly keys = new Set<string>();

  async claim(profileId: string, fingerprint: string): Promise<boolean> {
    const key = `${profileId}#${fingerprint}`;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }

  async release(profileId: string, fingerprint: string): Promise<void> {
    this.keys.delete(`${profileId}#${fingerprint}`);
  }
}

/** Notifier de mentira, para rodar sem bot configurado. */
export class ConsoleNotifier extends NotifierPort {
  readonly kind = "telegram";
  readonly sent: Notification[] = [];

  async send(
    _destination: AlertDestination,
    notification: Notification,
  ): Promise<Result<void, BusinessError>> {
    this.sent.push(notification);
    process.stdout.write(`  📨 ${notification.title}\n     ${notification.url}\n`);
    return Result.ok(undefined);
  }
}
```

`InMemoryWorkQueue` ganha `notifyTasks: NotifyTask[]` e `enqueueNotify`.
`InMemoryArticleRepository` guarda `Map<string, Article>` e devolve
`created`/`updated`/`unchanged` comparando `contentHash`.

- [ ] **Step 3: Escrever `run-pipeline.ts`**

Estrutura, na ordem:

1. `const query = process.argv[2] ?? "Oeiras Piauí"`.
2. Montar o `PERFIL_OEIRAS: AlertProfile` com a regra do spec §6 e
   `chatId: process.env.TELEGRAM_CHAT_ID ?? "local"`, `queries: [query]`.
3. Instanciar os sete ports em memória.
4. `notifier = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
   ? new TelegramNotifier({ botToken: process.env.TELEGRAM_BOT_TOKEN })
   : new ConsoleNotifier()` — e logar qual dos dois entrou.
5. `catalog = new SourceCatalog([new GoogleNewsAdapter(new GoogleNewsClient(
   new HttpClient({ timeoutMs: 20_000, userAgent: "news-radar/0.1 (local dev)" }),
   new CircuitBreaker("google-news", { failureThreshold: 3, cooldownMs: 10_000 })))])`.
6. Os cinco use-cases.
7. `runOnce(runId, label)`: discover → drenar `fetchTasks` → drenar
   `normalizeMessages` acumulando `changed` → **um `match` por artigo de
   `changed`** → drenar `notifyTasks` pelo `notify`. Devolve
   `{ parsed, created, updated, unchanged, matched, sent, duplicates }`.
8. Rodar duas vezes e avaliar o critério de saúde.

O log usa `process.stdout.write` — `noConsole` é erro no Biome.

O critério de saúde, que é o ponto do comando inteiro:

```ts
/**
 * O que o comando prova:
 *
 * 1. A rodada 1 tem que produzir notificação — senão a query, a regra ou o
 *    parser estão errados.
 * 2. A rodada 2 tem que produzir ZERO. Se produzir, ou o `fingerprint` está
 *    instável (algo não-determinístico entrou nele), ou o log condicional não
 *    está segurando. Os dois são falhas que, em produção, viram flood no
 *    celular do usuário.
 */
const saudavel = primeira.sent > 0 && segunda.sent === 0;

log(
  saudavel
    ? "OK: rodada 2 não notificou nada — dedupe segurando"
    : "FALHA: dedupe não segurou (fingerprint instável ou log condicional furado)",
  { rodada1: primeira, rodada2: segunda },
);

process.exit(saudavel ? 0 : 1);
```

- [ ] **Step 4: Rodar sem Telegram (stdout)**

```bash
pnpm pipeline:local "Oeiras Piauí"
```

Esperado: rodada 1 com `parsed > 0`, `created > 0`, `sent > 0`; rodada 2 com
`unchanged === parsed` e `sent === 0`; saída `OK`, exit code 0.

Se a rodada 1 notificar zero, **não relaxe a regra ainda** — leia as manchetes
impressas e confira contra `docs/validacao-google-news.md`. É a regra que está
errada ou a fonte não devolveu nada de Oeiras/PI hoje? Ajuste `boost`/`minScore`
em `run-pipeline.ts` com base em manchete real, e registre a mudança no doc de
validação.

- [ ] **Step 5: Rodar com o Telegram de verdade**

Criar o bot no `@BotFather`, mandar uma mensagem para ele, pegar o `chat.id` em
`https://api.telegram.org/bot<TOKEN>/getUpdates`, e:

```bash
cp .env.example .env   # preencher os dois valores
set -a; source .env; set +a
pnpm pipeline:local "Oeiras Piauí"
```

Esperado: **chega mensagem no celular.** Este é o critério de aceite da fatia.

- [ ] **Step 6: Rodar a suíte inteira e commitar**

```bash
pnpm test
pnpm typecheck
pnpm lint
git add -A
git commit -m "feat(ingestion): ports em memória e pipeline local ponta a ponta"
```

- [ ] **Step 7: Escrever o README e fechar a fatia**

`README.md` cobrindo: o que é, a premissa (§2 do spec), o diagrama do pipeline,
os comandos, como configurar o bot, e o que a fatia 1 **não** faz (nada de AWS —
isso é o Plano B).

```bash
git add README.md
git commit -m "docs: README da fatia 1"
```

---

## Auto-revisão

**Cobertura do spec.** §2 premissa → Task 7b (`buildUrl`). §4 dois modos de fonte
→ Task 8 (união de queries + `SourceMode`). §4 paginação → Task 6a (`next` sempre
`null`, comentado). §5 layout → seguido, com o desvio do Telegram declarado no
topo. §6 três identificadores → Task 4; `AlertProfile` → Task 5; `MatchRule` →
Task 5. §8 erros → Tasks 6a e 10a (incluindo `retry_after`). §9 estratégia de
teste, os quatro itens → Tasks 7b (parse contra fixture), 5 (match table-driven
com as três manchetes do spec), 9 (dedupe) e 10b (`pipeline:local`). §10 as
quatro armadilhas → Task 2, e cada uma vira código depois: redirect → mapper da
7b; sem paginação → 6a e 7b; sufixo de veículo → `stripPublisherSuffix` na 3;
`pubDate` não confiável → `parsePubDate` na 7b.

**Fora desta fatia, de propósito:** §7 modelo single-table, §11 custo e o
`processBatch` são do Plano B — nada aqui toca AWS. TTL, GSI e sweeper idem.

**Pontos que o executor deve resolver com a fonte na mão, não adivinhando:**
o `boost`/`minScore` do perfil pode precisar de ajuste depois da Task 2, porque
a regra do spec foi escrita antes de ver manchete real. Isso é calibragem, não
mudança de desenho — e o lugar de registrá-la é `docs/validacao-google-news.md`.
