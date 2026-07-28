import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { CircuitBreaker, GupyAdapter, GupyClient, HttpClient } from "@job-radar/adapters";
import {
  DiscoverSourceWorkUseCase,
  FetchSourceBatchUseCase,
  NormalizeAndStoreUseCase,
  SourceCatalog,
} from "@job-radar/core";
import {
  DynamoFetchCacheStore,
  DynamoJobRepository,
  DynamoSourceRegistry,
  Logger,
  S3RawStorage,
  SqsWorkQueue,
} from "@job-radar/infra-aws";
import { type AppConfig, loadConfig } from "./config.js";

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
  readonly discoverSourceWork: DiscoverSourceWorkUseCase;
  readonly fetchSourceBatch: FetchSourceBatchUseCase;
  readonly normalizeAndStore: NormalizeAndStoreUseCase;
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

  const catalog = new SourceCatalog([gupy]);

  const registry = new DynamoSourceRegistry(dynamo, config.tableName);
  const jobs = new DynamoJobRepository(dynamo, config.tableName);
  const cache = new DynamoFetchCacheStore(dynamo, config.tableName);
  const raw = new S3RawStorage(s3, config.rawBucket);
  const queue = new SqsWorkQueue(sqs, config.fetchQueueUrl, config.normalizeQueueUrl);

  cached = {
    config,
    logger,
    discoverSourceWork: new DiscoverSourceWorkUseCase(registry, catalog, queue),
    fetchSourceBatch: new FetchSourceBatchUseCase(catalog, cache, raw, queue),
    normalizeAndStore: new NormalizeAndStoreUseCase(catalog, raw, jobs),
  };

  return cached;
}
