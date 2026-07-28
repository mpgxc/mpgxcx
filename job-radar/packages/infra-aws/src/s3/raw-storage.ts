import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { type FetchTask, type RawObjectRef, RawStorage } from "@job-radar/core";

/**
 * Zona raw. Dois motivos, cada um suficiente sozinho:
 *
 * 1. Claim-check — a resposta do board do Stripe no Greenhouse tem ~4 MB e o
 *    limite de mensagem do SQS é 256 KB. O corpo simplesmente não cabe na fila.
 * 2. Replay — quando um parser é corrigido, dá para reprocessar meses de
 *    histórico sem bater na fonte de novo (e sem depender de ela ainda ter o
 *    dado, o que para vaga de emprego é garantido que não).
 *
 * A chave é particionada por data para o lifecycle do S3 conseguir mover
 * partições antigas para storage frio.
 */
export class S3RawStorage extends RawStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {
    super();
  }

  async put(task: FetchTask, payload: string, contentType: string): Promise<RawObjectRef> {
    const key = S3RawStorage.buildKey(task, new Date());

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: payload,
        ContentType: contentType,
        Metadata: {
          sourceid: task.sourceId,
          selector: encodeURIComponent(task.selector),
          page: String(task.page),
          runid: task.runId,
        },
      }),
    );

    return { bucket: this.bucket, key };
  }

  async get(ref: RawObjectRef): Promise<{ payload: string; contentType: string }> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: ref.bucket, Key: ref.key }),
    );

    return {
      payload: (await result.Body?.transformToString("utf-8")) ?? "",
      contentType: result.ContentType ?? "application/json",
    };
  }

  static buildKey(task: FetchTask, at: Date): string {
    const [date] = at.toISOString().split("T");
    const selector = encodeURIComponent(task.selector);
    return `raw/source=${task.sourceId}/dt=${date}/run=${task.runId}/${selector}-p${task.page}.json`;
  }
}
