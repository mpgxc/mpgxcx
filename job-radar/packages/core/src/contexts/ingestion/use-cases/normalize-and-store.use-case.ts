import type { BusinessError } from "../../../commons/business-error.js";
import { Result } from "../../../commons/result.js";
import type { FetchTask } from "../domain/ports/job-source.port.js";
import type {
  JobRepository,
  RawObjectRef,
  RawStorage,
  UpsertOutcome,
} from "../domain/ports/repositories.port.js";
import type { SourceCatalog } from "../domain/source-catalog.js";

export type NormalizeAndStoreInput = {
  readonly task: FetchTask;
  readonly ref: RawObjectRef;
  readonly fetchedAt: Date;
};

export type NormalizeAndStoreOutput = {
  readonly parsed: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
};

/**
 * Lê o bruto do S3, roda o ACL da fonte e persiste.
 *
 * A proporção `unchanged` alta é o sinal de saúde do pipeline: numa segunda
 * rodada seguida, quase tudo deve cair em `unchanged`. Se não cair, ou o
 * `contentHash` está instável (algo não-determinístico entrou nele) ou a fonte
 * está reescrevendo o conteúdo a cada requisição.
 */
export class NormalizeAndStoreUseCase {
  constructor(
    private readonly catalog: SourceCatalog,
    private readonly raw: RawStorage,
    private readonly repository: JobRepository,
  ) {}

  async execute(
    input: NormalizeAndStoreInput,
  ): Promise<Result<NormalizeAndStoreOutput, BusinessError>> {
    const source = this.catalog.get(input.task.sourceId);
    if (source.isErr()) return Result.err(source.error);

    const object = await this.raw.get(input.ref);

    const parsed = source.value.parse({
      task: input.task,
      payload: object.payload,
      contentType: object.contentType,
      fetchedAt: input.fetchedAt,
      cache: { etag: null, lastModified: null },
      next: null,
    });
    if (parsed.isErr()) return Result.err(parsed.error);

    const tally: Record<UpsertOutcome, number> = { created: 0, updated: 0, unchanged: 0 };

    for (const posting of parsed.value) {
      const outcome = await this.repository.upsert(posting, input.task.runId);
      tally[outcome] += 1;
    }

    return Result.ok({
      parsed: parsed.value.length,
      created: tally.created,
      updated: tally.updated,
      unchanged: tally.unchanged,
    });
  }
}
