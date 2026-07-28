import type { JobPosting } from "../entities/job-posting.js";
import type { CacheMetadata, FetchTask, SourceConfig } from "./job-source.port.js";

/** Resultado de um upsert — é o que diz se vale reindexar e alertar. */
export type UpsertOutcome = "created" | "updated" | "unchanged";

export abstract class JobRepository {
  /**
   * Escrita condicional pelo `contentHash`: se o conteúdo não mudou, só
   * carimba `lastSeenAt` e devolve `unchanged`. É este curto-circuito que
   * evita reindexar e re-alertar ~98% do catálogo a cada rodada diária.
   */
  abstract upsert(posting: JobPosting, runId: string): Promise<UpsertOutcome>;

  /**
   * Marca como EXPIRED as vagas da fonte que a rodada não devolveu.
   *
   * Quem chama tem que garantir que a rodada foi 100% bem-sucedida. Sem essa
   * guarda, uma instabilidade da fonte expira o catálogo inteiro — é o erro
   * clássico de agregador.
   */
  abstract expireNotSeenIn(sourceId: string, runId: string): Promise<number>;
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
 * Zona raw. Serve a dois propósitos que justificam o custo sozinhos:
 * claim-check (SQS aceita 256 KB e o Greenhouse devolve 4 MB) e reprocessar
 * um parser corrigido sem bater na fonte de novo.
 */
export abstract class RawStorage {
  abstract put(task: FetchTask, payload: string, contentType: string): Promise<RawObjectRef>;
  abstract get(ref: RawObjectRef): Promise<{ payload: string; contentType: string }>;
}

export abstract class WorkQueue {
  abstract enqueueFetch(tasks: readonly FetchTask[], correlationId: string): Promise<void>;
  abstract enqueueNormalize(
    messages: readonly { task: FetchTask; ref: RawObjectRef; fetchedAt: Date }[],
    correlationId: string,
  ): Promise<void>;
}
