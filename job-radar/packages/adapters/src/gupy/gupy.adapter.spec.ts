import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorType, type RawBatch, RemoteMode, Seniority } from "@job-radar/core";
import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../http/circuit-breaker.js";
import { GupyAdapter } from "./gupy.adapter.js";
import { GupyClient } from "./gupy.client.js";

const FIXTURE_DIR = fileURLToPath(new URL("../../../../fixtures/gupy/", import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(`${FIXTURE_DIR}${name}`, "utf8");
}

const FETCHED_AT = new Date("2026-07-28T00:00:00.000Z");

function makeBatch(payload: string, page = 0): RawBatch {
  return {
    task: { sourceId: "gupy", selector: "backend", page, runId: "run-1", params: {} },
    payload,
    contentType: "application/json",
    fetchedAt: FETCHED_AT,
    cache: { etag: null, lastModified: null },
    next: null,
  };
}

function makeAdapter(): GupyAdapter {
  // `parse` é puro, então os testes de parsing não tocam em HTTP.
  const client = new GupyClient(
    null as never,
    new CircuitBreaker("gupy", { failureThreshold: 3, cooldownMs: 1000 }),
  );
  return new GupyAdapter(client);
}

describe("GupyClient.buildUrl", () => {
  it("usa jobName como parâmetro de busca", () => {
    // Armadilha validada contra a API real: `name=` devolve HTTP 400.
    // Este teste existe para que ninguém "simplifique" o nome do parâmetro.
    const url = GupyClient.buildUrl({ term: "backend", offset: 0, limit: 100 });

    expect(url).toContain("jobName=backend");
    expect(url).not.toMatch(/[?&]name=/);
  });

  it("limita o page size ao teto aceito pelo portal", () => {
    const url = GupyClient.buildUrl({ term: "node", offset: 0, limit: 5000 });
    expect(url).toContain("limit=100");
  });
});

describe("GupyAdapter.discover", () => {
  it("recusa selector vazio em vez de buscar o catálogo inteiro", () => {
    const result = makeAdapter().discover(
      { sourceId: "gupy", selector: "  ", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(ErrorType.VALIDATION);
  });

  it("gera a primeira tarefa de paginação para o termo", () => {
    const result = makeAdapter().discover(
      { sourceId: "gupy", selector: "backend", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual([
        { sourceId: "gupy", selector: "backend", page: 0, runId: "run-1", params: {} },
      ]);
    }
  });
});

describe("GupyAdapter.parse — payload real gravado da fonte", () => {
  const adapter = makeAdapter();

  it("converte o payload real em JobPosting", () => {
    const result = adapter.parse(makeBatch(loadFixture("jobs-backend-page0.json")));

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value).toHaveLength(10);

    const [first] = result.value;
    expect(first).toBeDefined();
    if (!first) return;

    expect(first.props.source.id).toBe("gupy");
    expect(first.props.source.externalId).toBe("11714293");
    expect(first.props.company.name).toBe("Itaú Unibanco");
    expect(first.props.company.slug).toBe("itau-unibanco");
    expect(first.props.title).toContain("Backend");
    expect(first.props.source.url).toContain("gupy.io/job/");
  });

  it("mapeia workplaceType para RemoteMode sem adivinhar pelo texto", () => {
    const result = adapter.parse(makeBatch(loadFixture("jobs-backend-page0.json")));
    if (!result.isOk()) throw new Error("parse falhou");

    const modes = new Set(result.value.map((job) => job.props.location.remote));
    // A fixture contém on-site, hybrid e remote.
    expect(modes.has(RemoteMode.ONSITE)).toBe(true);
    expect([...modes].every((mode) => mode !== RemoteMode.UNKNOWN)).toBe(true);
  });

  it("traduz o país em português para ISO", () => {
    const result = adapter.parse(makeBatch(loadFixture("jobs-backend-page0.json")));
    if (!result.isOk()) throw new Error("parse falhou");

    const countries = new Set(result.value.map((job) => job.props.location.country));
    expect(countries.has("BR")).toBe(true);
    expect(countries.has("Brasil")).toBe(false);
  });

  it("deixa compensation nulo porque o portal não publica salário", () => {
    const result = adapter.parse(makeBatch(loadFixture("jobs-backend-page0.json")));
    if (!result.isOk()) throw new Error("parse falhou");

    expect(result.value.every((job) => job.props.compensation === null)).toBe(true);
  });

  it("extrai senioridade e stack da vaga real", () => {
    const result = adapter.parse(makeBatch(loadFixture("jobs-backend-page0.json")));
    if (!result.isOk()) throw new Error("parse falhou");

    const [first] = result.value;
    if (!first) throw new Error("fixture vazia");

    // "Engenharia de Software Backend Java/Kotlin Sr | ..."
    expect(first.seniority).toBe(Seniority.SENIOR);
    expect(first.stack).toContain("java");
    expect(first.stack).toContain("kotlin");
  });

  it("é determinístico: o mesmo payload gera os mesmos hashes", () => {
    const payload = loadFixture("jobs-backend-page0.json");
    const a = adapter.parse(makeBatch(payload));
    const b = adapter.parse(makeBatch(payload));
    if (!a.isOk() || !b.isOk()) throw new Error("parse falhou");

    expect(a.value.map((j) => j.id)).toEqual(b.value.map((j) => j.id));
    // É esta estabilidade que faz ~98% da rodada diária cair em `unchanged`.
    expect(a.value.map((j) => j.contentHash)).toEqual(b.value.map((j) => j.contentHash));
  });

  it("aceita resposta vazia sem erro (busca sem resultado é legítima)", () => {
    const result = adapter.parse(makeBatch(loadFixture("jobs-empty.json")));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });
});

describe("GupyAdapter.fetch — paginação", () => {
  function makeAdapterWithPage(itemCount: number, reportedTotal: number): GupyAdapter {
    const body = JSON.stringify({
      data: Array.from({ length: itemCount }, (_, index) => ({
        id: index,
        name: "Dev",
        jobUrl: "https://x",
        careerPageName: "ACME",
      })),
      pagination: { total: reportedTotal, limit: 100, offset: 0 },
    });

    const client = {
      listJobs: async () => ({
        status: 200,
        body,
        contentType: "application/json",
        etag: null,
        lastModified: null,
      }),
    };

    return new GupyAdapter(client as unknown as GupyClient);
  }

  const task = { sourceId: "gupy", selector: "desenvolvedor", page: 0, runId: "r", params: {} };
  const noCache = { etag: null, lastModified: null };

  it("continua quando a página vem cheia, mesmo com total mentindo", async () => {
    // Medido na API real: com limit=100 a fonte reporta total=100 enquanto os
    // offsets 0/100/200 devolvem 100 itens distintos cada. Confiar no total
    // pararia na página 0 e perderia centenas de vagas em silêncio.
    const result = await makeAdapterWithPage(100, 100).fetch(task, noCache);

    expect(result.isOk()).toBe(true);
    if (!result.isOk() || result.value.kind !== "fetched") throw new Error("fetch falhou");
    expect(result.value.batch.next).toEqual({ ...task, page: 1 });
  });

  it("para quando a página vem incompleta", async () => {
    const result = await makeAdapterWithPage(82, 100).fetch(task, noCache);

    if (!result.isOk() || result.value.kind !== "fetched") throw new Error("fetch falhou");
    expect(result.value.batch.next).toBeNull();
  });

  it("para numa página vazia", async () => {
    const result = await makeAdapterWithPage(0, 100).fetch(task, noCache);

    if (!result.isOk() || result.value.kind !== "fetched") throw new Error("fetch falhou");
    expect(result.value.batch.next).toBeNull();
  });

  it("respeita o teto de páginas para não paginar infinitamente", async () => {
    const result = await makeAdapterWithPage(100, 100).fetch({ ...task, page: 49 }, noCache);

    if (!result.isOk() || result.value.kind !== "fetched") throw new Error("fetch falhou");
    expect(result.value.batch.next).toBeNull();
  });
});

describe("GupyAdapter.parse — deriva de contrato", () => {
  const adapter = makeAdapter();

  it("reporta SOURCE_CONTRACT_DRIFT quando o corpo não é JSON", () => {
    const result = adapter.parse(makeBatch("<html>502 Bad Gateway</html>"));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe(ErrorType.SOURCE_CONTRACT_DRIFT);
      // Deriva de contrato NÃO é retentável: retentar devolve o mesmo payload.
      expect(result.error.retryable).toBe(false);
    }
  });

  it("reporta o campo exato que sumiu, não uma falha genérica", () => {
    const result = adapter.parse(makeBatch(JSON.stringify({ jobs: [], pagination: {} })));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("'data'");
  });

  it("detecta mudança de tipo dentro de um item", () => {
    const payload = JSON.stringify({
      data: [{ id: "11714293", name: "Dev", jobUrl: "x", careerPageName: "ACME" }],
      pagination: { total: 1, limit: 10, offset: 0 },
    });

    const result = adapter.parse(makeBatch(payload));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("data[0].id");
  });
});
