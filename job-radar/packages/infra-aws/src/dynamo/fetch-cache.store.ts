import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { type CacheMetadata, FetchCacheStore, type FetchTask } from "@job-radar/core";
import { TABLE_KEYS } from "./single-table.js";

const TTL_DAYS = 30;

/**
 * Guarda ETag / Last-Modified por tarefa para conseguir mandar `If-None-Match`
 * na rodada seguinte. Quando a fonte honra, o payload inteiro nem é baixado.
 *
 * Nem toda fonte honra — por isso o `contentHash` continua sendo a defesa
 * principal. Este cache é o bônus, não a base.
 */
export class DynamoFetchCacheStore extends FetchCacheStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {
    super();
  }

  async get(task: FetchTask): Promise<CacheMetadata | null> {
    const keys = TABLE_KEYS.fetchCache(task);

    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: keys.pk, sk: keys.sk } }),
    );
    if (!result.Item) return null;

    return {
      etag: (result.Item.etag as string | null) ?? null,
      lastModified: (result.Item.lastModified as string | null) ?? null,
    };
  }

  async put(task: FetchTask, cache: CacheMetadata): Promise<void> {
    if (!cache.etag && !cache.lastModified) return;

    const keys = TABLE_KEYS.fetchCache(task);

    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: keys.pk,
          sk: keys.sk,
          entity: "CACHE",
          etag: cache.etag,
          lastModified: cache.lastModified,
          updatedAt: new Date().toISOString(),
          // TTL do DynamoDB: entrada de cache órfã se limpa sozinha.
          expiresAt: Math.floor(Date.now() / 1000) + TTL_DAYS * 86400,
        },
      }),
    );
  }
}
