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
 */
export async function handler(event: DiscoveryEvent, context: Context) {
  const container = buildContainer();
  const runId = `${new Date().toISOString().slice(0, 19)}-${randomUUID().slice(0, 8)}`;
  const correlationId = context.awsRequestId;

  const logger = container.logger.child({ runId, correlationId });
  logger.info("rodada de descoberta iniciada", { sourceId: event.sourceId ?? "todas" });

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
  });

  return { runId, ...result.value };
}
