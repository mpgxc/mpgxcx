import { fileURLToPath } from "node:url";
import {
  aws_opensearchserverless as aoss,
  aws_apigateway as apigw,
  CfnOutput,
  Duration,
  type aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_nodejs as nodejs,
  Stack,
  type StackProps,
  aws_lambda_event_sources as sources,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

const INGESTION_HANDLERS = fileURLToPath(
  new URL("../../apps/ingestion/src/handlers/", import.meta.url),
);
const API_HANDLERS = fileURLToPath(new URL("../../apps/api/src/handlers/", import.meta.url));

/** Nome do índice dentro da coleção. Um só — o catálogo é uma coisa. */
const INDEX_NAME = "jobs";

export interface SearchStackProps extends StackProps {
  /** A tabela da `IngestionStack`. O projetor consome o Stream dela. */
  readonly table: dynamodb.TableV2;
  readonly stage: string;
  /**
   * Cache do API Gateway. DESLIGADO por padrão, e a conta explica: o cluster de
   * cache é cobrado POR HORA enquanto existe (a menor instância, 0.5 GB, sai
   * por volta de US$ 15/mês), independentemente de haver tráfego. Isso destrói
   * a premissa do projeto — a coleção NextGen foi escolhida justamente para
   * escalar a zero e não ter piso. Pagar um piso fixo para acelerar um
   * catálogo que muda uma vez por dia é trocar a economia grande pela pequena.
   *
   * O que cobre as consultas quentes sem piso é o `Cache-Control` que a Lambda
   * já devolve: navegador e CDN respeitam, e custam zero. Ligar isto aqui só
   * faz sentido depois que houver tráfego medido que justifique a mensalidade.
   */
  readonly apiCache?: boolean;
}

/**
 * Índice de busca, projetor e API REST.
 *
 * STACK SEPARADA, e a razão é ciclo de vida, não organização de arquivo.
 *
 * A `IngestionStack` guarda o que não pode ser perdido: a tabela e o bucket
 * raw, os dois com `RemovalPolicy.RETAIN`. Tudo aqui é o oposto — o índice é
 * descartável por construção, reconstruível inteiro a partir do DynamoDB. Essa
 * assimetria só vira operação de verdade se as duas coisas puderem ser
 * destruídas separadamente: `cdk destroy JobRadar-Search-dev` tem que ser um
 * comando sem medo, para parar de pagar a coleção num período ocioso ou para
 * refazer o índice do zero depois de mudar o mapeamento. Com uma stack só,
 * esse comando teria a tabela dentro do raio de explosão, e ninguém o
 * executaria — o que na prática significa que a reconstrução nunca aconteceria.
 *
 * O mesmo vale na direção do dia a dia: mudar a API de busca não pode abrir a
 * possibilidade de um update na tabela. Stacks separadas tornam isso
 * impossível em vez de improvável.
 */
export class SearchStack extends Stack {
  constructor(scope: Construct, id: string, props: SearchStackProps) {
    super(scope, id, props);

    const collectionName = `job-radar-${props.stage}`;

    // ---- Coleção -----------------------------------------------------------

    /**
     * NextGen: a coleção escala a ZERO depois de ~10 minutos parada.
     *
     * A coleção clássica tem piso de 2 OCU de indexação + 2 de busca, o que dá
     * na ordem de US$ 350/mês com a coleção sem fazer nada — inviável para
     * projeto pessoal, e o motivo pelo qual todo o desenho de custo do sistema
     * (o gate de `contentHash`, o projetor filtrando o Stream) só faz sentido
     * com NextGen.
     *
     * ATENÇÃO — nível de abstração: o CDK 2.262 NÃO tem construct L2 para
     * OpenSearch Serverless. Não existe `aoss.Collection`; o que existe é a
     * camada L1 gerada do CloudFormation, e é ela que está sendo usada aqui.
     * NextGen em si é suportado, mas só por este caminho: a geração vive no
     * `AWS::OpenSearchServerless::CollectionGroup` (`generation: NEXTGEN`), e a
     * coleção entra no grupo por NOME, via `collectionGroupName`. Não há
     * propriedade `generation` na coleção — quem procurar por ela não encontra.
     */
    const collectionGroup = new aoss.CfnCollectionGroup(this, "CollectionGroup", {
      name: `${collectionName}-ng`,
      generation: "NEXTGEN",
      // Réplica standby dobra o custo e compra disponibilidade multi-AZ. Um
      // índice reconstruível a partir do DynamoDB não precisa disso: o pior
      // caso é reprojetar, não perder dado.
      standbyReplicas: "DISABLED",
      description: "Grupo NextGen: escala a zero quando ninguém consulta",
      capacityLimits: {
        // Teto, não reserva. Existe como fusível de conta: sem ele, um laço de
        // reprojeção acidental escala sem limite e a fatura é a notificação.
        maxIndexingCapacityInOcu: 2,
        maxSearchCapacityInOcu: 2,
      },
    });

    /**
     * As três políticas abaixo são OBRIGATÓRIAS e independentes — uma coleção
     * sem política de criptografia simplesmente falha ao criar, e uma sem
     * política de acesso a dados cria mas devolve 403 em tudo. Elas não são
     * IAM: o OpenSearch Serverless tem um segundo sistema de permissão, e o
     * acesso exige as DUAS coisas (IAM `aoss:APIAccessAll` E a política de
     * acesso a dados listando o principal). É a pegadinha mais comum do
     * serviço.
     */
    const encryptionPolicy = new aoss.CfnSecurityPolicy(this, "EncryptionPolicy", {
      name: `${collectionName}-enc`,
      type: "encryption",
      description: "Criptografia em repouso com chave gerenciada pela AWS",
      policy: JSON.stringify({
        Rules: [{ ResourceType: "collection", Resource: [`collection/${collectionName}`] }],
        // Uma CMK própria custaria mensalidade de KMS para proteger um índice
        // que é cópia descartável de dado público. Não se paga por isso aqui.
        AWSOwnedKey: true,
      }),
    });

    const networkPolicy = new aoss.CfnSecurityPolicy(this, "NetworkPolicy", {
      name: `${collectionName}-net`,
      type: "network",
      description: "Endpoint público; o controle de acesso real é IAM + data access",
      policy: JSON.stringify([
        {
          Rules: [
            { ResourceType: "collection", Resource: [`collection/${collectionName}`] },
            { ResourceType: "dashboard", Resource: [`collection/${collectionName}`] },
          ],
          // Endpoint público NÃO significa aberto: sem SigV4 e sem constar na
          // política de acesso a dados, a requisição morre em 403. A
          // alternativa (VPC endpoint) exigiria pôr as Lambdas numa VPC, o que
          // custa NAT e cold start de ENI — preço alto para uma superfície que
          // a autenticação já fecha.
          AllowFromPublic: true,
        },
      ]),
    });

    const collection = new aoss.CfnCollection(this, "Collection", {
      name: collectionName,
      // SEARCH e não TIMESERIES: a consulta é full-text com facetas, não
      // janela temporal. E é o tipo que aceita `_id` próprio no documento —
      // que é o que torna a projeção idempotente.
      type: "SEARCH",
      collectionGroupName: collectionGroup.name,
      description: "Índice de leitura de vagas — descartável, reconstruível do DynamoDB",
    });

    // O CloudFormation não infere estas ordens: a coleção precisa das políticas
    // já existindo, e do grupo, no momento da criação.
    collection.addDependency(encryptionPolicy);
    collection.addDependency(networkPolicy);
    collection.addDependency(collectionGroup);

    const collectionEndpoint = collection.attrCollectionEndpoint;

    // ---- Lambdas -----------------------------------------------------------

    const defaults: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: "node22",
        sourceMap: true,
        externalModules: ["@aws-sdk/*"],
      },
    };

    const commonEnvironment = {
      SEARCH_ENDPOINT: collectionEndpoint,
      SEARCH_INDEX: INDEX_NAME,
      STAGE: props.stage,
      LOG_LEVEL: "info",
      NODE_OPTIONS: "--enable-source-maps",
    };

    const projectorDlq = new sqs.Queue(this, "ProjectorDlq", {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    const projectorFn = new nodejs.NodejsFunction(this, "ProjectorFn", {
      ...defaults,
      entry: `${INGESTION_HANDLERS}projector.handler.ts`,
      handler: "handler",
      environment: commonEnvironment,
      // Um batch de 100 documentos vira UMA `_bulk`; o tempo é rede, não CPU.
      timeout: Duration.minutes(2),
      description: "Projeta o catálogo do DynamoDB Stream no índice de busca",
    });

    const searchFn = new nodejs.NodejsFunction(this, "SearchFn", {
      ...defaults,
      entry: `${API_HANDLERS}search.handler.ts`,
      handler: "handler",
      environment: { ...commonEnvironment, CACHE_SECONDS: "60" },
      // Latência de API pública: a espera é I/O, e mais memória aqui compra
      // sobretudo cold start menor, não vazão.
      memorySize: 1024,
      description: "GET /jobs — busca com texto livre e facetas",
    });

    const healthFn = new nodejs.NodejsFunction(this, "HealthFn", {
      ...defaults,
      entry: `${API_HANDLERS}health.handler.ts`,
      handler: "handler",
      environment: commonEnvironment,
      timeout: Duration.seconds(10),
      description: "GET /health — leitura real no índice, com contagem",
    });

    // ---- Permissões --------------------------------------------------------

    props.table.grantStreamRead(projectorFn);
    projectorDlq.grantSendMessages(projectorFn);

    /**
     * `aoss:APIAccessAll` é a única ação de plano de DADOS do serviço: não
     * existe distinção IAM entre ler e escrever num índice. A separação
     * leitura/escrita acontece na política de acesso a dados abaixo, e é lá que
     * o menor privilégio de verdade mora.
     */
    for (const fn of [projectorFn, searchFn, healthFn]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["aoss:APIAccessAll"],
          resources: [collection.attrArn],
        }),
      );
    }

    const dataAccessPolicy = new aoss.CfnAccessPolicy(this, "DataAccessPolicy", {
      name: `${collectionName}-access`,
      type: "data",
      description: "Projetor escreve; API só lê",
      policy: JSON.stringify([
        {
          Rules: [
            {
              ResourceType: "index",
              Resource: [`index/${collectionName}/*`],
              Permission: [
                "aoss:CreateIndex",
                "aoss:UpdateIndex",
                "aoss:DescribeIndex",
                "aoss:WriteDocument",
                "aoss:DeleteDocument",
                "aoss:ReadDocument",
              ],
            },
          ],
          Principal: [roleArnOf(projectorFn)],
        },
        {
          Rules: [
            {
              ResourceType: "index",
              Resource: [`index/${collectionName}/*`],
              // Só leitura. A API não cria índice e não escreve documento — se
              // um dia precisar, é bug, e o 403 é o alarme.
              Permission: ["aoss:DescribeIndex", "aoss:ReadDocument"],
            },
          ],
          Principal: [roleArnOf(searchFn), roleArnOf(healthFn)],
        },
      ]),
    });

    // A política precisa existir antes de a Lambda tentar a primeira escrita;
    // a dependência explícita evita a janela de 403 logo após o deploy.
    projectorFn.node.addDependency(dataAccessPolicy);

    // ---- Stream ------------------------------------------------------------

    projectorFn.addEventSource(
      new sources.DynamoEventSource(props.table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 100,
        /**
         * O filtro do event source corta os itens que não são vaga ANTES da
         * invocação, e não se paga por evento descartado assim. Numa rodada, o
         * Stream carrega também cache de fetch, placar e ponteiros — trabalho
         * que a Lambda nem precisa acordar para ignorar.
         *
         * O `decodeJobStreamRecord` continua filtrando por conta própria. Não é
         * redundância inútil: este filtro é configuração, vive noutro arquivo e
         * pode ser afrouxado sem ninguém notar — a correção do projetor não
         * pode depender disso. E o filtro NÃO substitui o gate de
         * `contentHash`, porque ele não consegue comparar a imagem antiga com a
         * nova; a economia grande continua sendo no código.
         */
        filters: [
          lambda.FilterCriteria.filter({
            dynamodb: { Keys: { sk: { S: lambda.FilterRule.isEqual("JOB") } } },
          }),
        ],
        // Sem isto, um batch que falha é reentregue INTEIRO até expirar,
        // travando o shard. Ver o comentário do handler sobre por que o
        // checkpoint reportado é o primeiro registro projetável.
        reportBatchItemFailures: true,
        // Um documento envenenado não pode segurar o shard por 24 horas:
        // bissecção isola o culpado e o resto passa.
        bisectBatchOnError: true,
        retryAttempts: 3,
        // Agrupa a rajada da rodada diária em menos invocações e menos `_bulk`.
        maxBatchingWindow: Duration.seconds(20),
        onFailure: new sources.SqsDlq(projectorDlq),
      }),
    );

    // ---- API ---------------------------------------------------------------

    const api = new apigw.RestApi(this, "SearchApi", {
      restApiName: `job-radar-${props.stage}`,
      description: "API pública de busca de vagas",
      deployOptions: {
        stageName: props.stage,
        cacheClusterEnabled: props.apiCache ?? false,
        cachingEnabled: props.apiCache ?? false,
        cacheTtl: Duration.minutes(1),
        // 0.5 GB é o menor cluster; ver o comentário de `apiCache` sobre o piso.
        // Só pode ser declarado com o cluster ligado — o CDK recusa a
        // combinação, e com razão: tamanho de um cluster que não existe.
        ...(props.apiCache ? { cacheClusterSize: "0.5" } : {}),
        // Throttle no estágio é o que impede uma varredura automatizada de
        // virar conta: a coleção NextGen escala com a demanda, e demanda
        // ilimitada escala custo ilimitado.
        throttlingBurstLimit: 50,
        throttlingRateLimit: 25,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
        allowMethods: ["GET", "OPTIONS"],
      },
    });

    /**
     * Sem `cacheKeyParameters`, o cache do API Gateway chaveia só pelo caminho
     * — e `/jobs?q=go` e `/jobs?q=rust` devolveriam a MESMA resposta. É a forma
     * mais rápida de transformar um cache em bug de dados. Cada parâmetro
     * precisa estar declarado em `requestParameters` para poder virar chave.
     */
    const queryParams = [
      "q",
      "stack",
      "seniority",
      "remote",
      "country",
      "salaryMin",
      "salaryMax",
      "salaryCurrency",
      "postedAfter",
      "postedBefore",
      "page",
      "size",
      "sort",
    ];

    api.root.addResource("jobs").addMethod("GET", new apigw.LambdaIntegration(searchFn), {
      requestParameters: Object.fromEntries(
        queryParams.map((name) => [`method.request.querystring.${name}`, false]),
      ),
      ...(props.apiCache
        ? {
            cacheKeyParameters: queryParams.map((name) => `method.request.querystring.${name}`),
          }
        : {}),
    });

    api.root.addResource("health").addMethod("GET", new apigw.LambdaIntegration(healthFn));

    // ---- Saídas ------------------------------------------------------------

    new CfnOutput(this, "CollectionEndpoint", {
      value: collectionEndpoint,
      description: "Endpoint de dados da coleção — usado pelas Lambdas via SigV4",
    });

    new CfnOutput(this, "SearchApiUrl", {
      value: api.url,
      description: "Base da API de busca",
    });
  }
}

/**
 * A `NodejsFunction` sempre cria uma role, mas o tipo diz `IRole | undefined`.
 * Falhar alto no synth é melhor que uma asserção de não-nulo: se um dia o
 * construct mudar, o erro aparece com nome de função e não como `undefined`
 * dentro de um JSON de política.
 */
function roleArnOf(fn: nodejs.NodejsFunction): string {
  if (!fn.role) {
    throw new Error(`Lambda ${fn.node.id} sem role de execução; não dá para liberar o índice`);
  }
  return fn.role.roleArn;
}
