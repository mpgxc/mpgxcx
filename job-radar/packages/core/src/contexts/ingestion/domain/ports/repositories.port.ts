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

/** Placar de uma rodada. É o que autoriza (ou proíbe) o sweeper a expirar. */
export interface RunCounters {
  /** Tarefas de fetch que terminaram bem — inclui 304, que também é sucesso. */
  readonly completed: number;
  /** Tarefas que esgotaram o retry ou falharam de forma definitiva. */
  readonly failed: number;
  readonly startedAt: string;
}

/**
 * Contadores de rodada.
 *
 * Existe por um motivo só: dar ao sweeper um jeito de saber se a rodada foi
 * ÍNTEGRA antes de expirar qualquer coisa. Não dá para comparar "tarefas
 * esperadas × concluídas" porque a paginação é descoberta dinamicamente — o
 * `discover` não sabe quantas páginas o board tem, cada página é que anuncia a
 * próxima. Então o registro conta o que de fato aconteceu: quantas tarefas
 * fecharam bem e quantas falharam.
 *
 * Os incrementos PRECISAM ser atômicos no adapter: dezenas de Lambdas de fetch
 * batem no mesmo registro ao mesmo tempo, e um ler-modificar-escrever perderia
 * exatamente as falhas que a guarda existe para enxergar.
 */
export abstract class RunRegistry {
  /**
   * Abre a rodada e aponta a última rodada de cada fonte para ela.
   *
   * O ponteiro é o que permite um sweeper agendado (que não recebe nada do
   * `discovery`) descobrir sozinho qual `runId` varrer.
   */
  abstract startRun(runId: string, sourceIds: readonly string[]): Promise<void>;

  abstract recordSuccess(runId: string, sourceId: string): Promise<void>;
  abstract recordFailure(runId: string, sourceId: string): Promise<void>;

  /** `null` quando não há registro — nesse caso a integridade é DESCONHECIDA. */
  abstract get(runId: string): Promise<RunCounters | null>;

  /** Última rodada aberta para a fonte, ou `null` se a fonte nunca rodou. */
  abstract lastRunId(sourceId: string): Promise<string | null>;
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
