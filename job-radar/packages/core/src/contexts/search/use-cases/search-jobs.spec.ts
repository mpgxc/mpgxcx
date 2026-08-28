import { describe, expect, it } from "vitest";
import { ErrorType } from "../../../commons/business-error.js";
import { PostingStatus } from "../../ingestion/domain/entities/job-posting.js";
import { RemoteMode } from "../../ingestion/domain/value-objects/location.js";
import { Seniority } from "../../ingestion/domain/value-objects/seniority.js";
import { IndexedJob } from "../domain/entities/indexed-job.js";
import {
  SearchIndexPort,
  type SearchIndexStatus,
  type SearchPage,
} from "../domain/ports/search-index.port.js";
import type { JobQuery } from "../domain/value-objects/job-query.js";
import { SearchJobsUseCase } from "./search-jobs.use-case.js";

class FakeSearchIndex extends SearchIndexPort {
  readonly queries: JobQuery[] = [];

  constructor(private readonly page: SearchPage) {
    super();
  }

  async index(): Promise<void> {
    throw new Error("a busca não escreve");
  }

  async remove(): Promise<void> {
    throw new Error("a busca não escreve");
  }

  async search(query: JobQuery): Promise<SearchPage> {
    this.queries.push(query);
    return this.page;
  }

  async status(): Promise<SearchIndexStatus> {
    return { index: "jobs", documents: 0 };
  }
}

function hit(id: string) {
  return {
    score: 1.5,
    job: IndexedJob.create({
      id,
      contentHash: `hash-${id}`,
      status: PostingStatus.ACTIVE,
      sourceId: "lever",
      externalId: id,
      url: `https://jobs.lever.co/acme/${id}`,
      companyName: "Acme",
      companySlug: "acme",
      title: "Senior Backend Engineer",
      description: "Node.js e PostgreSQL",
      locationRaw: "São Paulo, SP",
      remote: RemoteMode.HYBRID,
      country: "BR",
      city: "São Paulo",
      seniority: Seniority.SENIOR,
      stack: ["node", "postgres"],
      employmentType: null,
      salary: null,
      postedAt: null,
      firstSeenAt: "2026-08-01T00:00:00.000Z",
      lastSeenAt: "2026-08-28T00:00:00.000Z",
    }),
  };
}

function pageOf(ids: readonly string[], total = ids.length, lowerBound = false): SearchPage {
  return { hits: ids.map(hit), total, totalIsLowerBound: lowerBound };
}

describe("SearchJobsUseCase", () => {
  it("valida a entrada crua e repassa a consulta entendida para a port", async () => {
    const index = new FakeSearchIndex(pageOf(["a", "b"]));

    const output = (
      await new SearchJobsUseCase(index).execute({
        text: "backend",
        stack: ["node"],
        remote: ["HYBRID"],
        size: 2,
      })
    ).unwrapOrThrow();

    expect(output.hits).toHaveLength(2);
    expect(output.query.stack).toEqual(["node"]);
    expect(output.query.remote).toEqual([RemoteMode.HYBRID]);
    expect(index.queries).toHaveLength(1);
    expect(index.queries[0]?.text).toBe("backend");
  });

  it("entrada inválida vira VALIDATION e o índice NEM é consultado", async () => {
    // A recusa acontece antes do I/O: consulta torta não deve custar uma
    // requisição ao cluster nem aparecer na latência da API.
    const index = new FakeSearchIndex(pageOf([]));

    const result = await new SearchJobsUseCase(index).execute({ seniority: ["ARQUIMAGO"] });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(ErrorType.VALIDATION);
    expect(index.queries).toEqual([]);
  });

  it("`hasMore` vem do tamanho da página, não do total", async () => {
    // O total pode ser limite inferior (o índice pára de contar num teto);
    // comparar contra ele daria "próxima página" para o vazio.
    const cheia = new FakeSearchIndex(pageOf(["a", "b"], 1000, true));
    const curta = new FakeSearchIndex(pageOf(["a"], 1000, true));

    const comMais = (await new SearchJobsUseCase(cheia).execute({ size: 2 })).unwrapOrThrow();
    const ultima = (await new SearchJobsUseCase(curta).execute({ size: 2 })).unwrapOrThrow();

    expect(comMais.hasMore).toBe(true);
    expect(comMais.totalIsLowerBound).toBe(true);
    expect(ultima.hasMore).toBe(false);
  });
});
