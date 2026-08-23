import type { BusinessError } from "../../../commons/business-error.js";
import { Result } from "../../../commons/result.js";
import type { JobRepository, RunRegistry } from "../domain/ports/repositories.port.js";

export type SweepExpiredPostingsInput = {
  /** Rodada cujo carimbo (`lastRunId`) define o que continua vivo. */
  readonly runId: string;
  readonly sourceId: string;
};

export type SweepExpiredPostingsOutput = {
  readonly expired: number;
  /** `true` quando a rodada não provou integridade e nada foi tocado. */
  readonly skipped: boolean;
  /** Preenchido só quando `skipped` — é o que vai para o log e para o alarme. */
  readonly reason?: string;
};

/**
 * Expira o que a rodada não devolveu — mas só se a rodada foi íntegra.
 *
 * Este use-case é quase inteiramente a guarda, e é de propósito. Expirar é a
 * única operação destrutiva do pipeline: `expireNotSeenIn` apaga do catálogo
 * tudo que a fonte deixou de listar. Se o Gupy ficar instável e metade das
 * páginas falhar, "o que não foi visto" vira "metade do catálogo" — e o
 * agregador some com as vagas sem ninguém perceber, porque a rodada terminou
 * sem erro nenhum. É o erro clássico da categoria.
 *
 * A regra é conservadora de propósito: só varre com `failed === 0` e
 * `completed > 0`. Não expirar num dia custa vagas velhas visíveis por mais 24
 * horas; expirar errado custa o catálogo. A assimetria decide o desenho.
 *
 * Note que "não sei" é tratado como "não varra": rodada sem registro é pulada,
 * porque a ausência do placar não é prova de sucesso.
 */
export class SweepExpiredPostingsUseCase {
  constructor(
    private readonly runs: RunRegistry,
    private readonly repository: JobRepository,
  ) {}

  async execute(
    input: SweepExpiredPostingsInput,
  ): Promise<Result<SweepExpiredPostingsOutput, BusinessError>> {
    const counters = await this.runs.get(input.runId);

    if (!counters) {
      return skip(`rodada ${input.runId} não tem registro de contadores`);
    }

    if (counters.failed > 0) {
      return skip(
        `rodada ${input.runId} teve ${counters.failed} tarefa(s) com falha; ` +
          "expirar sobre uma coleta parcial apagaria vagas que ainda existem",
      );
    }

    if (counters.completed === 0) {
      return skip(`rodada ${input.runId} não concluiu nenhuma tarefa`);
    }

    const expired = await this.repository.expireNotSeenIn(input.sourceId, input.runId);

    return Result.ok({ expired, skipped: false });
  }
}

function skip(reason: string): Result<SweepExpiredPostingsOutput, BusinessError> {
  return Result.ok({ expired: 0, skipped: true, reason });
}
