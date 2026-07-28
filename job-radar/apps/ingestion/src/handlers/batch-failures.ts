import type { BusinessError } from "@job-radar/core";
import type { Logger } from "@job-radar/infra-aws";
import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";

/**
 * Processa um batch do SQS com falha PARCIAL.
 *
 * Sem `ReportBatchItemFailures`, uma mensagem ruim num batch de 10 força o
 * reprocessamento das outras 9 que já tinham dado certo — no nosso caso isso
 * significa re-baixar e re-normalizar payloads inteiros à toa.
 *
 * A decisão de retentar vem do erro, não do handler:
 *
 * - retentável (fonte fora do ar, 5xx, timeout) -> reporta falha, o SQS
 *   devolve a mensagem com backoff e eventualmente manda para a DLQ.
 * - NÃO retentável (deriva de contrato, config inválida) -> loga em `error` e
 *   consome a mensagem. Retentar devolveria exatamente o mesmo payload; o que
 *   resolve é corrigir o parser. O log estruturado com `SOURCE_CONTRACT_DRIFT`
 *   é o gancho para o alarme.
 */
export async function processBatch<T>(
  event: SQSEvent,
  logger: Logger,
  parse: (record: SQSRecord) => T,
  process: (payload: T, correlationId: string) => Promise<BusinessError | null>,
): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    const correlationId = record.messageAttributes?.correlationId?.stringValue ?? record.messageId;
    const scoped = logger.child({ correlationId, messageId: record.messageId });

    try {
      const error = await process(parse(record), correlationId);

      if (error) {
        if (error.retryable) {
          scoped.warn("falha retentável, devolvendo à fila", error.toJSON());
          batchItemFailures.push({ itemIdentifier: record.messageId });
        } else {
          scoped.error("falha não retentável, mensagem consumida", error.toJSON());
        }
      }
    } catch (thrown) {
      // Exceção não modelada é sempre excepcional: infra fora do ar ou bug.
      // Retentar é a aposta certa.
      scoped.error("exceção não tratada no processamento", {
        message: thrown instanceof Error ? thrown.message : String(thrown),
        stack: thrown instanceof Error ? thrown.stack : undefined,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
