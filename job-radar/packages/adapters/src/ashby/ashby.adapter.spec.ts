import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorType, type RawBatch, RemoteMode } from "@job-radar/core";
import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../http/circuit-breaker.js";
import { SourceHttpError } from "../http/http-client.js";
import { AshbyAdapter } from "./ashby.adapter.js";
import { AshbyClient } from "./ashby.client.js";

const FIXTURE_DIR = fileURLToPath(new URL("../../../../fixtures/ashby/", import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(`${FIXTURE_DIR}${name}`, "utf8");
}

const FETCHED_AT = new Date("2026-08-25T00:00:00.000Z");

function makeBatch(payload: string, slug = "ramp"): RawBatch {
  return {
    task: { sourceId: "ashby", selector: slug, page: 0, runId: "run-1", params: {} },
    payload,
    contentType: "application/json",
    fetchedAt: FETCHED_AT,
    cache: { etag: null, lastModified: null },
    next: null,
  };
}

function makeAdapter(): AshbyAdapter {
  // `parse` é puro, então os testes de parsing não tocam em HTTP.
  const client = new AshbyClient(
    null as never,
    new CircuitBreaker("ashby", { failureThreshold: 3, cooldownMs: 1000 }),
  );
  return new AshbyAdapter(client);
}

describe("AshbyClient.buildUrl", () => {
  it("mantém o parâmetro que a fonte exige para devolver a faixa salarial", () => {
    // Medido na API real: sem `includeCompensation=true` a chave `compensation`
    // some do item inteiro. Este teste existe para que ninguém "limpe" a URL e
    // apague o salário de todas as vagas em silêncio.
    const url = AshbyClient.buildUrl({ slug: "ramp" });

    expect(url).toBe("https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true");
  });

  it("escapa o slug em vez de concatenar texto na URL", () => {
    const url = AshbyClient.buildUrl({ slug: "a b/c" });
    expect(url).toContain("/job-board/a%20b%2Fc?");
  });
});

describe("AshbyAdapter.discover", () => {
  it("emite exatamente UMA tarefa por slug — o endpoint é dump completo", () => {
    const result = makeAdapter().discover(
      { sourceId: "ashby", selector: "openai", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value).toEqual([
      { sourceId: "ashby", selector: "openai", page: 0, runId: "run-1", params: {} },
    ]);
  });

  it("recusa selector vazio", () => {
    const result = makeAdapter().discover(
      { sourceId: "ashby", selector: "  ", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(ErrorType.VALIDATION);
  });

  it("recusa slug com caractere que não cabe na URL do board", () => {
    const result = makeAdapter().discover(
      { sourceId: "ashby", selector: "ramp?includeCompensation=false", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(ErrorType.VALIDATION);
  });
});

describe("AshbyAdapter.parse — recorte real do board ramp", () => {
  const adapter = makeAdapter();
  /**
   * RECORTE, não board completo: `ramp` tem 135 vagas. Foram mantidas 7
   * escolhidas por serem as únicas que cobrem a variedade do board —
   * `workplaceType` Remote/Hybrid/OnSite, contrato FullTime/Intern/Contract/
   * Temporary, faixa mensal e anual, vaga sem faixa, e componentes de equity
   * misturados aos de salário.
   */
  const payload = loadFixture("board-ramp-recorte.json");

  function parsed() {
    const result = adapter.parse(makeBatch(payload));
    if (!result.isOk()) throw new Error("parse falhou");
    return result.value;
  }

  it("converte o recorte inteiro em JobPosting", () => {
    const jobs = parsed();

    expect(jobs).toHaveLength(7);

    const engineer = jobs.find(
      (job) => job.props.title === "Software Engineer, Security, Stablecoin",
    );
    if (!engineer) throw new Error("vaga esperada sumiu do recorte");

    expect(engineer.props.source.id).toBe("ashby");
    expect(engineer.props.source.externalId).toBe("d1183b00-6590-4fe4-a585-28d84e578fe3");
    expect(engineer.props.source.url).toContain("jobs.ashbyhq.com/ramp/");
    expect(engineer.props.company.slug).toBe("ramp");
  });

  it("apara o espaço à esquerda que o board publica em parte dos títulos", () => {
    const jobs = parsed();

    // No payload real o título vem como " Security Engineer, Cloud".
    expect(jobs.some((job) => job.props.title === "Security Engineer, Cloud")).toBe(true);
    expect(jobs.every((job) => job.props.title === job.props.title.trim())).toBe(true);
  });

  it("dá precedência a workplaceType sobre isRemote, que é menos específico", () => {
    const jobs = parsed();

    // No payload real esta vaga é `Hybrid` COM `isRemote: true`. Híbrido é a
    // informação útil; ler `isRemote` primeiro a classificaria como remota.
    const intern = jobs.find((job) => job.props.title.startsWith("Software Engineer Internship"));
    if (!intern) throw new Error("vaga esperada sumiu do recorte");

    expect(intern.props.location.remote).toBe(RemoteMode.HYBRID);
  });

  it("mapeia os três valores de workplaceType", () => {
    const jobs = parsed();
    const modes = new Set(jobs.map((job) => job.props.location.remote));

    expect(modes.has(RemoteMode.REMOTE)).toBe(true);
    expect(modes.has(RemoteMode.HYBRID)).toBe(true);
    expect(modes.has(RemoteMode.ONSITE)).toBe(true);
    expect(modes.has(RemoteMode.UNKNOWN)).toBe(false);
  });

  it("traduz employmentType para a taxonomia do domínio", () => {
    const jobs = parsed();
    const types = new Set(jobs.map((job) => job.props.employmentType));

    expect(types.has("FULL_TIME")).toBe(true);
    expect(types.has("INTERNSHIP")).toBe(true);
    expect(types.has("CONTRACT")).toBe(true);
    expect(types.has("TEMPORARY")).toBe(true);
  });

  it("ignora componentes que não são salário ao montar a faixa", () => {
    const jobs = parsed();

    // No payload real esta vaga tem EquityCashValue (min/max nulos) ANTES do
    // componente Salary. Sem o filtro por `compensationType`, o min/max sairia
    // NaN e a faixa inteira viraria lixo.
    const coordinator = jobs.find((job) => job.props.title === "Office Coordinator, NYC");
    if (!coordinator) throw new Error("vaga esperada sumiu do recorte");

    expect(coordinator.props.compensation?.min?.amountCents).toBe(8_000_000);
    expect(coordinator.props.compensation?.max?.amountCents).toBe(11_000_000);
    expect(coordinator.props.compensation?.period).toBe("YEAR");
  });

  it("usa o interval declarado pela fonte em vez de deduzir pela magnitude", () => {
    const jobs = parsed();

    // US$ 11.700 por MÊS. A heurística de magnitude do Greenhouse chamaria isso
    // de anual; aqui a fonte declara "1 MONTH" e não há o que adivinhar.
    const intern = jobs.find((job) => job.props.title.startsWith("Software Engineer Internship"));
    if (!intern) throw new Error("vaga esperada sumiu do recorte");

    expect(intern.props.compensation?.period).toBe("MONTH");
    expect(intern.props.compensation?.min?.amountCents).toBe(1_170_000);
  });

  it("deixa compensation nulo quando a vaga não publica faixa", () => {
    const jobs = parsed();

    const account = jobs.find((job) => job.props.title === "Account Executive");
    if (!account) throw new Error("vaga esperada sumiu do recorte");

    expect(account.props.compensation).toBeNull();
  });

  it("entrega a descrição como HTML já desescapado", () => {
    const jobs = parsed();

    const [first] = jobs;
    if (!first) throw new Error("fixture vazia");

    // Diferente do Greenhouse, a Ashby não escapa entidades no HTML.
    expect(first.props.description.html).toContain("<p");
    expect(first.props.description.html).not.toContain("&lt;p&gt;");
    expect(first.props.description.isEmpty).toBe(false);
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

describe("AshbyAdapter.parse — secondaryLocations e faixa multimoeda", () => {
  const adapter = makeAdapter();
  /**
   * RECORTE de 2 vagas do board da própria Ashby (60 no total), escolhidas por
   * serem os casos extremos de geografia e de remuneração: uma tem 19
   * localizações secundárias, a outra publica 5 componentes de salário em duas
   * moedas na mesma vaga.
   */
  const payload = loadFixture("board-ashby-recorte.json");

  function parsed() {
    const result = adapter.parse(makeBatch(payload, "ashby"));
    if (!result.isOk()) throw new Error("parse falhou");
    return result.value;
  }

  it("mantém só a geografia principal — secondaryLocations é descartado", () => {
    const jobs = parsed();

    const manager = jobs.find((job) => job.props.title === "Engineering Manager - EU");
    if (!manager) throw new Error("vaga esperada sumiu do recorte");

    // As 19 secundárias (Spain, Italy, Germany... Portugal) NÃO entram no texto.
    expect(manager.props.location.raw).toBe("Remote - European Union");
    expect(manager.props.location.raw).not.toContain("Portugal");
  });

  it("não deixa a geografia secundária cravar um país que a vaga não tem", () => {
    const jobs = parsed();

    const manager = jobs.find((job) => job.props.title === "Engineering Manager - EU");
    if (!manager) throw new Error("vaga esperada sumiu do recorte");

    // Concatenar as secundárias faria o `Location` cravar PT (por causa de
    // "Portugal" na lista) numa vaga aberta para a UE inteira. "Sem país" é o
    // resultado honesto; "país errado" esconderia a vaga de quem a procura.
    expect(manager.props.location.country).toBeNull();
  });

  it("consolida só os componentes que compartilham moeda e período", () => {
    const jobs = parsed();

    const ae = jobs.find((job) => job.props.title.startsWith("Mid Market Account Executive"));
    if (!ae) throw new Error("vaga esperada sumiu do recorte");

    // A vaga publica 3 faixas em EUR e 2 em GBP. A referência é a primeira
    // utilizável (EUR); as em GBP ficam de fora, senão a faixa misturaria moedas.
    expect(ae.props.compensation?.currency).toBe("EUR");
    expect(ae.props.compensation?.min?.amountCents).toBe(11_000_000);
    expect(ae.props.compensation?.max?.amountCents).toBe(19_550_000);
  });
});

describe("AshbyAdapter.parse — faixa por hora com valor fracionário", () => {
  const adapter = makeAdapter();
  /**
   * RECORTE de 2 vagas do board `openai` (755 no total, 13 MB de resposta),
   * escolhidas por cobrirem o único período que aparece com valor FRACIONÁRIO.
   */
  const payload = loadFixture("board-openai-recorte.json");

  it("converte valor por hora fracionário em centavos sem perder o resto", () => {
    const result = adapter.parse(makeBatch(payload, "openai"));
    if (!result.isOk()) throw new Error("parse falhou");

    const support = result.value.find((job) => job.props.title === "IT Support Specialist");
    if (!support) throw new Error("vaga esperada sumiu do recorte");

    // US$ 60,58/h — a fonte publica 60.58, não 6058. Uma checagem de inteiro
    // aqui descartaria a faixa inteira.
    expect(support.props.compensation?.period).toBe("HOUR");
    expect(support.props.compensation?.min?.amountCents).toBe(6_058);
    expect(support.props.compensation?.max?.amountCents).toBe(10_817);
  });
});

describe("AshbyAdapter — board vazio versus slug inexistente", () => {
  const adapter = makeAdapter();

  it("aceita board vazio sem erro: HTTP 200 com jobs:[] é conta sem vaga aberta", () => {
    // Fixture real da conta `clerk`. Seguro porque slug morto NÃO responde 200
    // aqui — responde 404. É o oposto do SmartRecruiters, no mesmo PR.
    const result = adapter.parse(makeBatch(loadFixture("board-vazio.json"), "clerk"));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });

  it("trata o 404 do board como config inválida, olhando o status e não o corpo", async () => {
    // Comportamento real medido: HTTP 404 com corpo `Not Found` em text/plain —
    // o corpo NÃO é JSON, diferente do Greenhouse e do Lever.
    const body = loadFixture("slug-inexistente.txt");
    expect(() => JSON.parse(body)).toThrow();

    const client = {
      listJobs: async () => {
        throw new SourceHttpError(404, "HTTP 404 em https://api.ashbyhq.com/...", body);
      },
    };

    const result = await new AshbyAdapter(client as unknown as AshbyClient).fetch(
      { sourceId: "ashby", selector: "board-que-nao-existe", page: 0, runId: "r", params: {} },
      { etag: null, lastModified: null },
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;

    expect(result.error.type).toBe(ErrorType.VALIDATION);
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toContain("board-que-nao-existe");
  });

  it("mantém 5xx como indisponibilidade retentável", async () => {
    const client = {
      listJobs: async () => {
        throw new SourceHttpError(503, "HTTP 503");
      },
    };

    const result = await new AshbyAdapter(client as unknown as AshbyClient).fetch(
      { sourceId: "ashby", selector: "ramp", page: 0, runId: "r", params: {} },
      { etag: null, lastModified: null },
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;

    expect(result.error.type).toBe(ErrorType.SOURCE_UNAVAILABLE);
    expect(result.error.retryable).toBe(true);
  });
});

describe("AshbyAdapter.fetch — dump completo, sem paginação", () => {
  const task = { sourceId: "ashby", selector: "ramp", page: 0, runId: "r", params: {} };
  const noCache = { etag: null, lastModified: null };

  it("nunca devolve continuação, mesmo com o board cheio", async () => {
    const client = {
      listJobs: async () => ({
        status: 200,
        body: loadFixture("board-ramp-recorte.json"),
        contentType: "application/json",
        etag: 'W/"abc"',
        lastModified: null,
      }),
    };

    const result = await new AshbyAdapter(client as unknown as AshbyClient).fetch(task, noCache);

    expect(result.isOk()).toBe(true);
    if (!result.isOk() || result.value.kind !== "fetched") throw new Error("fetch falhou");
    expect(result.value.batch.next).toBeNull();
    expect(result.value.batch.cache.etag).toBe('W/"abc"');
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

    const result = await new AshbyAdapter(client as unknown as AshbyClient).fetch(task, {
      etag: 'W/"abc"',
      lastModified: null,
    });

    if (!result.isOk()) throw new Error("fetch falhou");
    expect(result.value.kind).toBe("not-modified");
  });
});

describe("AshbyAdapter.parse — deriva de contrato", () => {
  const adapter = makeAdapter();

  it("reporta SOURCE_CONTRACT_DRIFT quando o corpo não é JSON", () => {
    // É exatamente o que chega se o 404 vier sem status: o corpo é `Not Found`.
    const result = adapter.parse(makeBatch(loadFixture("slug-inexistente.txt")));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe(ErrorType.SOURCE_CONTRACT_DRIFT);
      // Deriva de contrato NÃO é retentável: retentar devolve o mesmo payload.
      expect(result.error.retryable).toBe(false);
    }
  });

  it("reporta o campo exato que sumiu, não uma falha genérica", () => {
    const result = adapter.parse(makeBatch(JSON.stringify({ postings: [], apiVersion: "1" })));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("'jobs'");
  });

  it("acusa a perda de includeCompensation=true na fixture deformada", () => {
    // Fixture derivada do payload real, sem a chave `compensation` — o modo de
    // falha mais caro desta fonte, porque o pipeline continuaria "funcionando".
    const result = adapter.parse(makeBatch(loadFixture("board-deformado.json")));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("includeCompensation=true");
  });

  it("detecta mudança de tipo dentro de um item", () => {
    const payload = JSON.stringify({
      jobs: [
        {
          id: 12345,
          title: "Dev",
          jobUrl: "https://x",
          location: "Remote",
          descriptionHtml: "",
          compensation: null,
        },
      ],
    });

    const result = adapter.parse(makeBatch(payload));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("jobs[0].id");
  });

  it("acusa descriptionHtml ausente", () => {
    const payload = JSON.stringify({
      jobs: [
        { id: "x", title: "Dev", jobUrl: "https://x", location: "Remote", compensation: null },
      ],
    });

    const result = adapter.parse(makeBatch(payload));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("jobs[0].descriptionHtml");
  });
});
