import type { BusinessError } from "../../../commons/business-error.js";
import { Result } from "../../../commons/result.js";
import type { FetchTask } from "../domain/ports/job-source.port.js";
import type { FetchCacheStore, RawStorage, WorkQueue } from "../domain/ports/repositories.port.js";
import type { SourceCatalog } from "../domain/source-catalog.js";

export type FetchSourceBatchInput = {
  readonly task: FetchTask;
  readonly correlationId: string;
};

export type FetchSourceBatchOutput = {
  readonly status: "stored" | "not-modified";
  readonly hasNextPage: boolean;
};

/**
 * Busca uma página, grava o bruto no S3 e passa adiante só o ponteiro.
 *
 * O claim-check não é otimização prematura: a resposta do board do Stripe no
 * Greenhouse tem ~4 MB e o limite de mensagem do SQS é 256 KB. Mandar o corpo
 * na fila simplesmente não funciona.
 */
export class FetchSourceBatchUseCase {
  constructor(
    private readonly catalog: SourceCatalog,
    private readonly cache: FetchCacheStore,
    private readonly raw: RawStorage,
    private readonly queue: WorkQueue,
  ) {}

  async execute(
    input: FetchSourceBatchInput,
  ): Promise<Result<FetchSourceBatchOutput, BusinessError>> {
    const source = this.catalog.get(input.task.sourceId);
    if (source.isErr()) return Result.err(source.error);

    const cached = (await this.cache.get(input.task)) ?? { etag: null, lastModified: null };
    const fetched = await source.value.fetch(input.task, cached);
    if (fetched.isErr()) return Result.err(fetched.error);

    // 304: a fonte confirmou que nada mudou. Pula payload, parse e escrita.
    if (fetched.value.kind === "not-modified") {
      return Result.ok({ status: "not-modified", hasNextPage: false });
    }

    const { batch } = fetched.value;
    const ref = await this.raw.put(batch.task, batch.payload, batch.contentType);

    await this.queue.enqueueNormalize(
      [{ task: batch.task, ref, fetchedAt: batch.fetchedAt }],
      input.correlationId,
    );

    await this.cache.put(batch.task, batch.cache);

    // Paginação: a própria página diz se existe próxima.
    if (batch.next) {
      await this.queue.enqueueFetch([batch.next], input.correlationId);
    }

    return Result.ok({ status: "stored", hasNextPage: batch.next !== null });
  }
}
