import { describe, expect, it } from "vitest";
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
import { ProjectJobChangesUseCase } from "./project-job-changes.use-case.js";

/** Registra as chamadas em vez de indexar — a asserção é o que foi pedido. */
class SpySearchIndex extends SearchIndexPort {
  readonly indexed: string[][] = [];
  readonly removed: string[][] = [];

  async index(jobs: readonly IndexedJob[]): Promise<void> {
    this.indexed.push(jobs.map((job) => job.id));
  }

  async remove(jobIds: readonly string[]): Promise<void> {
    this.removed.push([...jobIds]);
  }

  async search(_query: JobQuery): Promise<SearchPage> {
    throw new Error("o projetor não consulta");
  }

  async status(): Promise<SearchIndexStatus> {
    throw new Error("o projetor não checa saúde");
  }
}

function jobWith(id: string, status: PostingStatus): IndexedJob {
  return IndexedJob.create({
    id,
    contentHash: `hash-${id}`,
    status,
    sourceId: "greenhouse",
    externalId: "4242",
    url: "https://boards.greenhouse.io/acme/jobs/4242",
    companyName: "Acme",
    companySlug: "acme",
    title: "Staff Software Engineer",
    description: "Go, Kubernetes e um pouco de Terraform.",
    locationRaw: "Remoto - Brasil",
    remote: RemoteMode.REMOTE,
    country: "BR",
    city: null,
    seniority: Seniority.STAFF,
    stack: ["go", "kubernetes"],
    employmentType: "FULL_TIME",
    salary: null,
    postedAt: "2026-08-20T12:00:00.000Z",
    firstSeenAt: "2026-08-20T12:00:00.000Z",
    lastSeenAt: "2026-08-28T06:00:00.000Z",
  });
}

describe("ProjectJobChangesUseCase — vaga ativa", () => {
  it("indexa vaga ativa num único lote", async () => {
    const index = new SpySearchIndex();

    const output = (
      await new ProjectJobChangesUseCase(index).execute([
        { kind: "upserted", job: jobWith("a", PostingStatus.ACTIVE) },
        { kind: "upserted", job: jobWith("b", PostingStatus.ACTIVE) },
      ])
    ).unwrapOrThrow();

    expect(output).toEqual({ indexed: 2, removed: 0 });
    // Um lote, não uma chamada por documento: é o contrato da port.
    expect(index.indexed).toEqual([["a", "b"]]);
    expect(index.removed).toEqual([]);
  });

  it("não chama o índice quando não há mudança nenhuma", async () => {
    const index = new SpySearchIndex();

    const output = (await new ProjectJobChangesUseCase(index).execute([])).unwrapOrThrow();

    expect(output).toEqual({ indexed: 0, removed: 0 });
    expect(index.indexed).toEqual([]);
    expect(index.removed).toEqual([]);
  });
});

describe("ProjectJobChangesUseCase — a decisão sobre vaga expirada", () => {
  it("REMOVE do índice a vaga que expirou, em vez de marcá-la", async () => {
    // A decisão: "estar no índice" É "estar viva". Manter com flag obrigaria
    // toda consulta a lembrar de filtrar, e o dia em que alguém esquecer o
    // agregador manda um candidato para uma vaga que não existe mais.
    const index = new SpySearchIndex();

    const output = (
      await new ProjectJobChangesUseCase(index).execute([
        { kind: "upserted", job: jobWith("expirada", PostingStatus.EXPIRED) },
      ])
    ).unwrapOrThrow();

    expect(output).toEqual({ indexed: 0, removed: 1 });
    expect(index.removed).toEqual([["expirada"]]);
    expect(index.indexed).toEqual([]);
  });

  it("a linha apagada da tabela também sai do índice", async () => {
    const index = new SpySearchIndex();

    const output = (
      await new ProjectJobChangesUseCase(index).execute([{ kind: "removed", jobId: "sumiu" }])
    ).unwrapOrThrow();

    expect(output).toEqual({ indexed: 0, removed: 1 });
    expect(index.removed).toEqual([["sumiu"]]);
  });

  it("vaga que volta a ficar ativa é reindexada pelo mesmo caminho", async () => {
    // Reativação não tem tratamento especial: o documento volta com status
    // ACTIVE e é indexado como qualquer outro.
    const index = new SpySearchIndex();

    const output = (
      await new ProjectJobChangesUseCase(index).execute([
        { kind: "upserted", job: jobWith("ressuscitada", PostingStatus.ACTIVE) },
      ])
    ).unwrapOrThrow();

    expect(output).toEqual({ indexed: 1, removed: 0 });
    expect(index.indexed).toEqual([["ressuscitada"]]);
  });

  it("separa ativas e expiradas do mesmo lote em duas chamadas", async () => {
    const index = new SpySearchIndex();

    const output = (
      await new ProjectJobChangesUseCase(index).execute([
        { kind: "upserted", job: jobWith("viva", PostingStatus.ACTIVE) },
        { kind: "upserted", job: jobWith("morta", PostingStatus.EXPIRED) },
        { kind: "removed", jobId: "apagada" },
      ])
    ).unwrapOrThrow();

    expect(output).toEqual({ indexed: 1, removed: 2 });
    expect(index.indexed).toEqual([["viva"]]);
    expect(index.removed).toEqual([["morta", "apagada"]]);
  });
});
