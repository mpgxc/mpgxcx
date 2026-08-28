import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  AshbyAdapter,
  AshbyClient,
  CircuitBreaker,
  GreenhouseAdapter,
  GreenhouseClient,
  GupyAdapter,
  GupyClient,
  HttpClient,
  LeverAdapter,
  LeverClient,
  SmartRecruitersAdapter,
  SmartRecruitersClient,
  WorkableAdapter,
  WorkableClient,
} from "@job-radar/adapters";
import {
  DiscoverSourceWorkUseCase,
  FetchSourceBatchUseCase,
  NormalizeAndStoreUseCase,
  ProjectJobChangesUseCase,
  type RunRegistry,
  SourceCatalog,
  type SourceRegistry,
  SweepExpiredPostingsUseCase,
} from "@job-radar/core";
import {
  DynamoFetchCacheStore,
  DynamoJobRepository,
  DynamoRunRegistry,
  DynamoSourceRegistry,
  Logger,
  OpenSearchClient,
  OpenSearchJobIndex,
  S3RawStorage,
  SqsWorkQueue,
} from "@job-radar/infra-aws";
import { type AppConfig, loadConfig, loadProjectorConfig, type ProjectorConfig } from "./config.js";

/**
 * Composition root manual.
 *
 * Não há framework de DI aqui de propósito: em Lambda, montar um container de
 * injeção a cada cold start é custo puro, e não existe nada neste grafo que a
 * construção explícita não resolva. As ports continuam invertidas — o que o
 * DI daria é açúcar, não desacoplamento.
 *
 * Instanciado no escopo do módulo para ser reaproveitado entre invocações
 * quentes (conexões e estado do circuit breaker sobrevivem).
 */
export interface Container {
  readonly config: AppConfig;
  readonly logger: Logger;
  /**
   * Exposto porque dois handlers precisam da lista de fontes fora de um
   * use-case: o `discovery` para abrir o placar da rodada e o `sweeper` para
   * saber o que varrer quando o evento não nomeia a fonte.
   */
  readonly sourceRegistry: SourceRegistry;
  /** O `fetch` marca cada tarefa aqui; é o placar que autoriza o sweeper. */
  readonly runRegistry: RunRegistry;
  readonly discoverSourceWork: DiscoverSourceWorkUseCase;
  readonly fetchSourceBatch: FetchSourceBatchUseCase;
  readonly normalizeAndStore: NormalizeAndStoreUseCase;
  readonly sweepExpiredPostings: SweepExpiredPostingsUseCase;
}

let cached: Container | null = null;

export function buildContainer(): Container {
  if (cached) return cached;

  const config = loadConfig();
  const logger = new Logger("job-radar-ingestion");

  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const s3 = new S3Client({});
  const sqs = new SQSClient({});

  const http = new HttpClient({
    timeoutMs: config.httpTimeoutMs,
    userAgent: config.userAgent,
  });

  // Um breaker POR fonte. Um breaker global faria a queda do Gupy cortar o
  // Greenhouse, que está saudável.
  const gupy = new GupyAdapter(
    new GupyClient(http, new CircuitBreaker("gupy", { failureThreshold: 5, cooldownMs: 30_000 })),
  );

  const greenhouse = new GreenhouseAdapter(
    new GreenhouseClient(
      http,
      new CircuitBreaker("greenhouse", { failureThreshold: 5, cooldownMs: 30_000 }),
    ),
  );

  const lever = new LeverAdapter(
    new LeverClient(http, new CircuitBreaker("lever", { failureThreshold: 5, cooldownMs: 30_000 })),
  );

  const ashby = new AshbyAdapter(
    new AshbyClient(http, new CircuitBreaker("ashby", { failureThreshold: 5, cooldownMs: 30_000 })),
  );

  /**
   * O Workable é o único com política diferente, e a diferença foi medida, não
   * escolhida por gosto: o endpoint fica atrás de Cloudflare com limite por IP,
   * e ~10 requisições em poucos minutos já devolvem HTTP 429 com
   * `retry-after` de mais de seis horas. Com o limiar padrão de 5, o breaker
   * gastaria cinco tarefas da rodada só para descobrir um bloqueio que a
   * primeira resposta já anunciou. Abrir na terceira falha e esperar cinco
   * minutos corta o desperdício sem mudar o desfecho — a rodada fica
   * incompleta de qualquer jeito, e é isso que impede o sweeper de expirar.
   */
  const workable = new WorkableAdapter(
    new WorkableClient(
      http,
      new CircuitBreaker("workable", { failureThreshold: 3, cooldownMs: 300_000 }),
    ),
  );

  const smartrecruiters = new SmartRecruitersAdapter(
    new SmartRecruitersClient(
      http,
      new CircuitBreaker("smartrecruiters", { failureThreshold: 5, cooldownMs: 30_000 }),
    ),
  );

  const catalog = new SourceCatalog([gupy, greenhouse, lever, ashby, workable, smartrecruiters]);

  const registry = new DynamoSourceRegistry(dynamo, config.tableName);
  const runs = new DynamoRunRegistry(dynamo, config.tableName);
  const jobs = new DynamoJobRepository(dynamo, config.tableName);
  const cache = new DynamoFetchCacheStore(dynamo, config.tableName);
  const raw = new S3RawStorage(s3, config.rawBucket);
  const queue = new SqsWorkQueue(sqs, config.fetchQueueUrl, config.normalizeQueueUrl);

  cached = {
    config,
    logger,
    sourceRegistry: registry,
    runRegistry: runs,
    discoverSourceWork: new DiscoverSourceWorkUseCase(registry, catalog, queue),
    fetchSourceBatch: new FetchSourceBatchUseCase(catalog, cache, raw, queue),
    normalizeAndStore: new NormalizeAndStoreUseCase(catalog, raw, jobs),
    sweepExpiredPostings: new SweepExpiredPostingsUseCase(runs, jobs),
  };

  return cached;
}

/**
 * Container do projetor.
 *
 * Segundo composition root no mesmo app, e é o desenho certo: o trabalho de um
 * composition root é saber exatamente do que UM ponto de entrada precisa. O
 * projetor não fala com fonte, nem com S3, nem com fila — juntá-lo ao container
 * da coleta faria toda Lambda de ingestão carregar (e exigir a configuração de)
 * um cliente de OpenSearch que ela nunca usa.
 */
export interface ProjectorContainer {
  readonly config: ProjectorConfig;
  readonly logger: Logger;
  readonly projectJobChanges: ProjectJobChangesUseCase;
}

let cachedProjector: ProjectorContainer | null = null;

export function buildProjectorContainer(): ProjectorContainer {
  if (cachedProjector) return cachedProjector;

  const config = loadProjectorConfig();

  cachedProjector = {
    config,
    logger: new Logger("job-radar-projector"),
    projectJobChanges: new ProjectJobChangesUseCase(
      new OpenSearchJobIndex(
        new OpenSearchClient({ endpoint: config.searchEndpoint, region: config.region }),
        config.searchIndex,
      ),
    ),
  };

  return cachedProjector;
}
