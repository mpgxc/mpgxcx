import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorType, type RawBatch, RemoteMode } from "@job-radar/core";
import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../http/circuit-breaker.js";
import { SourceHttpError } from "../http/http-client.js";
import { WorkableAdapter } from "./workable.adapter.js";
import { WorkableClient } from "./workable.client.js";

const FIXTURE_DIR = fileURLToPath(new URL("../../../../fixtures/workable/", import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(`${FIXTURE_DIR}${name}`, "utf8");
}

const FETCHED_AT = new Date("2026-08-25T00:00:00.000Z");

function makeBatch(payload: string, slug = "blueground"): RawBatch {
  return {
    task: { sourceId: "workable", selector: slug, page: 0, runId: "run-1", params: {} },
    payload,
    contentType: "application/json",
    fetchedAt: FETCHED_AT,
    cache: { etag: null, lastModified: null },
    next: null,
  };
}

function makeAdapter(): WorkableAdapter {
  // `parse` é puro, então os testes de parsing não tocam em HTTP.
  const client = new WorkableClient(
    null as never,
    new CircuitBreaker("workable", { failureThreshold: 3, cooldownMs: 1000 }),
  );
  return new WorkableAdapter(client);
}

describe("WorkableClient.buildUrl", () => {
  it("mantém o parâmetro sem o qual a descrição da vaga não vem", () => {
    // Medido na conta `blueground`: sem `details=true` o item não tem a chave
    // `description` e o corpo cai de 146.824 para 17.977 bytes. Este teste
    // existe para que ninguém "limpe" a URL e emudeça o catálogo em silêncio.
    const url = WorkableClient.buildUrl({ slug: "blueground" });

    expect(url).toBe("https://apply.workable.com/api/v1/widget/accounts/blueground?details=true");
  });

  it("escapa o slug em vez de concatenar texto na URL", () => {
    const url = WorkableClient.buildUrl({ slug: "a b/c" });
    expect(url).toContain("/accounts/a%20b%2Fc?");
  });
});

describe("WorkableAdapter.discover", () => {
  it("emite exatamente UMA tarefa por slug — o widget é dump completo", () => {
    const result = makeAdapter().discover(
      { sourceId: "workable", selector: "blueground", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value).toEqual([
      { sourceId: "workable", selector: "blueground", page: 0, runId: "run-1", params: {} },
    ]);
  });

  it("recusa selector vazio", () => {
    const result = makeAdapter().discover(
      { sourceId: "workable", selector: "  ", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(ErrorType.VALIDATION);
  });

  it("recusa slug com caractere que não cabe na URL da conta", () => {
    const result = makeAdapter().discover(
      { sourceId: "workable", selector: "blueground?details=false", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(ErrorType.VALIDATION);
  });
});

describe("WorkableAdapter.parse — recorte real da conta blueground", () => {
  const adapter = makeAdapter();
  /**
   * RECORTE, não conta completa: `blueground` tem 26 vagas. Foram mantidas 8
   * escolhidas por cobrirem o que o mapper decide — vaga remota com cidade
   * vazia, quatro países, `employment_type` em branco e uma vaga de engenharia
   * com stack no texto.
   */
  const payload = loadFixture("account-blueground-recorte.json");

  function parsed() {
    const result = adapter.parse(makeBatch(payload));
    if (!result.isOk()) throw new Error("parse falhou");
    return result.value;
  }

  it("converte o recorte inteiro em JobPosting", () => {
    const jobs = parsed();

    expect(jobs).toHaveLength(8);

    const engineer = jobs.find((job) => job.props.title === "Full-Stack Software Engineer");
    if (!engineer) throw new Error("vaga esperada sumiu do recorte");

    expect(engineer.props.source.id).toBe("workable");
    // O id público do Workable é o `shortcode`, não um número.
    expect(engineer.props.source.externalId).toBe("3C3D8183F6");
    expect(engineer.props.source.url).toBe("https://apply.workable.com/j/3C3D8183F6");
  });

  it("usa o nome da empresa que a fonte publica, e o slug da tarefa como identidade", () => {
    // É a única das quatro fontes deste PR que publica o nome da empresa.
    const result = adapter.parse(makeBatch(payload, "outro-slug"));
    if (!result.isOk()) throw new Error("parse falhou");

    expect(result.value.every((job) => job.props.company.name === "Blueground")).toBe(true);
    expect(result.value.every((job) => job.props.company.slug === "outro-slug")).toBe(true);
  });

  it("usa a descrição da VAGA, não a da empresa que vem no topo", () => {
    const jobs = parsed();
    const textos = new Set(jobs.map((job) => job.props.description.text));

    // Se o mapper lesse a `description` do topo, as 8 vagas teriam o mesmo
    // texto — e o `contentHash` de todas mudaria junto, ou nunca.
    expect(textos.size).toBe(8);
    expect(jobs.every((job) => !job.props.description.isEmpty)).toBe(true);
  });

  it("remonta o texto de localização pulando as partes em branco", () => {
    const jobs = parsed();

    // Vaga remota nos EUA: `city` e `state` vêm "" no payload real. Sem o
    // filtro, `raw` seria ", , United States" e a cidade inferida seria vazia.
    const remota = jobs.find((job) => job.props.title === "Business Development Representative");
    if (!remota) throw new Error("vaga esperada sumiu do recorte");

    expect(remota.props.location.raw).toBe("United States");
    expect(remota.props.location.remote).toBe(RemoteMode.REMOTE);
  });

  it("usa o countryCode em ISO-2 que a fonte entrega pronto", () => {
    const jobs = parsed();

    const atenas = jobs.find((job) => job.props.title === "Full-Stack Software Engineer");
    if (!atenas) throw new Error("vaga esperada sumiu do recorte");

    // "Greece" não está na tabela de dicas do `Location` — só chega a GR porque
    // `locations[0].countryCode` vem preenchido.
    expect(atenas.props.location.country).toBe("GR");
    expect(atenas.props.location.city).toBe("Athens");
  });

  it("não afirma presencial quando a fonte só diz que não é remoto", () => {
    const jobs = parsed();

    // `telecommuting: false` é a ausência de um sinal, não a afirmação do
    // oposto — o widget não tem equivalente de "híbrido" nem de "presencial".
    const presencial = jobs.find((job) => job.props.title === "Guest Operations Specialist");
    if (!presencial) throw new Error("vaga esperada sumiu do recorte");

    expect(presencial.props.location.remote).toBe(RemoteMode.UNKNOWN);
  });

  it("traduz employment_type e trata o valor em branco como ausência", () => {
    const jobs = parsed();

    const cheia = jobs.find((job) => job.props.title === "Full-Stack Software Engineer");
    const semTipo = jobs.find((job) => job.props.title === "Operations Lead - Los Angeles");
    if (!cheia || !semTipo) throw new Error("vaga esperada sumiu do recorte");

    expect(cheia.props.employmentType).toBe("FULL_TIME");
    // No payload real esta vaga tem `employment_type: ""`.
    expect(semTipo.props.employmentType).toBeNull();
  });

  it("lê published_on, que é data sem hora", () => {
    const jobs = parsed();

    const engineer = jobs.find((job) => job.props.title === "Full-Stack Software Engineer");
    if (!engineer) throw new Error("vaga esperada sumiu do recorte");

    expect(engineer.props.postedAt?.toISOString()).toBe("2026-06-12T00:00:00.000Z");
  });

  it("deixa compensation nulo porque o widget não publica salário", () => {
    expect(parsed().every((job) => job.props.compensation === null)).toBe(true);
  });

  it("extrai stack de dentro da descrição, que só existe com details=true", () => {
    const jobs = parsed();

    const engineer = jobs.find((job) => job.props.title === "Full-Stack Software Engineer");
    if (!engineer) throw new Error("vaga esperada sumiu do recorte");

    // Nenhum destes termos está no título: vieram do HTML da descrição.
    expect(engineer.stack.length).toBeGreaterThan(0);
  });

  it("é determinístico: o mesmo payload gera os mesmos hashes", () => {
    const a = adapter.parse(makeBatch(payload));
    const b = adapter.parse(makeBatch(payload));
    if (!a.isOk() || !b.isOk()) throw new Error("parse falhou");

    expect(a.value.map((job) => job.id)).toEqual(b.value.map((job) => job.id));
    // É esta estabilidade que faz ~98% da rodada diária cair em `unchanged`.
    expect(a.value.map((job) => job.contentHash)).toEqual(b.value.map((job) => job.contentHash));
  });
});

describe("WorkableAdapter.parse — a mesma conta SEM details=true", () => {
  const adapter = makeAdapter();

  it("acusa a perda do parâmetro em vez de gravar 8 vagas mudas", () => {
    /**
     * Fixture REAL da mesma conta e das mesmas 8 vagas, buscada sem
     * `details=true`. É o par que prova a armadilha: o corpo é JSON válido, tem
     * as vagas, tem título e cidade — e não tem descrição nenhuma. Sem esta
     * guarda o pipeline continuaria rodando e entregaria um catálogo sem texto,
     * onde `extractStack` e `inferSeniority` só enxergariam o título.
     */
    const result = adapter.parse(loadBatchSemDetails());

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;

    expect(result.error.type).toBe(ErrorType.SOURCE_CONTRACT_DRIFT);
    expect(result.error.message).toContain("details=true");
  });

  it("o payload sem details é JSON válido e traz as mesmas vagas", () => {
    // Deixa explícito que a diferença é só a descrição — o resto passaria.
    const semDetails = JSON.parse(loadFixture("account-blueground-sem-details-recorte.json"));
    const comDetails = JSON.parse(loadFixture("account-blueground-recorte.json"));

    const codes = (payload: { jobs: { shortcode: string }[] }) =>
      payload.jobs.map((job) => job.shortcode).sort();

    expect(semDetails.jobs).toHaveLength(comDetails.jobs.length);
    // Ordenado porque a fonte devolve as vagas em ordens diferentes entre as
    // duas chamadas — o que importa é serem as MESMAS vagas.
    expect(codes(semDetails)).toEqual(codes(comDetails));
    expect(semDetails.jobs.every((job: object) => !("description" in job))).toBe(true);
  });

  function loadBatchSemDetails(): RawBatch {
    return makeBatch(loadFixture("account-blueground-sem-details-recorte.json"));
  }
});

describe("WorkableAdapter — conta vazia versus slug inexistente", () => {
  const adapter = makeAdapter();

  it("aceita conta vazia sem erro: HTTP 200 com jobs:[] é conta sem vaga publicada", () => {
    // Fixture real da conta `acme-corp`, que existe e não publica vaga nenhuma.
    // Note `description: null` no topo — nada pode assumir que é string.
    const result = adapter.parse(makeBatch(loadFixture("account-vazio.json"), "acme-corp"));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });

  it("trata o 404 da conta como config inválida, olhando o status e não o corpo", async () => {
    // Comportamento real medido com slug de lixo e com `workable`/`pipedrive`:
    // HTTP 404 com corpo `Not Found` em text/plain — não é JSON.
    const body = loadFixture("slug-inexistente.txt");
    expect(() => JSON.parse(body)).toThrow();

    const client = {
      listJobs: async () => {
        throw new SourceHttpError(404, "HTTP 404 em https://apply.workable.com/...", body);
      },
    };

    const result = await new WorkableAdapter(client as unknown as WorkableClient).fetch(
      { sourceId: "workable", selector: "conta-que-nao-existe", page: 0, runId: "r", params: {} },
      { etag: null, lastModified: null },
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;

    expect(result.error.type).toBe(ErrorType.VALIDATION);
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toContain("conta-que-nao-existe");
  });
});

describe("WorkableAdapter.fetch — limite de taxa e dump completo", () => {
  const task = { sourceId: "workable", selector: "blueground", page: 0, runId: "r", params: {} };
  const noCache = { etag: null, lastModified: null };

  it("trata o 429 do Cloudflare como indisponibilidade retentável", async () => {
    // Medido: ~10 requisições em poucos minutos devolvem HTTP 429 com corpo
    // `error code: 1015` e `retry-after` de mais de seis horas. Retentável é a
    // classificação certa mesmo sabendo que a retentativa da rodada não passa:
    // é ela que deixa a rodada incompleta e impede o sweeper de expirar.
    const client = {
      listJobs: async () => {
        throw new SourceHttpError(429, "HTTP 429", "error code: 1015");
      },
    };

    const result = await new WorkableAdapter(client as unknown as WorkableClient).fetch(
      task,
      noCache,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;

    expect(result.error.type).toBe(ErrorType.SOURCE_UNAVAILABLE);
    expect(result.error.retryable).toBe(true);
  });

  it("nunca devolve continuação: o widget é dump completo", async () => {
    const client = {
      listJobs: async () => ({
        status: 200,
        body: loadFixture("account-blueground-recorte.json"),
        contentType: "application/json",
        etag: 'W/"abc"',
        lastModified: null,
      }),
    };

    const result = await new WorkableAdapter(client as unknown as WorkableClient).fetch(
      task,
      noCache,
    );

    if (!result.isOk() || result.value.kind !== "fetched") throw new Error("fetch falhou");
    expect(result.value.batch.next).toBeNull();
  });

  it("propaga o 304 como not-modified em vez de tratar como erro", async () => {
    const client = {
      listJobs: async () => ({
        status: 304,
        body: "",
        contentType: "",
        etag: null,
        lastModified: null,
      }),
    };

    const result = await new WorkableAdapter(client as unknown as WorkableClient).fetch(task, {
      etag: 'W/"abc"',
      lastModified: null,
    });

    if (!result.isOk()) throw new Error("fetch falhou");
    expect(result.value.kind).toBe("not-modified");
  });
});

describe("WorkableAdapter.parse — deriva de contrato", () => {
  const adapter = makeAdapter();

  it("reporta SOURCE_CONTRACT_DRIFT quando o corpo não é JSON", () => {
    const result = adapter.parse(makeBatch("error code: 1015"));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe(ErrorType.SOURCE_CONTRACT_DRIFT);
      // Deriva de contrato NÃO é retentável: retentar devolve o mesmo payload.
      expect(result.error.retryable).toBe(false);
    }
  });

  it("reporta o campo exato que sumiu, não uma falha genérica", () => {
    const result = adapter.parse(makeBatch(JSON.stringify({ name: "ACME", positions: [] })));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("'jobs'");
  });

  it("acusa a perda de details=true na fixture deformada", () => {
    const result = adapter.parse(makeBatch(loadFixture("account-deformado.json")));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("details=true");
  });

  it("acusa shortcode ausente, que é o que identifica a vaga", () => {
    const payload = JSON.stringify({
      name: "ACME",
      jobs: [{ title: "Dev", url: "https://x", description: "<p>x</p>" }],
    });

    const result = adapter.parse(makeBatch(payload));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("jobs[0].shortcode");
  });
});
