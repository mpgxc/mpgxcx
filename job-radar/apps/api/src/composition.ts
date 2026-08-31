import { type SearchIndexPort, SearchJobsUseCase } from "@job-radar/core";
import { Logger, OpenSearchClient, OpenSearchJobIndex } from "@job-radar/infra-aws";
import { type ApiConfig, loadConfig } from "./config.js";

/**
 * Composition root manual, mesma decisão do `apps/ingestion`: em Lambda, montar
 * um container de DI a cada cold start é custo puro, e não há nada neste grafo
 * que a construção explícita não resolva.
 *
 * Instanciado no escopo do módulo para sobreviver entre invocações quentes — o
 * provider de credenciais do SigV4 faz I/O na primeira assinatura, e refazer
 * isso a cada requisição apareceria direto na latência de cauda.
 */
export interface Container {
  readonly config: ApiConfig;
  readonly logger: Logger;
  /** Exposto porque o `/health` fala com o índice sem passar por use-case. */
  readonly searchIndex: SearchIndexPort;
  readonly searchJobs: SearchJobsUseCase;
}

let cached: Container | null = null;

export function buildContainer(): Container {
  if (cached) return cached;

  const config = loadConfig();

  const index = new OpenSearchJobIndex(
    new OpenSearchClient({ endpoint: config.searchEndpoint, region: config.region }),
    config.searchIndex,
  );

  cached = {
    config,
    logger: new Logger("job-radar-api"),
    searchIndex: index,
    searchJobs: new SearchJobsUseCase(index),
  };

  return cached;
}
