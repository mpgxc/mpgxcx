import type { FetchTask } from "@job-radar/core";

/**
 * Tabela única. Todas as chaves são construídas aqui — nenhum outro arquivo
 * concatena string de chave, para que mudar o layout seja uma edição só.
 *
 * Entidades:
 *   JOB#<jobId>            / JOB            — a vaga (verdade)
 *   SOURCES                / <src>#<sel>    — registro de fontes (Query única)
 *   CACHE#<src>#<sel>#<pg> / CACHE          — ETag/Last-Modified, com TTL
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
} as const;

export const GSI1_NAME = "gsi1";
