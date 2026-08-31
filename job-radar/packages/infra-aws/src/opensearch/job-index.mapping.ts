import type { IndexedJob } from "@job-radar/core";

/**
 * O documento como ele vai para o índice.
 *
 * Não é o `IndexedJobProps` cru: a faixa salarial ganha `floorCents` e
 * `ceilingCents`, derivados na ESCRITA. Ver `buildSearchBody` para o porquê —
 * em resumo, com os dois lados sempre preenchidos, "a faixa da vaga intersecta
 * a faixa pedida" vira dois `range` triviais em vez de um `bool` aninhado com
 * quatro ramos para cobrir os lados ausentes. Custa dois inteiros por
 * documento; economiza a consulta que ninguém consegue ler.
 */
export function toIndexDocument(job: IndexedJob): Record<string, unknown> {
  const { props } = job;
  const salary = props.salary;

  return {
    id: props.id,
    contentHash: props.contentHash,
    status: props.status,
    sourceId: props.sourceId,
    externalId: props.externalId,
    url: props.url,
    companyName: props.companyName,
    companySlug: props.companySlug,
    title: props.title,
    description: props.description,
    locationRaw: props.locationRaw,
    remote: props.remote,
    country: props.country,
    city: props.city,
    seniority: props.seniority,
    stack: props.stack,
    employmentType: props.employmentType,
    salary: salary
      ? {
          minCents: salary.minCents,
          maxCents: salary.maxCents,
          floorCents: salary.minCents ?? salary.maxCents,
          ceilingCents: salary.maxCents ?? salary.minCents,
          currency: salary.currency,
          period: salary.period,
        }
      : null,
    postedAt: props.postedAt,
    firstSeenAt: props.firstSeenAt,
    lastSeenAt: props.lastSeenAt,
  };
}

/**
 * Mapeamento explícito, criado antes do primeiro documento.
 *
 * Sem ele o OpenSearch infere dinamicamente e transforma `stack` num campo
 * `text` analisado: `nextjs` vira o token `nextjs`, `c#` vira `c`, e a faceta
 * — que é uma agregação por termo EXATO — passa a devolver lixo. O mesmo vale
 * para `seniority` e `remote`, que são enums e nunca devem ser analisados.
 *
 * `title` e `description` ficam `text` porque são o alvo do texto livre.
 * `companyName` é os dois: `text` para casar "nu bank" com "Nubank" na busca,
 * e o subcampo `keyword` para agrupar por empresa depois.
 *
 * O analisador é o `standard`, não um analisador de idioma. Escolher entre
 * `portuguese` e `english` exigiria detectar o idioma de cada vaga, e errar a
 * detecção é pior que não fazer stemming: um stemmer aplicado ao idioma errado
 * corta radicais que não existem e some com o termo do índice.
 */
export const JOB_INDEX_MAPPING = {
  settings: {
    // Coleção serverless gerencia shards sozinha; o que sobra de útil aqui é o
    // teto de resultado, que o domínio já recusa antes de chegar no índice.
    index: { number_of_shards: 1, number_of_replicas: 1 },
  },
  mappings: {
    dynamic: "strict",
    properties: {
      id: { type: "keyword" },
      contentHash: { type: "keyword" },
      status: { type: "keyword" },
      sourceId: { type: "keyword" },
      externalId: { type: "keyword" },
      url: { type: "keyword", index: false },
      companyName: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } },
      companySlug: { type: "keyword" },
      title: { type: "text" },
      description: { type: "text" },
      locationRaw: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 256 } } },
      remote: { type: "keyword" },
      country: { type: "keyword" },
      city: { type: "keyword" },
      seniority: { type: "keyword" },
      stack: { type: "keyword" },
      employmentType: { type: "keyword" },
      salary: {
        properties: {
          minCents: { type: "long" },
          maxCents: { type: "long" },
          floorCents: { type: "long" },
          ceilingCents: { type: "long" },
          currency: { type: "keyword" },
          period: { type: "keyword" },
        },
      },
      postedAt: { type: "date" },
      firstSeenAt: { type: "date" },
      lastSeenAt: { type: "date" },
    },
  },
} as const;
