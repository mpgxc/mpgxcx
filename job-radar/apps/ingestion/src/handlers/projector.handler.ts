import type { JobChange } from "@job-radar/core";
import {
  decodeJobStreamRecord,
  type JobStreamIgnoreReason,
  toJobStreamRecord,
} from "@job-radar/infra-aws";
import type { Context, DynamoDBBatchResponse, DynamoDBStreamEvent } from "aws-lambda";
import { buildProjectorContainer } from "../composition.js";

type IgnoreTally = Partial<Record<JobStreamIgnoreReason, number>>;

/**
 * Projeta o catálogo do DynamoDB no índice de busca.
 *
 * Duas coisas fazem este handler existir, e as duas são sobre NÃO trabalhar.
 *
 * A primeira é o curto-circuito de `contentHash`. O `upsert` grava em toda
 * rodada porque precisa carimbar `lastSeenAt` — é o que o sweeper lê —, então
 * o Stream dispara para o catálogo INTEIRO todo dia, mesmo com quase nada
 * mudando. Reindexar esses ~98% seria pagar OCU de indexação, e o projeto
 * inteiro foi desenhado para não pagar isso. Quem decide é
 * `decodeJobStreamRecord`, comparando as duas imagens.
 *
 * A segunda é o filtro de entidade. O Stream é da tabela ÚNICA: cache de
 * fetch, registro de fontes, placar de rodada e ponteiro de última rodada
 * passam por aqui junto com as vagas. Tudo que não é reconhecido como vaga é
 * ignorado — errar para o lado de ignorar é barato (o documento volta na
 * próxima mudança real, ou numa reconstrução a partir do DynamoDB, que é a
 * verdade), enquanto indexar lixo é caro e silencioso.
 *
 * FALHA PARCIAL — o contrato do Stream é diferente do SQS. Um shard é ordenado,
 * então não existe "pular a mensagem ruim e seguir": reportar um
 * `itemIdentifier` faz a Lambda re-entregar A PARTIR daquele número de
 * sequência. Por isso o que se reporta é o PRIMEIRO registro que gerou
 * projeção, e não todos os que falharam — reportar um posterior daria
 * checkpoint em cima de escrita que não aconteceu. A reentrega é segura porque
 * a projeção é idempotente: o `_id` do documento é o id da vaga.
 */
export async function handler(
  event: DynamoDBStreamEvent,
  context: Context,
): Promise<DynamoDBBatchResponse> {
  const container = buildProjectorContainer();
  const logger = container.logger.child({ correlationId: context.awsRequestId });

  const changes: JobChange[] = [];
  const ignored: IgnoreTally = {};
  let checkpoint: string | null = null;

  for (const record of event.Records) {
    const decision = decodeJobStreamRecord(toJobStreamRecord(record));

    if (decision.kind === "ignore") {
      ignored[decision.reason] = (ignored[decision.reason] ?? 0) + 1;
      continue;
    }

    // Primeiro registro projetável do batch: é daqui que a reentrega recomeça
    // se a escrita no índice falhar.
    checkpoint ??= record.dynamodb?.SequenceNumber ?? null;
    changes.push(decision.change);
  }

  if (changes.length === 0) {
    logger.info("nada a projetar", { received: event.Records.length, ignored });
    return { batchItemFailures: [] };
  }

  try {
    const result = await container.projectJobChanges.execute(changes);

    if (result.isErr()) {
      // Erro de NEGÓCIO na projeção não se resolve retentando — o mesmo
      // registro produziria o mesmo erro. Loga alto e deixa o shard avançar,
      // porque travar o shard pararia a projeção do catálogo inteiro por causa
      // de uma vaga.
      logger.error("projeção recusada, batch consumido", result.error.toJSON());
      return { batchItemFailures: [] };
    }

    logger.info("projeção concluída", {
      received: event.Records.length,
      ...result.value,
      ignored,
    });

    return { batchItemFailures: [] };
  } catch (thrown) {
    logger.error("falha ao escrever no índice, reentregando a partir do checkpoint", {
      checkpoint,
      changes: changes.length,
      message: thrown instanceof Error ? thrown.message : String(thrown),
    });

    return checkpoint
      ? { batchItemFailures: [{ itemIdentifier: checkpoint }] }
      : { batchItemFailures: [] };
  }
}
