import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type SourceConfig, SourceRegistry } from "@job-radar/core";
import { TABLE_KEYS } from "./single-table.js";

/**
 * Todas as configs vivem na mesma partição, então listar é uma Query só.
 * Onboarding de um board novo é um `PutItem` — nunca um deploy.
 */
export class DynamoSourceRegistry extends SourceRegistry {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {
    super();
  }

  async listEnabled(): Promise<SourceConfig[]> {
    const configs: SourceConfig[] = [];
    let cursor: Record<string, unknown> | undefined;

    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk",
          FilterExpression: "enabled = :enabled",
          ExpressionAttributeValues: {
            ":pk": TABLE_KEYS.sourcesPartition,
            ":enabled": true,
          },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );

      for (const item of page.Items ?? []) {
        configs.push({
          sourceId: item.sourceId as string,
          selector: item.selector as string,
          enabled: true,
          params: (item.params as Record<string, string>) ?? {},
        });
      }

      cursor = page.LastEvaluatedKey;
    } while (cursor);

    return configs;
  }
}
