import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type RunCounters, RunRegistry } from "@job-radar/core";
import { TABLE_KEYS } from "./single-table.js";

/**
 * TTL do placar. Ele só precisa sobreviver da coleta (06:00) até o sweeper
 * (10:00); os 14 dias existem para post-mortem — casam com a retenção das DLQs,
 * então a mensagem envenenada e o placar que ela estragou expiram juntos.
 */
const TTL_DAYS = 14;

/**
 * Placar da rodada em DynamoDB.
 *
 * Tudo aqui é `UpdateItem` com `ADD`, nunca leitura seguida de escrita: as
 * Lambdas de fetch rodam concorrentes e um ler-modificar-escrever perderia
 * incrementos — justamente os de falha, que são o motivo do placar existir.
 * `ADD` num atributo inexistente parte de zero, então não há passo de criação.
 */
export class DynamoRunRegistry extends RunRegistry {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {
    super();
  }

  async startRun(runId: string, sourceIds: readonly string[]): Promise<void> {
    const keys = TABLE_KEYS.run(runId);
    const now = new Date().toISOString();

    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: keys.pk, sk: keys.sk },
        // `if_not_exists` em tudo: um fetch muito rápido pode ter criado o item
        // antes desta escrita, e abrir a rodada não pode zerar o que já contou.
        UpdateExpression: [
          "SET entity = :entity",
          "runId = :runId",
          "startedAt = if_not_exists(startedAt, :now)",
          "expiresAt = if_not_exists(expiresAt, :ttl)",
        ].join(", "),
        ExpressionAttributeValues: {
          ":entity": "RUN",
          ":runId": runId,
          ":now": now,
          ":ttl": expiresAtEpoch(),
        },
      }),
    );

    for (const sourceId of sourceIds) {
      await this.pointLastRun(sourceId, runId, now);
    }
  }

  async recordSuccess(runId: string, sourceId: string): Promise<void> {
    await this.increment("completed", runId, sourceId);
  }

  async recordFailure(runId: string, sourceId: string): Promise<void> {
    await this.increment("failed", runId, sourceId);
  }

  async get(runId: string): Promise<RunCounters | null> {
    const keys = TABLE_KEYS.run(runId);

    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: keys.pk, sk: keys.sk },
        // Leitura consistente de propósito: uma réplica atrasada que ainda não
        // enxergou o último `failed` autorizaria uma varredura destrutiva.
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return null;

    return {
      completed: Number(result.Item.completed ?? 0),
      failed: Number(result.Item.failed ?? 0),
      // Sempre gravado por `startRun` e por qualquer incremento; o fallback é só
      // defesa contra um item escrito à mão.
      startedAt: (result.Item.startedAt as string | undefined) ?? new Date(0).toISOString(),
    };
  }

  async lastRunId(sourceId: string): Promise<string | null> {
    const keys = TABLE_KEYS.lastRun(sourceId);

    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: keys.pk, sk: keys.sk },
        ConsistentRead: true,
      }),
    );

    return (result.Item?.runId as string | undefined) ?? null;
  }

  private async increment(
    kind: "completed" | "failed",
    runId: string,
    sourceId: string,
  ): Promise<void> {
    const keys = TABLE_KEYS.run(runId);

    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: keys.pk, sk: keys.sk },
        // `ADD` é o único incremento atômico do DynamoDB. O agregado e o
        // desdobramento por fonte sobem na MESMA operação: uma escrita, e o
        // diagnóstico nunca fica fora de sincronia com a guarda.
        UpdateExpression: [
          "ADD #total :one, #bySource :one",
          [
            "SET entity = :entity",
            "startedAt = if_not_exists(startedAt, :now)",
            "expiresAt = if_not_exists(expiresAt, :ttl)",
          ].join(", "),
        ].join(" "),
        ExpressionAttributeNames: {
          "#total": kind,
          "#bySource": TABLE_KEYS.runCounterBySource(kind, sourceId),
        },
        ExpressionAttributeValues: {
          ":one": 1,
          ":entity": "RUN",
          ":now": new Date().toISOString(),
          ":ttl": expiresAtEpoch(),
        },
      }),
    );
  }

  private async pointLastRun(sourceId: string, runId: string, now: string): Promise<void> {
    const keys = TABLE_KEYS.lastRun(sourceId);

    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: keys.pk, sk: keys.sk },
          UpdateExpression: "SET entity = :entity, runId = :runId, updatedAt = :now",
          // O `runId` começa com o instante ISO da rodada, então comparar strings
          // é comparar cronologia: um replay manual de uma rodada antiga não
          // pode fazer o ponteiro andar para trás e o sweeper varrer o passado.
          ConditionExpression: "attribute_not_exists(runId) OR runId <= :runId",
          ExpressionAttributeValues: {
            ":entity": "LAST_RUN",
            ":runId": runId,
            ":now": now,
          },
        }),
      );
    } catch (thrown) {
      // Condição falhou = já existe um ponteiro mais novo. Não é erro.
      if (thrown instanceof ConditionalCheckFailedException) return;
      throw thrown;
    }
  }
}

/** O TTL do DynamoDB é epoch em SEGUNDOS, não milissegundos. */
function expiresAtEpoch(): number {
  return Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;
}
