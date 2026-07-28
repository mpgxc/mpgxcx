import type { FetchTask, RawObjectRef } from "@job-radar/core";
import type { SQSEvent } from "aws-lambda";
import { buildContainer } from "../composition.js";
import { processBatch } from "./batch-failures.js";

interface NormalizeMessageBody {
  readonly task: FetchTask;
  readonly ref: RawObjectRef;
  readonly fetchedAt: string;
}

/**
 * Lê o bruto do S3, roda o ACL da fonte e persiste no DynamoDB.
 *
 * A proporção `unchanged` é o sinal de saúde do pipeline: numa segunda rodada
 * seguida, quase tudo deve cair em `unchanged`. Se não cair, ou entrou algo
 * não-determinístico no `contentHash`, ou a fonte reescreve o conteúdo a cada
 * requisição — os dois casos merecem investigação, e é por isso que a métrica
 * é logada em toda invocação.
 */
export async function handler(event: SQSEvent) {
  const container = buildContainer();

  return processBatch(
    event,
    container.logger,
    (record) => JSON.parse(record.body) as NormalizeMessageBody,
    async (body, correlationId) => {
      const result = await container.normalizeAndStore.execute({
        task: body.task,
        ref: body.ref,
        fetchedAt: new Date(body.fetchedAt),
      });

      if (result.isErr()) return result.error;

      container.logger.child({ correlationId }).info("lote normalizado", {
        sourceId: body.task.sourceId,
        selector: body.task.selector,
        page: body.task.page,
        ...result.value,
      });

      return null;
    },
  );
}
