import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type JobPosting, JobRepository, PostingStatus, type UpsertOutcome } from "@job-radar/core";
import { GSI1_NAME, TABLE_KEYS } from "./single-table.js";

export class DynamoJobRepository extends JobRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {
    super();
  }

  /**
   * Uma única `UpdateItem` com `ReturnValues: ALL_OLD`: uma ida ao banco,
   * uma escrita, e o hash antigo de volta para classificar o resultado.
   *
   * A escrita acontece mesmo quando o conteúdo não mudou porque `lastSeenAt` /
   * `lastRunId` PRECISAM ser carimbados — é o que o sweeper de expiração lê.
   * O ganho do `contentHash` não está em evitar esta escrita, e sim em evitar o
   * trabalho caro a jusante (reindexar no OpenSearch, casar com os alertas).
   *
   * Consequência importante: o Stream dispara para TODA vaga em TODA rodada.
   * Quem consome o Stream tem que comparar `OldImage.contentHash` com
   * `NewImage.contentHash` e ignorar os iguais — ver `isContentChange`.
   */
  async upsert(posting: JobPosting, runId: string): Promise<UpsertOutcome> {
    const keys = TABLE_KEYS.job(posting.id);
    const { props } = posting;

    const result = await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: keys.pk, sk: keys.sk },
        UpdateExpression: [
          "SET entity = :entity",
          "gsi1pk = :gsi1pk",
          "gsi1sk = :gsi1sk",
          "contentHash = :contentHash",
          "fingerprint = :fingerprint",
          "#status = :status",
          "sourceId = :sourceId",
          "externalId = :externalId",
          "#url = :url",
          "companyName = :companyName",
          "companySlug = :companySlug",
          "title = :title",
          "descriptionText = :descriptionText",
          "descriptionHtml = :descriptionHtml",
          "locationRaw = :locationRaw",
          "remoteMode = :remoteMode",
          "country = :country",
          "city = :city",
          "seniority = :seniority",
          "stack = :stack",
          "employmentType = :employmentType",
          "compensation = :compensation",
          "postedAt = :postedAt",
          "lastSeenAt = :lastSeenAt",
          "lastRunId = :lastRunId",
          "firstSeenAt = if_not_exists(firstSeenAt, :lastSeenAt)",
        ].join(", "),
        ExpressionAttributeNames: { "#status": "status", "#url": "url" },
        ExpressionAttributeValues: {
          ":entity": "JOB",
          ":gsi1pk": TABLE_KEYS.jobsBySource(props.source.id, PostingStatus.ACTIVE),
          ":gsi1sk": props.seenAt.toISOString(),
          ":contentHash": posting.contentHash,
          ":fingerprint": posting.fingerprint,
          ":status": PostingStatus.ACTIVE,
          ":sourceId": props.source.id,
          ":externalId": props.source.externalId,
          ":url": props.source.url,
          ":companyName": props.company.name,
          ":companySlug": props.company.slug,
          ":title": props.title,
          ":descriptionText": props.description.text,
          ":descriptionHtml": props.description.html,
          ":locationRaw": props.location.raw,
          ":remoteMode": props.location.remote,
          ":country": props.location.country,
          ":city": props.location.city,
          ":seniority": posting.seniority,
          ":stack": posting.stack,
          ":employmentType": props.employmentType,
          ":compensation": props.compensation
            ? {
                minCents: props.compensation.min?.amountCents ?? null,
                maxCents: props.compensation.max?.amountCents ?? null,
                currency: props.compensation.currency,
                period: props.compensation.period,
              }
            : null,
          ":postedAt": props.postedAt?.toISOString() ?? null,
          ":lastSeenAt": props.seenAt.toISOString(),
          ":lastRunId": runId,
        },
        ReturnValues: "ALL_OLD",
      }),
    );

    const previousHash = result.Attributes?.contentHash as string | undefined;
    if (!previousHash) return "created";
    return previousHash === posting.contentHash ? "unchanged" : "updated";
  }

  /**
   * Marca como EXPIRED tudo que a rodada não devolveu.
   *
   * ATENÇÃO: quem chama tem que ter confirmado que a rodada foi 100%
   * bem-sucedida. Chamar isto depois de uma rodada parcial expira o catálogo
   * inteiro da fonte — é o erro clássico de agregador, e a guarda vive no
   * use-case, não aqui.
   */
  async expireNotSeenIn(sourceId: string, runId: string): Promise<number> {
    let expired = 0;
    let cursor: Record<string, unknown> | undefined;

    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI1_NAME,
          KeyConditionExpression: "gsi1pk = :gsi1pk",
          FilterExpression: "lastRunId <> :runId",
          ExpressionAttributeValues: {
            ":gsi1pk": TABLE_KEYS.jobsBySource(sourceId, PostingStatus.ACTIVE),
            ":runId": runId,
          },
          ProjectionExpression: "pk, sk",
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );

      for (const item of page.Items ?? []) {
        await this.client.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { pk: item.pk, sk: item.sk },
            UpdateExpression: "SET #status = :expired, gsi1pk = :gsi1pk, expiredAt = :now",
            ConditionExpression: "lastRunId <> :runId",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
              ":expired": PostingStatus.EXPIRED,
              ":gsi1pk": TABLE_KEYS.jobsBySource(sourceId, PostingStatus.EXPIRED),
              ":now": new Date().toISOString(),
              ":runId": runId,
            },
          }),
        );
        expired += 1;
      }

      cursor = page.LastEvaluatedKey;
    } while (cursor);

    return expired;
  }
}

/**
 * Filtro que o projetor do OpenSearch e o matcher de alertas aplicam sobre cada
 * registro do Stream. Sem ele, a rodada diária reindexaria o catálogo inteiro.
 */
export function isContentChange(
  oldImage: { contentHash?: string } | undefined,
  newImage: { contentHash?: string } | undefined,
): boolean {
  if (!newImage?.contentHash) return false;
  return oldImage?.contentHash !== newImage.contentHash;
}
