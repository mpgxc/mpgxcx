import type { BusinessError } from "../../../commons/business-error.js";
import { Result } from "../../../commons/result.js";
import type { FetchTask } from "../domain/ports/job-source.port.js";
import type { SourceRegistry, WorkQueue } from "../domain/ports/repositories.port.js";
import type { SourceCatalog } from "../domain/source-catalog.js";

export type DiscoverSourceWorkInput = {
  /** Correlaciona a rodada inteira. É a chave do sweeper de expiração. */
  readonly runId: string;
  readonly correlationId: string;
  /** Restringe a rodada a uma fonte. Vazio = todas as habilitadas. */
  readonly onlySourceId?: string;
};

export type DiscoverSourceWorkOutput = {
  readonly tasksEnqueued: number;
  /** Fontes que falharam no discover, sem derrubar as outras. */
  readonly skipped: ReadonlyArray<{ sourceId: string; reason: string }>;
};

/**
 * Ponto de entrada da rodada: lê o registro de fontes e enfileira o trabalho.
 *
 * Uma fonte que falha no discover é registrada e pulada, nunca aborta a rodada:
 * o Gupy fora do ar não pode impedir o Greenhouse de ser coletado.
 */
export class DiscoverSourceWorkUseCase {
  constructor(
    private readonly registry: SourceRegistry,
    private readonly catalog: SourceCatalog,
    private readonly queue: WorkQueue,
  ) {}

  async execute(
    input: DiscoverSourceWorkInput,
  ): Promise<Result<DiscoverSourceWorkOutput, BusinessError>> {
    const configs = await this.registry.listEnabled();
    const selected = input.onlySourceId
      ? configs.filter((config) => config.sourceId === input.onlySourceId)
      : configs;

    const tasks: FetchTask[] = [];
    const skipped: Array<{ sourceId: string; reason: string }> = [];

    for (const config of selected) {
      const source = this.catalog.get(config.sourceId);
      if (source.isErr()) {
        skipped.push({ sourceId: config.sourceId, reason: source.error.message });
        continue;
      }

      const discovered = source.value.discover(config, input.runId);
      if (discovered.isErr()) {
        skipped.push({ sourceId: config.sourceId, reason: discovered.error.message });
        continue;
      }

      tasks.push(...discovered.value);
    }

    if (tasks.length > 0) {
      await this.queue.enqueueFetch(tasks, input.correlationId);
    }

    return Result.ok({ tasksEnqueued: tasks.length, skipped });
  }
}
