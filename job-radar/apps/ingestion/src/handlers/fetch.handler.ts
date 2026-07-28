import type { FetchTask } from "@job-radar/core";
import type { SQSEvent } from "aws-lambda";
import { buildContainer } from "../composition.js";
import { processBatch } from "./batch-failures.js";

interface FetchMessageBody {
  readonly task: FetchTask;
}

/**
 * Busca uma página da fonte, grava o bruto no S3 e passa o ponteiro adiante.
 *
 * A concorrência desta Lambda é limitada por reserva no CDK — é o token bucket
 * mais simples que funciona de verdade em serverless, e mantém a educação com
 * a fonte sem precisar de um limitador distribuído.
 */
export async function handler(event: SQSEvent) {
  const container = buildContainer();

  return processBatch(
    event,
    container.logger,
    (record) => JSON.parse(record.body) as FetchMessageBody,
    async (body, correlationId) => {
      const result = await container.fetchSourceBatch.execute({ task: body.task, correlationId });

      if (result.isErr()) return result.error;

      container.logger.child({ correlationId }).info("página buscada", {
        sourceId: body.task.sourceId,
        selector: body.task.selector,
        page: body.task.page,
        status: result.value.status,
        hasNextPage: result.value.hasNextPage,
      });

      return null;
    },
  );
}
