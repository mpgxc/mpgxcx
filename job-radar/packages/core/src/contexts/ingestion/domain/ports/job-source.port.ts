import type { BusinessError } from "../../../../commons/business-error.js";
import type { Result } from "../../../../commons/result.js";
import type { JobPosting, SourceId } from "../entities/job-posting.js";

/**
 * Uma linha do registro de fontes (DynamoDB). Onboarding de uma empresa nova é
 * inserir uma linha aqui — nunca um deploy.
 */
export interface SourceConfig {
  readonly sourceId: SourceId;
  /** O que identifica o board na fonte: slug do ATS, termo de busca, categoria do RSS. */
  readonly selector: string;
  readonly enabled: boolean;
  readonly params: Readonly<Record<string, string>>;
}

/** Uma unidade de trabalho buscável: uma requisição HTTP, uma página. */
export interface FetchTask {
  readonly sourceId: SourceId;
  readonly selector: string;
  /** 0-based. Fonte de dump completo usa sempre 0. */
  readonly page: number;
  /** Correlaciona todas as tarefas de uma mesma rodada — base do sweeper de expiração. */
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
  /** O corpo exatamente como a fonte devolveu. Vai cru para o S3. */
  readonly payload: string;
  readonly contentType: string;
  readonly fetchedAt: Date;
  readonly cache: CacheMetadata;
  /**
   * Continuação da paginação, ou `null` no fim.
   *
   * A paginação se resolve aqui e não no `discover` de propósito: Lever, Gupy e
   * SmartRecruiters não dizem quantas páginas existem antes da primeira
   * resposta. Emitir a continuação a partir do que a página trouxe evita uma
   * requisição de sondagem e funciona igual para fonte de dump completo, que
   * simplesmente devolve `null`.
   */
  readonly next: FetchTask | null;
}

export type FetchOutcome =
  | { readonly kind: "fetched"; readonly batch: RawBatch }
  /** A fonte respondeu 304: nada mudou desde o último ETag/Last-Modified. */
  | { readonly kind: "not-modified"; readonly task: FetchTask };

/**
 * A porta única de fonte de vagas.
 *
 * Três métodos cobrem os quatro formatos que existem no mundo real (API
 * paginada, dump completo, RSS, browser) sem vazar o formato para o core.
 *
 * A separação entre `fetch` e `parse` é o ponto mais importante do desenho:
 * `fetch` faz I/O e é mockável; `parse` é PURA e roda contra fixtures gravadas.
 * Parser drift — a fonte muda o JSON e o pipeline degrada em silêncio — é o
 * modo de falha número um de um agregador, e é `parse` que o teste ataca.
 *
 * NÃO declare política de educação (delay mínimo, tentativas) aqui. O
 * limitador de taxa real do sistema é a concorrência reservada da Lambda de
 * fetch — `reservedConcurrentExecutions` em `infra/lib/ingestion-stack.ts` —,
 * que é o único ponto capaz de segurar o paralelismo entre invocações. Um
 * campo de configuração no adapter que nenhum chamador lê não limita nada:
 * só dá a impressão de que limita, que é pior do que não ter.
 */
export abstract class JobSourcePort {
  abstract readonly id: SourceId;

  /** Explode a config em tarefas iniciais (páginas, slugs, termos). */
  abstract discover(config: SourceConfig, runId: string): Result<FetchTask[], BusinessError>;

  /** Camada 1 (client): só transporte. */
  abstract fetch(
    task: FetchTask,
    cache: CacheMetadata,
  ): Promise<Result<FetchOutcome, BusinessError>>;

  /** Camada 2 (ACL): sem I/O, sem relógio, sem aleatoriedade. */
  abstract parse(batch: RawBatch): Result<JobPosting[], BusinessError>;
}
