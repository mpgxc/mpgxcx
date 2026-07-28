import { SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { FetchTask, RawObjectRef } from "@job-radar/core";
import { WorkQueue } from "@job-radar/core";

/** Limite duro do SQS. */
const MAX_BATCH = 10;

export interface FetchMessage {
  readonly task: FetchTask;
}

export interface NormalizeMessage {
  readonly task: FetchTask;
  readonly ref: RawObjectRef;
  readonly fetchedAt: string;
}

export class SqsWorkQueue extends WorkQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly fetchQueueUrl: string,
    private readonly normalizeQueueUrl: string,
  ) {
    super();
  }

  async enqueueFetch(tasks: readonly FetchTask[], correlationId: string): Promise<void> {
    await this.sendBatched(
      this.fetchQueueUrl,
      tasks.map((task) => ({ task })),
      correlationId,
    );
  }

  async enqueueNormalize(
    messages: readonly { task: FetchTask; ref: RawObjectRef; fetchedAt: Date }[],
    correlationId: string,
  ): Promise<void> {
    await this.sendBatched(
      this.normalizeQueueUrl,
      messages.map((message) => ({
        task: message.task,
        ref: message.ref,
        fetchedAt: message.fetchedAt.toISOString(),
      })),
      correlationId,
    );
  }

  private async sendBatched(
    queueUrl: string,
    payloads: readonly unknown[],
    correlationId: string,
  ): Promise<void> {
    for (let start = 0; start < payloads.length; start += MAX_BATCH) {
      const chunk = payloads.slice(start, start + MAX_BATCH);

      await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: chunk.map((payload, index) => ({
            Id: String(start + index),
            MessageBody: JSON.stringify(payload),
            // O correlationId viaja como atributo para o trace não quebrar na
            // fila — sem isso o worker abre um trace novo e a causalidade some.
            MessageAttributes: {
              correlationId: { DataType: "String", StringValue: correlationId },
            },
          })),
        }),
      );
    }
  }
}
