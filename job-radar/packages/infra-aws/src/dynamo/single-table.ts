import type { FetchTask } from "@job-radar/core";

/**
 * Tabela única. Todas as chaves são construídas aqui — nenhum outro arquivo
 * concatena string de chave, para que mudar o layout seja uma edição só.
 *
 * Entidades:
 *   JOB#<jobId>            / JOB            — a vaga (verdade)
 *   SOURCES                / <src>#<sel>    — registro de fontes (Query única)
 *   CACHE#<src>#<sel>#<pg> / CACHE          — ETag/Last-Modified, com TTL
 *   RUN#<runId>            / RUN            — placar da rodada, com TTL
 *   LAST_RUN#<sourceId>    / LAST_RUN       — ponteiro para a última rodada
 *
 * GSI1 (sweeper de expiração): SRC#<sourceId>#<status> / <lastSeenAt>
 */
export const TABLE_KEYS = {
  job(jobId: string) {
    return { pk: `JOB#${jobId}`, sk: "JOB" };
  },

  sourcesPartition: "SOURCES",

  sourceConfig(sourceId: string, selector: string) {
    return { pk: TABLE_KEYS.sourcesPartition, sk: `${sourceId}#${selector}` };
  },

  fetchCache(task: Pick<FetchTask, "sourceId" | "selector" | "page">) {
    return { pk: `CACHE#${task.sourceId}#${task.selector}#${task.page}`, sk: "CACHE" };
  },

  jobsBySource(sourceId: string, status: string) {
    return `SRC#${sourceId}#${status}`;
  },

  /** Placar da rodada. Item único para toda a rodada — os contadores agregam ali. */
  run(runId: string) {
    return { pk: `RUN#${runId}`, sk: "RUN" };
  },

  /**
   * Ponteiro para a última rodada aberta de uma fonte.
   *
   * Item separado do placar porque a chave precisa ser derivável só do
   * `sourceId`: o sweeper roda por agendamento, não recebe o `runId` de
   * ninguém, e é por aqui que ele descobre o que varrer.
   */
  lastRun(sourceId: string) {
    return { pk: `LAST_RUN#${sourceId}`, sk: "LAST_RUN" };
  },

  /**
   * Nome de ATRIBUTO (não de chave) do contador por fonte dentro do placar.
   *
   * O agregado `completed`/`failed` é o que a guarda lê; este desdobramento por
   * fonte é diagnóstico — responde "qual fonte quebrou a rodada" sem custar uma
   * escrita a mais, porque vai no mesmo `ADD`.
   */
  runCounterBySource(kind: "completed" | "failed", sourceId: string) {
    return `${kind}#${sourceId}`;
  },
} as const;

export const GSI1_NAME = "gsi1";
