import { randomUUID } from "node:crypto";
import { CircuitBreaker, GupyAdapter, GupyClient, HttpClient } from "@job-radar/adapters";
import {
  DiscoverSourceWorkUseCase,
  FetchSourceBatchUseCase,
  NormalizeAndStoreUseCase,
  SourceCatalog,
} from "@job-radar/core";
import {
  InMemoryFetchCacheStore,
  InMemoryJobRepository,
  InMemoryRawStorage,
  InMemorySourceRegistry,
  InMemoryWorkQueue,
} from "./in-memory-ports.js";

/**
 * Roda o pipeline COMPLETO contra a fonte real, sem nenhum recurso da AWS.
 *
 *   pnpm pipeline:local backend
 *
 * Serve a duas coisas: validar que os três estágios se encaixam, e provar o
 * curto-circuito de `contentHash` — a segunda passagem sobre os mesmos dados
 * tem que cair inteira em `unchanged`.
 */

const term = process.argv[2] ?? "backend";
const maxPages = Number(process.argv[3] ?? 2);

const registry = new InMemorySourceRegistry([
  { sourceId: "gupy", selector: term, enabled: true, params: {} },
]);
const queue = new InMemoryWorkQueue();
const cache = new InMemoryFetchCacheStore();
const raw = new InMemoryRawStorage();
const repository = new InMemoryJobRepository();

const catalog = new SourceCatalog([
  new GupyAdapter(
    new GupyClient(
      new HttpClient({ timeoutMs: 20_000, userAgent: "job-radar/0.1 (local dev)" }),
      new CircuitBreaker("gupy", { failureThreshold: 3, cooldownMs: 10_000 }),
    ),
  ),
]);

const discover = new DiscoverSourceWorkUseCase(registry, catalog, queue);
const fetchBatch = new FetchSourceBatchUseCase(catalog, cache, raw, queue);
const normalize = new NormalizeAndStoreUseCase(catalog, raw, repository);

function log(message: string, details?: unknown) {
  const suffix = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  process.stdout.write(`${message}${suffix}\n`);
}

async function runOnce(runId: string, label: string) {
  const correlationId = randomUUID();

  const discovered = await discover.execute({ runId, correlationId });
  if (discovered.isErr()) throw discovered.error;
  log(`[${label}] descoberta`, discovered.value);

  // Drena a fila de fetch, respeitando o teto de páginas.
  let fetched = 0;
  while (queue.fetchTasks.length > 0 && fetched < maxPages) {
    const task = queue.fetchTasks.shift();
    if (!task) break;

    const result = await fetchBatch.execute({ task, correlationId });
    if (result.isErr()) throw result.error;

    fetched += 1;
    log(`[${label}] fetch p${task.page}`, result.value);
  }
  queue.fetchTasks.length = 0;

  const totals = { parsed: 0, created: 0, updated: 0, unchanged: 0 };
  while (queue.normalizeMessages.length > 0) {
    const message = queue.normalizeMessages.shift();
    if (!message) break;

    const result = await normalize.execute(message);
    if (result.isErr()) throw result.error;

    totals.parsed += result.value.parsed;
    totals.created += result.value.created;
    totals.updated += result.value.updated;
    totals.unchanged += result.value.unchanged;
  }

  log(`[${label}] normalização`, totals);
  return totals;
}

const first = await runOnce(`local-${Date.now()}-a`, "rodada 1");
const second = await runOnce(`local-${Date.now()}-b`, "rodada 2");

log("objetos raw guardados", { count: raw.size });
log("vagas no repositório", { count: repository.postings.size });

// A prova do curto-circuito: a segunda rodada não pode criar nem atualizar nada.
const shortCircuitWorks =
  second.parsed > 0 &&
  second.created === 0 &&
  second.updated === 0 &&
  second.unchanged === second.parsed;

log(
  shortCircuitWorks ? "OK: contentHash curto-circuitou a 2a rodada" : "FALHA: contentHash instável",
  {
    rodada1: first,
    rodada2: second,
  },
);

process.exit(shortCircuitWorks ? 0 : 1);
