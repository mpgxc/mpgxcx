import { randomUUID } from "node:crypto";
import type { Context } from "aws-lambda";
import { buildContainer } from "../composition.js";

export interface DiscoveryEvent {
  /** Restringe a rodada a uma fonte. Útil para disparo manual. */
  readonly sourceId?: string;
}

/**
 * Início da rodada, disparado pelo EventBridge Scheduler.
 *
 * O `runId` gerado aqui carimba todas as vagas coletadas nesta rodada — é a
 * chave que o sweeper de expiração usa depois para saber o que a fonte deixou
 * de devolver.
 *
 * Antes de enfileirar qualquer coisa, a rodada é ABERTA no registro: além de
 * zerar o placar, isso grava o ponteiro `LAST_RUN#<sourceId>`. Sem ele o
 * sweeper — que roda por agendamento, horas depois, e não recebe nada deste
 * handler — não teria como descobrir qual `runId` varrer.
 *
 * A lista de fontes é lida aqui e de novo dentro do use-case. É uma Query a
 * mais por dia, e o preço de não alargar o contrato de saída do use-case só
 * para carregar informação que o handler já consegue obter.
 */
export async function handler(event: DiscoveryEvent, context: Context) {
  const container = buildContainer();
  const runId = `${new Date().toISOString().slice(0, 19)}-${randomUUID().slice(0, 8)}`;
  const correlationId = context.awsRequestId;

  const logger = container.logger.child({ runId, correlationId });
  logger.info("rodada de descoberta iniciada", { sourceId: event.sourceId ?? "todas" });

  // Uma fonte aparece uma vez por selector no registro; o placar é por fonte.
  const configs = await container.sourceRegistry.listEnabled();
  const sourceIds = [
    ...new Set(
      configs
        .filter((config) => !event.sourceId || config.sourceId === event.sourceId)
        .map((config) => config.sourceId),
    ),
  ];

  await container.runRegistry.startRun(runId, sourceIds);

  const result = await container.discoverSourceWork.execute({
    runId,
    correlationId,
    ...(event.sourceId ? { onlySourceId: event.sourceId } : {}),
  });

  if (result.isErr()) {
    logger.error("descoberta falhou", result.error.toJSON());
    throw result.error;
  }

  // Fonte pulada não derruba a rodada, mas precisa ficar visível.
  for (const skipped of result.value.skipped) {
    logger.warn("fonte pulada na descoberta", skipped);
  }

  logger.info("descoberta concluída", {
    tasksEnqueued: result.value.tasksEnqueued,
    skipped: result.value.skipped.length,
    sourceIds,
  });

  return { runId, ...result.value };
}
