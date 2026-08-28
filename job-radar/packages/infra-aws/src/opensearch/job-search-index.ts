import {
  type Currency,
  IndexedJob,
  type IndexedSalary,
  type JobQuery,
  PostingStatus,
  RemoteMode,
  type SalaryPeriod,
  type SearchHit,
  SearchIndexPort,
  type SearchIndexStatus,
  type SearchPage,
  Seniority,
} from "@job-radar/core";
import { JOB_INDEX_MAPPING, toIndexDocument } from "./job-index.mapping.js";
import { buildSearchBody } from "./job-query.dsl.js";
import type { OpenSearchClient } from "./opensearch.client.js";
import { OpenSearchHttpError } from "./opensearch.client.js";

const ALREADY_EXISTS = 400;

/**
 * Camada 2 — a porta do domínio implementada sobre o cliente assinado.
 *
 * Escreve sempre em `_bulk`, mesmo para um documento só: o projetor acorda com
 * um batch inteiro do Stream, e uma ida por documento seriam cem requisições
 * onde uma resolve. O custo de `_bulk` com um item é desprezível; o de cem
 * round-trips na Lambda, não.
 */
export class OpenSearchJobIndex extends SearchIndexPort {
  private ensured = false;

  constructor(
    private readonly client: OpenSearchClient,
    private readonly indexName: string,
  ) {
    super();
  }

  /**
   * Cria o índice com o mapeamento explícito, uma vez por cold start.
   *
   * Não é preguiça de não fazer isso no CDK: o CloudFormation não sabe criar
   * índice dentro de uma coleção sem um custom resource, e um custom resource
   * para um `PUT /indice` é mais peça móvel que o problema merece. Aqui a
   * criação é idempotente — índice já existente devolve 400
   * `resource_already_exists_exception`, que é sucesso para o efeito
   * pretendido — e acontece antes da primeira escrita, que é o único momento
   * em que o mapeamento ainda importa.
   */
  async ensureIndex(): Promise<void> {
    if (this.ensured) return;

    try {
      await this.client.request("PUT", `/${this.indexName}`, JSON.stringify(JOB_INDEX_MAPPING));
    } catch (error) {
      const alreadyThere =
        error instanceof OpenSearchHttpError &&
        error.status === ALREADY_EXISTS &&
        (error.body ?? "").includes("resource_already_exists_exception");

      if (!alreadyThere) throw error;
    }

    this.ensured = true;
  }

  async index(jobs: readonly IndexedJob[]): Promise<void> {
    if (jobs.length === 0) return;
    await this.ensureIndex();

    const ndjson = jobs
      .flatMap((job) => [
        // `_id` explícito é o que torna a projeção idempotente: reprojetar a
        // mesma vaga sobrescreve o documento em vez de duplicá-lo.
        JSON.stringify({ index: { _index: this.indexName, _id: job.id } }),
        JSON.stringify(toIndexDocument(job)),
      ])
      .join("\n");

    await this.submitBulk(`${ndjson}\n`);
  }

  async remove(jobIds: readonly string[]): Promise<void> {
    if (jobIds.length === 0) return;

    const ndjson = jobIds
      .map((id) => JSON.stringify({ delete: { _index: this.indexName, _id: id } }))
      .join("\n");

    await this.submitBulk(`${ndjson}\n`);
  }

  async search(query: JobQuery): Promise<SearchPage> {
    const response = await this.client.request(
      "POST",
      `/${this.indexName}/_search`,
      JSON.stringify(buildSearchBody(query)),
    );

    return readSearchResponse(response.body);
  }

  /**
   * `_search` com `size: 0` em vez de `_count`: devolve o mesmo número, é
   * suportado igualmente por coleção serverless e domínio gerenciado, e prova
   * de quebra que o caminho de LEITURA está de pé — que é justamente o que o
   * `/health` quer afirmar.
   */
  async status(): Promise<SearchIndexStatus> {
    const response = await this.client.request(
      "POST",
      `/${this.indexName}/_search`,
      JSON.stringify({ size: 0, track_total_hits: true, query: { match_all: {} } }),
    );

    const total = (response.body as { hits?: { total?: { value?: number } } })?.hits?.total?.value;
    return { index: this.indexName, documents: typeof total === "number" ? total : 0 };
  }

  /**
   * O `_bulk` responde HTTP 200 mesmo quando itens individuais falharam — é a
   * armadilha clássica da API. Ignorar `errors` deixaria o índice divergir do
   * catálogo em silêncio, então aqui a falha parcial vira exceção: o Stream
   * reentrega o batch, e a projeção é idempotente, então reentregar é seguro.
   */
  private async submitBulk(ndjson: string): Promise<void> {
    const response = await this.client.request("POST", "/_bulk", ndjson);
    const body = response.body as {
      errors?: boolean;
      items?: Array<Record<string, { status?: number; error?: unknown }>>;
    };

    if (!body?.errors) return;

    const failures = (body.items ?? [])
      .flatMap((item) => Object.values(item))
      .filter((outcome) => outcome.error)
      .map((outcome) => outcome.error);

    // Deletar id inexistente devolve 404 no item e NÃO é falha: o efeito
    // pretendido — o documento não estar lá — já vale.
    if (failures.length === 0) return;

    throw new OpenSearchHttpError(
      response.status,
      `_bulk com ${failures.length} item(ns) em falha`,
      JSON.stringify(failures.slice(0, 3)),
    );
  }
}

function readSearchResponse(raw: unknown): SearchPage {
  const body = raw as {
    hits?: {
      total?: { value?: number; relation?: string };
      hits?: Array<{ _source?: unknown; _score?: number | null }>;
    };
  };

  const hits: SearchHit[] = [];
  for (const entry of body?.hits?.hits ?? []) {
    const job = fromIndexDocument(entry._source);
    if (job) hits.push({ job, score: typeof entry._score === "number" ? entry._score : null });
  }

  return {
    hits,
    total: body?.hits?.total?.value ?? hits.length,
    totalIsLowerBound: body?.hits?.total?.relation === "gte",
  };
}

/**
 * Documento -> entidade. Devolve `null` para documento irrecuperável em vez de
 * lançar: um registro velho, de antes de uma mudança de mapeamento, não pode
 * derrubar a página inteira de resultados.
 */
function fromIndexDocument(raw: unknown): IndexedJob | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;

  const id = str(source.id);
  const title = str(source.title);
  if (!id || !title) return null;

  return IndexedJob.create({
    id,
    contentHash: str(source.contentHash) ?? "",
    status: enumOf(PostingStatus, str(source.status)) ?? PostingStatus.ACTIVE,
    sourceId: str(source.sourceId) ?? "",
    externalId: str(source.externalId) ?? "",
    url: str(source.url) ?? "",
    companyName: str(source.companyName) ?? "",
    companySlug: str(source.companySlug) ?? "",
    title,
    description: str(source.description) ?? "",
    locationRaw: str(source.locationRaw) ?? "",
    remote: enumOf(RemoteMode, str(source.remote)) ?? RemoteMode.UNKNOWN,
    country: str(source.country),
    city: str(source.city),
    seniority: enumOf(Seniority, str(source.seniority)) ?? Seniority.UNKNOWN,
    stack: Array.isArray(source.stack) ? source.stack.filter(isText) : [],
    employmentType: str(source.employmentType),
    salary: readSalary(source.salary),
    postedAt: str(source.postedAt),
    firstSeenAt: str(source.firstSeenAt) ?? "",
    lastSeenAt: str(source.lastSeenAt) ?? "",
  });
}

function readSalary(raw: unknown): IndexedSalary | null {
  if (!raw || typeof raw !== "object") return null;
  const salary = raw as Record<string, unknown>;

  const currency = str(salary.currency);
  const period = str(salary.period);
  if (!currency || !period) return null;

  return {
    minCents: typeof salary.minCents === "number" ? salary.minCents : null,
    maxCents: typeof salary.maxCents === "number" ? salary.maxCents : null,
    currency: currency as Currency,
    period: period as SalaryPeriod,
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function enumOf<T extends Record<string, string>>(
  enumeration: T,
  value: string | null,
): T[keyof T] | null {
  if (!value) return null;
  return (Object.values(enumeration) as string[]).includes(value) ? (value as T[keyof T]) : null;
}
