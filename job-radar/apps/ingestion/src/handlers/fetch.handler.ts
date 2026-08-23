import type { FetchTask } from "@job-radar/core";
import type { SQSEvent } from "aws-lambda";
import { buildContainer } from "../composition.js";
import { processBatch } from "./batch-failures.js";

interface FetchMessageBody {
  readonly task: FetchTask;
}

/**
 * Tem que casar com `maxReceiveCount` da DLQ do fetch no CDK.
 *
 * Fica duplicado aqui porque o SQS não conta ao consumidor qual é o limite; a
 * mensagem só traz quantas vezes já foi entregue. Se o CDK mudar e isto não,
 * o pior caso é contar a falha cedo demais — o lado seguro: o sweeper deixa de
 * expirar num dia em vez de expirar sobre uma coleta parcial.
 */
const MAX_RECEIVE_COUNT = 5;

/**
 * Busca uma página da fonte, grava o bruto no S3 e passa o ponteiro adiante.
 *
 * A concorrência desta Lambda é limitada por reserva no CDK — é o token bucket
 * mais simples que funciona de verdade em serverless, e mantém a educação com
 * a fonte sem precisar de um limitador distribuído.
 *
 * Aqui também mora a contabilidade da rodada, que é o que dá ao sweeper
 * permissão para expirar. Quando contar uma falha é a decisão delicada:
 *
 * - falha NÃO retentável (deriva de contrato, fonte desconhecida): conta na
 *   hora. Retentar devolveria o mesmo payload, então a tarefa está perdida
 *   agora e a rodada já é incompleta.
 * - falha RETENTÁVEL (5xx, timeout, breaker aberto): NÃO conta enquanto ainda
 *   há entrega pela frente. Contar na primeira tentativa seria irreversível —
 *   não há como decrementar com segurança quando a retentativa der certo — e um
 *   503 passageiro passaria a bloquear a expiração o dia inteiro. Só conta na
 *   última entrega (`ApproximateReceiveCount >= MAX_RECEIVE_COUNT`), que é
 *   quando a mensagem está indo para a DLQ e a tarefa realmente se perdeu.
 * - exceção não modelada: mesma regra da retentável — o `processBatch` a
 *   devolve à fila, então só a última entrega conta.
 *
 * O 304 (`not-modified`) é sucesso: a página foi verificada, a fonte é que
 * disse que nada mudou.
 */
export async function handler(event: SQSEvent) {
  const container = buildContainer();

  // O `processBatch` entrega o corpo já parseado, não o `SQSRecord`, então o
  // número de entregas é indexado antes por identidade de tarefa.
  const deliveries = indexDeliveries(event);

  return processBatch(
    event,
    container.logger,
    (record) => JSON.parse(record.body) as FetchMessageBody,
    async (body, correlationId) => {
      const { task } = body;
      const lastAttempt = (deliveries.get(taskKey(task)) ?? MAX_RECEIVE_COUNT) >= MAX_RECEIVE_COUNT;
      const scoped = container.logger.child({ correlationId, runId: task.runId });

      let result: Awaited<ReturnType<typeof container.fetchSourceBatch.execute>>;
      try {
        result = await container.fetchSourceBatch.execute({ task, correlationId });
      } catch (thrown) {
        // Infra fora do ar ou bug: o `processBatch` devolve à fila. Sem este
        // registro na última entrega, a tarefa iria para a DLQ invisível e o
        // sweeper acharia a rodada íntegra.
        if (lastAttempt) await container.runRegistry.recordFailure(task.runId, task.sourceId);
        throw thrown;
      }

      if (result.isErr()) {
        if (!result.error.retryable || lastAttempt) {
          await container.runRegistry.recordFailure(task.runId, task.sourceId);
        }
        return result.error;
      }

      await container.runRegistry.recordSuccess(task.runId, task.sourceId);

      scoped.info("página buscada", {
        sourceId: task.sourceId,
        selector: task.selector,
        page: task.page,
        status: result.value.status,
        hasNextPage: result.value.hasNextPage,
      });

      return null;
    },
  );
}

/** Quantas vezes cada tarefa do lote já foi entregue, por identidade de tarefa. */
function indexDeliveries(event: SQSEvent): Map<string, number> {
  const deliveries = new Map<string, number>();

  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body) as FetchMessageBody;
      deliveries.set(taskKey(body.task), Number(record.attributes.ApproximateReceiveCount));
    } catch {
      // Corpo ilegível: quem trata é o `processBatch`, que vê a exceção do
      // `parse` e devolve a mensagem à fila.
    }
  }

  return deliveries;
}

function taskKey(task: FetchTask): string {
  return `${task.runId}#${task.sourceId}#${task.selector}#${task.page}`;
}
