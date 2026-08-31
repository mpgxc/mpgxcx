import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  type Currency,
  IndexedJob,
  type IndexedSalary,
  type JobChange,
  Money,
  PostingStatus,
  RemoteMode,
  type SalaryPeriod,
  Seniority,
} from "@job-radar/core";
import { isContentChange } from "./job.repository.js";
import { TABLE_KEYS } from "./single-table.js";

/**
 * Uma imagem do Stream já desmarshalada (`unmarshall`). O tipo é aberto de
 * propósito: o que chega aqui é dado externo, e tratá-lo como `unknown` por
 * campo é o que obriga a validar em vez de confiar.
 */
export type StreamImage = Readonly<Record<string, unknown>>;

export type JobStreamIgnoreReason =
  /** Item da tabela única que não é vaga: cache, fonte, placar, ponteiro. */
  | "nao-e-vaga"
  /** `contentHash` igual e status igual: a rodada só recarimbou `lastSeenAt`. */
  | "conteudo-inalterado"
  /** Evento sem a imagem nova, ou com campo obrigatório ausente. */
  | "imagem-inutilizavel";

export type JobStreamDecision =
  | { readonly kind: "project"; readonly change: JobChange }
  | { readonly kind: "ignore"; readonly reason: JobStreamIgnoreReason };

/** O recorte de um `DynamoDBRecord` que interessa, sem depender do tipo Lambda. */
export interface JobStreamRecord {
  readonly eventName?: string | undefined;
  readonly keys?: StreamImage | undefined;
  readonly oldImage?: StreamImage | undefined;
  readonly newImage?: StreamImage | undefined;
}

/**
 * Formato do Stream (atributos marshalados, `{"S": "..."}`) -> objeto plano.
 *
 * Fica neste pacote, e não no handler, porque desmarshalar é conhecimento de
 * DynamoDB. O handler não deve importar `@aws-sdk/util-dynamodb` só para
 * conseguir ler o próprio evento — e, mantida aqui, a decodificação continua
 * testável sem tipo de Lambda nenhum.
 */
export function toJobStreamRecord(record: {
  eventName?: string | undefined;
  dynamodb?:
    | {
        Keys?: Record<string, unknown> | undefined;
        OldImage?: Record<string, unknown> | undefined;
        NewImage?: Record<string, unknown> | undefined;
      }
    | undefined;
}): JobStreamRecord {
  const plain = (image: Record<string, unknown> | undefined): StreamImage | undefined =>
    image ? unmarshall(image as Record<string, AttributeValue>) : undefined;

  return {
    eventName: record.eventName,
    keys: plain(record.dynamodb?.Keys),
    oldImage: plain(record.dynamodb?.OldImage),
    newImage: plain(record.dynamodb?.NewImage),
  };
}

/**
 * Traduz um registro do Stream na decisão de projeção.
 *
 * Função PURA — sem SDK, sem relógio, sem I/O. É onde mora a economia inteira
 * do projetor, então é onde os testes batem.
 *
 * A ordem das guardas não é arbitrária:
 *
 * 1. Não é vaga -> ignora. O Stream é da tabela ÚNICA e a maioria absoluta dos
 *    eventos numa rodada não é vaga nenhuma.
 * 2. REMOVE -> tira do índice. Só as chaves chegam nesse evento.
 * 3. Status mudou -> projeta, ANTES de olhar `contentHash`. Esta é a guarda
 *    fácil de esquecer e cara de descobrir: `expireNotSeenIn` escreve apenas
 *    `status`, `gsi1pk` e `expiredAt` — NÃO toca no `contentHash`. Se o
 *    curto-circuito viesse primeiro, toda expiração seria classificada como
 *    "conteúdo inalterado" e a vaga morta ficaria no índice para sempre.
 * 4. `contentHash` igual -> ignora. Este é o curto-circuito que justifica o
 *    projetor existir: o `upsert` grava em TODA rodada para carimbar
 *    `lastSeenAt`, então o Stream dispara para o catálogo inteiro todo dia,
 *    e ~98% desses eventos não mudaram nada. Reindexar os 98% é exatamente o
 *    desperdício que o `contentHash` foi criado para evitar.
 *
 * Na dúvida, ignora: um documento que não entrou no índice reaparece na
 * próxima mudança real ou numa reconstrução completa a partir do DynamoDB.
 * Um documento errado no índice fica errado até alguém perceber.
 */
export function decodeJobStreamRecord(record: JobStreamRecord): JobStreamDecision {
  if (!TABLE_KEYS.isJobKey(record.keys)) {
    return { kind: "ignore", reason: "nao-e-vaga" };
  }

  const jobId = TABLE_KEYS.jobIdFromKey(record.keys as StreamImage);

  if (record.eventName === "REMOVE") {
    return { kind: "project", change: { kind: "removed", jobId } };
  }

  const newImage = record.newImage;
  if (!newImage) return { kind: "ignore", reason: "imagem-inutilizavel" };

  /**
   * Sem `contentHash` não dá nem para decidir. `isContentChange` responde
   * `false` nesse caso — o que é o padrão seguro dela —, e classificar a linha
   * como "conteúdo inalterado" esconderia uma linha corrompida atrás da
   * estatística normal do curto-circuito. A distinção importa: uma é o caminho
   * feliz de 98% dos eventos, a outra é dado quebrado que merece log.
   */
  if (!str(newImage.contentHash)) return { kind: "ignore", reason: "imagem-inutilizavel" };

  const statusChanged = str(record.oldImage?.status) !== str(newImage.status);

  if (!statusChanged && !isContentChange(hashOf(record.oldImage), hashOf(newImage))) {
    return { kind: "ignore", reason: "conteudo-inalterado" };
  }

  const job = toIndexedJob(jobId, newImage);
  if (!job) return { kind: "ignore", reason: "imagem-inutilizavel" };

  return { kind: "project", change: { kind: "upserted", job } };
}

/**
 * Imagem do DynamoDB -> documento de busca.
 *
 * Devolve `null` em vez de lançar quando falta campo obrigatório: uma linha
 * torta (escrita por uma versão antiga do repositório, ou por um script manual)
 * não pode derrubar o batch inteiro do Stream. O projetor loga e segue.
 */
export function toIndexedJob(jobId: string, image: StreamImage): IndexedJob | null {
  const contentHash = str(image.contentHash);
  const title = str(image.title);
  const sourceId = str(image.sourceId);
  if (!contentHash || !title || !sourceId) return null;

  const status = enumOf(PostingStatus, str(image.status));
  if (!status) return null;

  return IndexedJob.create({
    id: jobId,
    contentHash,
    status,
    sourceId,
    externalId: str(image.externalId) ?? "",
    url: str(image.url) ?? "",
    companyName: str(image.companyName) ?? "",
    companySlug: str(image.companySlug) ?? "",
    title,
    description: str(image.descriptionText) ?? "",
    locationRaw: str(image.locationRaw) ?? "",
    remote: enumOf(RemoteMode, str(image.remoteMode)) ?? RemoteMode.UNKNOWN,
    country: str(image.country),
    city: str(image.city),
    seniority: enumOf(Seniority, str(image.seniority)) ?? Seniority.UNKNOWN,
    stack: Array.isArray(image.stack) ? image.stack.filter(isNonEmptyString) : [],
    employmentType: str(image.employmentType),
    salary: toIndexedSalary(image.compensation),
    postedAt: str(image.postedAt),
    firstSeenAt: str(image.firstSeenAt) ?? str(image.lastSeenAt) ?? "",
    lastSeenAt: str(image.lastSeenAt) ?? "",
  });
}

/**
 * A faixa só entra no índice quando é comparável: sem moeda conhecida, os
 * centavos não significam nada e um filtro de range mentiria. Descartar é
 * melhor que indexar um número sem unidade.
 */
function toIndexedSalary(raw: unknown): IndexedSalary | null {
  if (!raw || typeof raw !== "object") return null;

  const compensation = raw as Record<string, unknown>;
  const currency = str(compensation.currency)?.toUpperCase() ?? "";
  if (!Money.isCurrency(currency)) return null;

  const period = str(compensation.period);
  if (period !== "HOUR" && period !== "MONTH" && period !== "YEAR") return null;

  const minCents = cents(compensation.minCents);
  const maxCents = cents(compensation.maxCents);
  if (minCents === null && maxCents === null) return null;

  return { minCents, maxCents, currency: currency as Currency, period: period as SalaryPeriod };
}

function hashOf(image: StreamImage | undefined): { contentHash?: string } | undefined {
  if (!image) return undefined;
  const contentHash = str(image.contentHash);
  return contentHash ? { contentHash } : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * O DocumentClient devolve número do DynamoDB como `number`, mas uma linha
 * gravada por outro caminho pode trazer string — aceitar as duas formas é mais
 * barato que descobrir a divergência com um filtro de salário quebrado.
 */
function cents(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function enumOf<T extends Record<string, string>>(
  enumeration: T,
  value: string | null,
): T[keyof T] | null {
  if (!value) return null;
  const known = Object.values(enumeration) as string[];
  return known.includes(value) ? (value as T[keyof T]) : null;
}
