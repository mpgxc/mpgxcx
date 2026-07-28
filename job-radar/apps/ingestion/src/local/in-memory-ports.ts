import {
  type CacheMetadata,
  FetchCacheStore,
  type FetchTask,
  type JobPosting,
  JobRepository,
  type RawObjectRef,
  RawStorage,
  type SourceConfig,
  SourceRegistry,
  type UpsertOutcome,
  WorkQueue,
} from "@job-radar/core";

/**
 * Implementações em memória das ports de infraestrutura.
 *
 * Elas existem porque a arquitetura de ports permite: o pipeline inteiro roda
 * sem DynamoDB, sem S3 e sem SQS, batendo só na fonte real. É o teste de
 * integração mais barato que existe — e se ele não fosse possível, seria sinal
 * de que as ports estão vazando infraestrutura.
 */

export class InMemorySourceRegistry extends SourceRegistry {
  constructor(private readonly configs: readonly SourceConfig[]) {
    super();
  }

  async listEnabled(): Promise<SourceConfig[]> {
    return this.configs.filter((config) => config.enabled);
  }
}

export class InMemoryFetchCacheStore extends FetchCacheStore {
  private readonly entries = new Map<string, CacheMetadata>();

  async get(task: FetchTask): Promise<CacheMetadata | null> {
    return this.entries.get(keyOf(task)) ?? null;
  }

  async put(task: FetchTask, cache: CacheMetadata): Promise<void> {
    this.entries.set(keyOf(task), cache);
  }
}

export class InMemoryRawStorage extends RawStorage {
  private readonly objects = new Map<string, { payload: string; contentType: string }>();

  async put(task: FetchTask, payload: string, contentType: string): Promise<RawObjectRef> {
    const key = `${keyOf(task)}.json`;
    this.objects.set(key, { payload, contentType });
    return { bucket: "local", key };
  }

  async get(ref: RawObjectRef): Promise<{ payload: string; contentType: string }> {
    const object = this.objects.get(ref.key);
    if (!object) throw new Error(`objeto raw ausente: ${ref.key}`);
    return object;
  }

  get size(): number {
    return this.objects.size;
  }
}

export class InMemoryJobRepository extends JobRepository {
  readonly postings = new Map<string, { posting: JobPosting; runId: string }>();

  async upsert(posting: JobPosting, runId: string): Promise<UpsertOutcome> {
    const existing = this.postings.get(posting.id);
    this.postings.set(posting.id, { posting, runId });

    if (!existing) return "created";
    return existing.posting.contentHash === posting.contentHash ? "unchanged" : "updated";
  }

  async expireNotSeenIn(sourceId: string, runId: string): Promise<number> {
    let expired = 0;
    for (const [id, entry] of this.postings) {
      if (entry.posting.props.source.id !== sourceId || entry.runId === runId) continue;
      this.postings.set(id, { posting: entry.posting.expire(), runId: entry.runId });
      expired += 1;
    }
    return expired;
  }
}

export interface PendingNormalize {
  readonly task: FetchTask;
  readonly ref: RawObjectRef;
  readonly fetchedAt: Date;
}

/** Fila que o runner drena manualmente, no lugar do SQS. */
export class InMemoryWorkQueue extends WorkQueue {
  readonly fetchTasks: FetchTask[] = [];
  readonly normalizeMessages: PendingNormalize[] = [];

  async enqueueFetch(tasks: readonly FetchTask[]): Promise<void> {
    this.fetchTasks.push(...tasks);
  }

  async enqueueNormalize(messages: readonly PendingNormalize[]): Promise<void> {
    this.normalizeMessages.push(...messages);
  }
}

function keyOf(task: FetchTask): string {
  return `${task.sourceId}#${task.selector}#${task.page}`;
}
