import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorType, type RawBatch, RemoteMode } from "@job-radar/core";
import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../http/circuit-breaker.js";
import { SourceHttpError } from "../http/http-client.js";
import { LeverAdapter } from "./lever.adapter.js";
import { LeverClient } from "./lever.client.js";
import { buildDescriptionHtml } from "./lever.mapper.js";

const FIXTURE_DIR = fileURLToPath(new URL("../../../../fixtures/lever/", import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(`${FIXTURE_DIR}${name}`, "utf8");
}

const FETCHED_AT = new Date("2026-08-25T00:00:00.000Z");

function makeBatch(payload: string, slug = "matchgroup", page = 0): RawBatch {
  return {
    task: { sourceId: "lever", selector: slug, page, runId: "run-1", params: {} },
    payload,
    contentType: "application/json",
    fetchedAt: FETCHED_AT,
    cache: { etag: null, lastModified: null },
    next: null,
  };
}

function makeAdapter(): LeverAdapter {
  // `parse` é puro, então os testes de parsing não tocam em HTTP.
  const client = new LeverClient(
    null as never,
    new CircuitBreaker("lever", { failureThreshold: 3, cooldownMs: 1000 }),
  );
  return new LeverAdapter(client);
}

describe("LeverClient.buildUrl", () => {
  it("mantém o mode e a janela de paginação", () => {
    const url = LeverClient.buildUrl({ slug: "palantir", skip: 100, limit: 100 });

    expect(url).toBe("https://api.lever.co/v0/postings/palantir?mode=json&skip=100&limit=100");
  });

  it("nunca manda parâmetro de agrupamento, que trocaria a forma da raiz", () => {
    // Medido na API real: com `group=team` a raiz vira `[{title, postings:[]}]`
    // e a resposta continua 200. Todo o parser assume array de vagas na raiz.
    const url = LeverClient.buildUrl({ slug: "matchgroup", skip: 0, limit: 100 });

    expect(url).not.toContain("group=");
  });

  it("limita o page size ao teto que nós definimos", () => {
    // A fonte NÃO grampeia: `limit=500` devolve as 308 vagas do `palantir` de
    // uma vez. O teto é nosso, por causa do tamanho do corpo.
    const url = LeverClient.buildUrl({ slug: "palantir", skip: 0, limit: 5000 });
    expect(url).toContain("limit=100");
  });

  it("escapa o slug em vez de concatenar texto na URL", () => {
    const url = LeverClient.buildUrl({ slug: "a b/c", skip: 0, limit: 10 });
    expect(url).toContain("/postings/a%20b%2Fc?");
  });
});

describe("LeverAdapter.discover", () => {
  it("abre a trilha de paginação na página 0", () => {
    const result = makeAdapter().discover(
      { sourceId: "lever", selector: "palantir", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value).toEqual([
      { sourceId: "lever", selector: "palantir", page: 0, runId: "run-1", params: {} },
    ]);
  });

  it("recusa selector vazio", () => {
    const result = makeAdapter().discover(
      { sourceId: "lever", selector: "  ", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(ErrorType.VALIDATION);
  });

  it("recusa slug com caractere que não cabe na URL do board", () => {
    const result = makeAdapter().discover(
      { sourceId: "lever", selector: "palantir?mode=html", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(ErrorType.VALIDATION);
  });
});

describe("LeverAdapter.parse — recorte real do board matchgroup", () => {
  const adapter = makeAdapter();
  /**
   * RECORTE, não board completo: `matchgroup` tem 79 vagas. Foram mantidas 10
   * escolhidas por cobrirem o que o mapper decide — faixa em USD, CAD e AUD
   * (moeda sem suporte), vagas sem faixa nenhuma, quatro tipos de contrato e
   * seções de descrição com e sem `lists`.
   */
  const payload = loadFixture("board-matchgroup-recorte.json");

  function parsed() {
    const result = adapter.parse(makeBatch(payload));
    if (!result.isOk()) throw new Error("parse falhou");
    return result.value;
  }

  it("converte o recorte inteiro em JobPosting", () => {
    const jobs = parsed();

    expect(jobs).toHaveLength(10);

    const [first] = jobs;
    if (!first) throw new Error("fixture vazia");

    expect(first.props.source.id).toBe("lever");
    // O id do Lever é UUID em string, não number como nas outras fontes.
    expect(first.props.source.externalId).toBe("cb977666-1e41-4098-ad9c-6ab387e56a7a");
    expect(first.props.source.url).toContain("jobs.lever.co/matchgroup/");
    expect(first.props.title).toBe("Android Engineer III");
  });

  it("usa o slug da tarefa como identidade da empresa — o payload não tem nome", () => {
    const result = adapter.parse(makeBatch(payload, "outro-slug"));
    if (!result.isOk()) throw new Error("parse falhou");

    expect(result.value.every((job) => job.props.company.slug === "outro-slug")).toBe(true);
    expect(result.value.every((job) => job.props.company.name === "outro-slug")).toBe(true);
  });

  it("usa o país que a fonte já entrega em ISO-2, sem heurística de texto", () => {
    const jobs = parsed();

    const seoul = jobs.find((job) => job.props.location.raw === "Seoul, South Korea");
    if (!seoul) throw new Error("vaga esperada sumiu do recorte");

    // "South Korea" não está na tabela de dicas do `Location` — só chega a KR
    // porque a fonte publica `country` pronto.
    expect(seoul.props.location.country).toBe("KR");
  });

  it("mapeia workplaceType para RemoteMode sem adivinhar pelo texto", () => {
    const jobs = parsed();

    expect(jobs.every((job) => job.props.location.remote === RemoteMode.HYBRID)).toBe(true);
  });

  it("converte a faixa decimal em centavos inteiros", () => {
    const jobs = parsed();

    const android = jobs.find((job) => job.props.title === "Android Engineer III");
    if (!android) throw new Error("vaga esperada sumiu do recorte");

    // A fonte publica 150000/180000 em unidade decimal, não em centavos.
    expect(android.props.compensation?.min?.amountCents).toBe(15_000_000);
    expect(android.props.compensation?.max?.amountCents).toBe(18_000_000);
    expect(android.props.compensation?.currency).toBe("USD");
    expect(android.props.compensation?.period).toBe("YEAR");
  });

  it("aceita moeda estrangeira com suporte em Money", () => {
    const jobs = parsed();

    const vancouver = jobs.find((job) => job.props.location.country === "CA");
    if (!vancouver) throw new Error("vaga esperada sumiu do recorte");

    expect(vancouver.props.compensation?.currency).toBe("CAD");
    expect(vancouver.props.compensation?.min?.amountCents).toBe(4_000_000);
  });

  it("descarta faixa em moeda sem suporte em vez de derrubar o board", () => {
    // AUD não está em `Currency`. A vaga entra sem faixa; as outras nove seguem.
    const jobs = parsed();

    const aussie = jobs.find((job) => job.props.location.country === "AU");
    if (!aussie) throw new Error("vaga esperada sumiu do recorte");

    expect(aussie.props.compensation).toBeNull();
  });

  it("deixa compensation nulo quando o board não publica faixa", () => {
    const jobs = parsed();

    const tokyo = jobs.find((job) => job.props.title === "Back-end Engineer, Platform (Go)");
    if (!tokyo) throw new Error("vaga esperada sumiu do recorte");

    expect(tokyo.props.compensation).toBeNull();
  });

  it("traduz o commitment em tipo de contrato", () => {
    const jobs = parsed();

    const types = new Set(jobs.map((job) => job.props.employmentType));
    expect(types.has("FULL_TIME")).toBe(true);
    expect(types.has("CONTRACT")).toBe(true);
    expect(types.has("FIXED_TERM")).toBe(true);
    expect(types.has("APPRENTICE")).toBe(true);
  });

  it("lê createdAt como epoch em milissegundos, não como texto ISO", () => {
    const jobs = parsed();

    const [first] = jobs;
    if (!first) throw new Error("fixture vazia");

    // 1787338912631 -> 2026-08-21. `new Date(String(epoch))` daria Invalid Date.
    expect(first.props.postedAt?.toISOString()).toBe("2026-08-21T19:01:52.631Z");
  });

  it("junta as seções da descrição sem duplicar texto", () => {
    const jobs = parsed();

    const accountant = jobs.find((job) => job.props.title.startsWith("Accountant"));
    if (!accountant) throw new Error("vaga esperada sumiu do recorte");

    // As três seções em tópicos entram com o título como cabeçalho.
    expect(accountant.props.description.text).toContain("Key Responsibilities");
    expect(accountant.props.description.text).toContain("Required Qualifications");
    expect(accountant.props.description.text).toContain("Work Arrangement");
    expect(accountant.props.description.text).toContain("Role Overview");
  });

  it("extrai stack de dentro das seções, não só do título", () => {
    const jobs = parsed();

    const android = jobs.find((job) => job.props.title === "Android Engineer III");
    if (!android) throw new Error("vaga esperada sumiu do recorte");

    expect(android.stack).toContain("android");
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

describe("buildDescriptionHtml", () => {
  it("concatena abertura, seções em tópicos e fechamento nessa ordem", () => {
    const html = buildDescriptionHtml({
      id: "x",
      text: "Dev",
      hostedUrl: "https://x",
      description: "<div>Abertura</div>",
      lists: [{ text: "Requisitos", content: "<li>Node</li>" }],
      additional: "<div>Fechamento</div>",
    });

    expect(html).toBe(
      "<div>Abertura</div>\n<h3>Requisitos</h3>\n<ul><li>Node</li></ul>\n<div>Fechamento</div>",
    );
  });

  it("envolve o conteúdo da seção numa lista — a fonte manda os <li> soltos", () => {
    const html = buildDescriptionHtml({
      id: "x",
      text: "Dev",
      hostedUrl: "https://x",
      lists: [{ text: "Requisitos", content: "<li>A</li><li>B</li>" }],
    });

    expect(html).toContain("<ul><li>A</li><li>B</li></ul>");
  });

  it("não inventa seção quando a vaga não tem nenhuma", () => {
    const html = buildDescriptionHtml({
      id: "x",
      text: "Dev",
      hostedUrl: "https://x",
      description: "<div>Só isso</div>",
    });

    expect(html).toBe("<div>Só isso</div>");
  });
});

describe("LeverAdapter.fetch — paginação por skip/limit", () => {
  function makeAdapterWithPage(itemCount: number): LeverAdapter {
    const body = JSON.stringify(
      Array.from({ length: itemCount }, (_, index) => ({
        id: `id-${index}`,
        text: "Dev",
        hostedUrl: "https://jobs.lever.co/acme/x",
      })),
    );

    const client = {
      listPostings: async () => ({
        status: 200,
        body,
        contentType: "application/json",
        etag: 'W/"abc"',
        lastModified: null,
      }),
    };

    return new LeverAdapter(client as unknown as LeverClient);
  }

  const task = { sourceId: "lever", selector: "palantir", page: 0, runId: "r", params: {} };
  const noCache = { etag: null, lastModified: null };

  it("continua quando a página vem cheia", async () => {
    // Medido no `palantir`: skip 0/100/200 devolvem 100 itens distintos cada.
    const result = await makeAdapterWithPage(100).fetch(task, noCache);

    expect(result.isOk()).toBe(true);
    if (!result.isOk() || result.value.kind !== "fetched") throw new Error("fetch falhou");
    expect(result.value.batch.next).toEqual({ ...task, page: 1 });
    expect(result.value.batch.cache.etag).toBe('W/"abc"');
  });

  it("para quando a página vem incompleta", async () => {
    // Medido: skip=300 no `palantir` devolve 8 itens — é o fim da trilha.
    const result = await makeAdapterWithPage(8).fetch(task, noCache);

    if (!result.isOk() || result.value.kind !== "fetched") throw new Error("fetch falhou");
    expect(result.value.batch.next).toBeNull();
  });

  it("para numa página vazia", async () => {
    const result = await makeAdapterWithPage(0).fetch(task, noCache);

    if (!result.isOk() || result.value.kind !== "fetched") throw new Error("fetch falhou");
    expect(result.value.batch.next).toBeNull();
  });

  it("respeita o teto de páginas para não paginar infinitamente", async () => {
    const result = await makeAdapterWithPage(100).fetch({ ...task, page: 49 }, noCache);

    if (!result.isOk() || result.value.kind !== "fetched") throw new Error("fetch falhou");
    expect(result.value.batch.next).toBeNull();
  });

  it("propaga o 304 como not-modified em vez de tratar como erro", async () => {
    const client = {
      listPostings: async () => ({
        status: 304,
        body: "",
        contentType: "",
        etag: null,
        lastModified: null,
      }),
    };

    const result = await new LeverAdapter(client as unknown as LeverClient).fetch(task, {
      etag: 'W/"abc"',
      lastModified: null,
    });

    if (!result.isOk()) throw new Error("fetch falhou");
    expect(result.value.kind).toBe("not-modified");
  });
});

describe("LeverAdapter — board vazio versus slug inexistente", () => {
  const adapter = makeAdapter();

  it("aceita board vazio sem erro: HTTP 200 com [] é empresa sem vaga aberta", () => {
    // Fixture real da conta `lever`, que existe e não publica vaga nenhuma.
    // Aqui isso é seguro justamente porque slug morto NÃO responde 200 —
    // responde 404. É o oposto do SmartRecruiters, no mesmo PR.
    const result = adapter.parse(makeBatch(loadFixture("board-vazio.json"), "lever"));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });

  it("trata o 404 do board como config inválida, não como deriva de contrato", async () => {
    // Comportamento real medido com cinco slugs de lixo distintos: HTTP 404 com
    // corpo {"ok":false,"error":"Document not found"}.
    const body = loadFixture("slug-inexistente.json");
    const client = {
      listPostings: async () => {
        throw new SourceHttpError(404, "HTTP 404 em https://api.lever.co/...", body);
      },
    };

    const result = await new LeverAdapter(client as unknown as LeverClient).fetch(
      { sourceId: "lever", selector: "board-que-nao-existe", page: 0, runId: "r", params: {} },
      { etag: null, lastModified: null },
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;

    expect(result.error.type).toBe(ErrorType.VALIDATION);
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toContain("board-que-nao-existe");
    expect(result.error.message).toContain("Document not found");
  });

  it("mantém 5xx como indisponibilidade retentável", async () => {
    const client = {
      listPostings: async () => {
        throw new SourceHttpError(503, "HTTP 503");
      },
    };

    const result = await new LeverAdapter(client as unknown as LeverClient).fetch(
      { sourceId: "lever", selector: "palantir", page: 0, runId: "r", params: {} },
      { etag: null, lastModified: null },
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;

    expect(result.error.type).toBe(ErrorType.SOURCE_UNAVAILABLE);
    expect(result.error.retryable).toBe(true);
  });
});

describe("LeverAdapter.parse — deriva de contrato", () => {
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

  it("acusa a raiz que deixou de ser array e sugere o parâmetro de agrupamento", () => {
    // Forma real que a fonte devolve com `group=team` na URL.
    const payload = JSON.stringify([{ title: "Engineering", postings: [] }]);
    const result = adapter.parse(makeBatch(payload));

    // O array de agrupamento passa pela checagem de raiz e morre no item, que é
    // onde o campo que falta fica explícito.
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("[0].id");
  });

  it("acusa envelope de objeto no lugar do array", () => {
    const result = adapter.parse(makeBatch(JSON.stringify({ postings: [] })));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("raiz não é array");
  });

  it("detecta mudança de tipo dentro de um item na fixture deformada", () => {
    // Fixture derivada do payload real, com `id` trocado de string para number
    // — a mudança mais plausível se a fonte migrar de UUID para id numérico.
    const result = adapter.parse(makeBatch(loadFixture("board-deformado.json")));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("[0].id não é string");
  });

  it("acusa hostedUrl ausente", () => {
    const payload = JSON.stringify([{ id: "x", text: "Dev" }]);
    const result = adapter.parse(makeBatch(payload));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("[0].hostedUrl");
  });
});
