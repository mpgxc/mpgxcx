import { fileURLToPath } from "node:url";
import {
  Duration,
  aws_dynamodb as dynamodb,
  aws_events as events,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_s3 as s3,
  aws_lambda_event_sources as sources,
  aws_sqs as sqs,
  aws_events_targets as targets,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

const APP_ROOT = fileURLToPath(new URL("../../apps/ingestion/src/handlers/", import.meta.url));

export interface IngestionStackProps extends StackProps {
  /** Cron da rodada de coleta. Padrão: diariamente às 06:00 UTC (03:00 BRT). */
  readonly schedule?: events.Schedule;
  /**
   * Cron da varredura de expiração. Padrão: 10:00 UTC (07:00 BRT).
   *
   * Quatro horas depois da coleta, e a folga é dimensionada, não chutada: o
   * caminho mais longo é uma tarefa de fetch que esgota as 5 entregas com
   * `visibilityTimeout` de 6 minutos (~30 min) e, como a paginação é serial e o
   * fetch tem concorrência reservada em 2, cada página descoberta reinicia essa
   * conta. Quatro horas cobrem centenas de páginas com margem.
   *
   * Errar para mais é barato: o sweeper que roda cedo demais vê a rodada
   * incompleta e simplesmente não expira. Errar para menos, todo dia, é o que
   * faria a expiração nunca acontecer.
   */
  readonly sweepSchedule?: events.Schedule;
  /**
   * Teto de execuções simultâneas do fetch.
   *
   * É o token bucket do sistema: em serverless, reservar concorrência é o jeito
   * mais simples que realmente funciona de limitar a taxa contra a fonte, sem
   * precisar de um limitador distribuído.
   */
  readonly fetchConcurrency?: number;
}

export class IngestionStack extends Stack {
  /**
   * A tabela é pública porque a `SearchStack` precisa dela: o projetor lê o
   * Stream, e a direção da dependência tem que ser essa — a busca depende do
   * catálogo, nunca o contrário. O `Export`/`ImportValue` que o CDK gera com
   * isso impede excluir a TABELA enquanto a busca a importa, que é exatamente
   * a proteção que se quer; destruir a stack de busca continua livre.
   */
  readonly table: dynamodb.TableV2;

  constructor(scope: Construct, id: string, props: IngestionStackProps = {}) {
    super(scope, id, props);

    // ---- Armazenamento -----------------------------------------------------

    const table = new dynamodb.TableV2(this, "JobsTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      // TTL limpa cache de fetch e chaves de idempotência sozinho.
      timeToLiveAttribute: "expiresAt",
      // OLD e NEW: o projetor precisa dos dois para comparar `contentHash` e
      // ignorar as vagas que não mudaram. Só NEW_IMAGE reindexaria tudo.
      dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      globalSecondaryIndexes: [
        {
          indexName: "gsi1",
          partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.table = table;

    const rawBucket = new s3.Bucket(this, "RawBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: "arquivar-payloads-antigos",
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(30),
            },
          ],
          // Payload bruto vale para replay de parser, mas não para sempre.
          expiration: Duration.days(365),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- Filas -------------------------------------------------------------

    // Uma fila por estágio, cada uma com sua DLQ. Sem DLQ, uma mensagem
    // envenenada some sem deixar rastro.
    const fetchDlq = new sqs.Queue(this, "FetchDlq", {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    const fetchQueue = new sqs.Queue(this, "FetchQueue", {
      // Folga sobre o timeout da Lambda: 6x é a recomendação da AWS.
      visibilityTimeout: Duration.minutes(6),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: fetchDlq, maxReceiveCount: 5 },
    });

    const normalizeDlq = new sqs.Queue(this, "NormalizeDlq", {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    const normalizeQueue = new sqs.Queue(this, "NormalizeQueue", {
      visibilityTimeout: Duration.minutes(6),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: { queue: normalizeDlq, maxReceiveCount: 5 },
    });

    // ---- Lambdas -----------------------------------------------------------

    const commonEnvironment = {
      TABLE_NAME: table.tableName,
      RAW_BUCKET: rawBucket.bucketName,
      FETCH_QUEUE_URL: fetchQueue.queueUrl,
      NORMALIZE_QUEUE_URL: normalizeQueue.queueUrl,
      LOG_LEVEL: "info",
      // O SDK v3 já está no runtime; não empacotar corta segundos de cold start.
      NODE_OPTIONS: "--enable-source-maps",
    };

    const defaults: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(1),
      environment: commonEnvironment,
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: "node22",
        sourceMap: true,
        externalModules: ["@aws-sdk/*"],
      },
    };

    const discoveryFn = new nodejs.NodejsFunction(this, "DiscoveryFn", {
      ...defaults,
      entry: `${APP_ROOT}discovery.handler.ts`,
      handler: "handler",
      description: "Lê o registro de fontes e enfileira o trabalho da rodada",
    });

    const fetchFn = new nodejs.NodejsFunction(this, "FetchFn", {
      ...defaults,
      entry: `${APP_ROOT}fetch.handler.ts`,
      handler: "handler",
      timeout: Duration.minutes(5),
      description: "Busca uma página da fonte e grava o payload bruto no S3",
      // O limitador de taxa do sistema.
      reservedConcurrentExecutions: props.fetchConcurrency ?? 2,
    });

    const normalizeFn = new nodejs.NodejsFunction(this, "NormalizeFn", {
      ...defaults,
      entry: `${APP_ROOT}normalize.handler.ts`,
      handler: "handler",
      timeout: Duration.minutes(5),
      // Parsear 4 MB de JSON e derivar hashes é trabalho de CPU.
      memorySize: 1024,
      description: "Normaliza o payload bruto em JobPosting e persiste",
    });

    const sweeperFn = new nodejs.NodejsFunction(this, "SweeperFn", {
      ...defaults,
      entry: `${APP_ROOT}sweeper.handler.ts`,
      handler: "handler",
      // Varrer é uma Query no GSI1 seguida de um UpdateItem por vaga órfã. Num
      // dia em que uma empresa grande fecha o board, isso é lento — mas nunca
      // paralelo, para não competir por capacidade com a coleta.
      timeout: Duration.minutes(15),
      description: "Expira as vagas que a última rodada íntegra não devolveu",
    });

    // ---- Ligações ----------------------------------------------------------

    table.grantReadWriteData(discoveryFn);
    table.grantReadWriteData(fetchFn);
    table.grantReadWriteData(normalizeFn);
    // Lê o placar da rodada e o GSI1; escreve o status EXPIRED nas vagas órfãs.
    table.grantReadWriteData(sweeperFn);

    rawBucket.grantWrite(fetchFn);
    rawBucket.grantRead(normalizeFn);

    fetchQueue.grantSendMessages(discoveryFn);
    // O fetch reenfileira a própria continuação de paginação.
    fetchQueue.grantSendMessages(fetchFn);
    normalizeQueue.grantSendMessages(fetchFn);

    fetchFn.addEventSource(
      new sources.SqsEventSource(fetchQueue, {
        batchSize: 5,
        // Sem isso, uma mensagem ruim força o reprocessamento das outras 4.
        reportBatchItemFailures: true,
      }),
    );

    normalizeFn.addEventSource(
      new sources.SqsEventSource(normalizeQueue, {
        batchSize: 2,
        reportBatchItemFailures: true,
      }),
    );

    new events.Rule(this, "IngestionSchedule", {
      schedule: props.schedule ?? events.Schedule.cron({ minute: "0", hour: "6" }),
      targets: [new targets.LambdaFunction(discoveryFn)],
      description: "Dispara a rodada diária de coleta de vagas",
    });

    new events.Rule(this, "SweepSchedule", {
      schedule: props.sweepSchedule ?? events.Schedule.cron({ minute: "0", hour: "10" }),
      targets: [new targets.LambdaFunction(sweeperFn)],
      description: "Expira vagas não vistas na última rodada íntegra",
    });
  }
}
