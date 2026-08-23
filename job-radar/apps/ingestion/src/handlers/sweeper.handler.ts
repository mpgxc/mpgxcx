import type { Context } from "aws-lambda";
import { buildContainer } from "../composition.js";

export interface SweeperEvent {
  /**
   * Rodada a varrer. Vazio = a última rodada aberta para cada fonte, lida do
   * ponteiro `LAST_RUN#<sourceId>` que o `discovery` grava.
   */
  readonly runId?: string;
  /** Restringe a varredura a uma fonte. Vazio = todas as habilitadas. */
  readonly sourceId?: string;
}

interface SweepReport {
  readonly sourceId: string;
  readonly runId: string | null;
  readonly expired: number;
  readonly skipped: boolean;
  readonly reason?: string;
}

/**
 * Expira o que a rodada do dia não devolveu. Agendado, horas depois da coleta.
 *
 * Descoberta do `runId` — o ponto que precisa ser explícito. O sweeper roda por
 * cron, então não recebe nada do `discovery`; e "a última rodada" não pode ser
 * inferida de um `scan` ordenado sem varrer a tabela. A solução é um ponteiro
 * escrito na abertura da rodada: `LAST_RUN#<sourceId>` guarda o `runId`
 * corrente daquela fonte, e o sweeper faz um `GetItem` por fonte. O ponteiro é
 * por FONTE, não global, porque uma rodada manual restrita a um board não pode
 * mover o alvo das outras fontes.
 *
 * Um `runId` explícito no evento tem precedência — é como se re-varre uma
 * rodada específica depois de investigar um incidente.
 *
 * Fonte sem ponteiro (nunca coletada, ou registro expirado pelo TTL) é pulada,
 * nunca varrida às cegas. O use-case aplica a guarda de integridade; aqui a
 * única regra é não inventar um `runId`.
 */
export async function handler(event: SweeperEvent, context: Context) {
  const container = buildContainer();
  const correlationId = context.awsRequestId;
  const logger = container.logger.child({ correlationId });

  const sourceIds = event.sourceId ? [event.sourceId] : await enabledSourceIds();
  const reports: SweepReport[] = [];

  for (const sourceId of sourceIds) {
    const runId = event.runId ?? (await container.runRegistry.lastRunId(sourceId));

    if (!runId) {
      const reason = "fonte sem ponteiro de última rodada";
      logger.warn("varredura pulada", { sourceId, reason });
      reports.push({ sourceId, runId: null, expired: 0, skipped: true, reason });
      continue;
    }

    const result = await container.sweepExpiredPostings.execute({ runId, sourceId });

    if (result.isErr()) {
      // Falhar alto: expirar é a operação destrutiva do pipeline, e um erro
      // silencioso aqui é indistinguível de "não havia nada para expirar".
      logger.error("varredura falhou", { sourceId, runId, ...result.error.toJSON() });
      throw result.error;
    }

    const { expired, skipped, reason } = result.value;
    const scoped = logger.child({ sourceId, runId });

    if (skipped) {
      // WARN e não INFO: rodada sem integridade comprovada é o sinal que merece
      // alarme — significa que o catálogo está envelhecendo sem ser podado.
      scoped.warn("varredura pulada: rodada sem integridade comprovada", { reason });
    } else {
      scoped.info("varredura concluída", { expired });
    }

    reports.push({ sourceId, runId, expired, skipped, ...(reason ? { reason } : {}) });
  }

  return { swept: reports };

  async function enabledSourceIds(): Promise<string[]> {
    const configs = await container.sourceRegistry.listEnabled();
    // Uma fonte aparece uma vez por selector; a varredura é por fonte inteira.
    return [...new Set(configs.map((config) => config.sourceId))];
  }
}
