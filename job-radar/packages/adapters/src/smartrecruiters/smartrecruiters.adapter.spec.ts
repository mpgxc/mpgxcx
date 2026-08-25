import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorType, type RawBatch, RemoteMode } from "@job-radar/core";
import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../http/circuit-breaker.js";
import { SourceHttpError } from "../http/http-client.js";
import { ALLOW_EMPTY_BOARD_PARAM, SmartRecruitersAdapter } from "./smartrecruiters.adapter.js";
import { SmartRecruitersClient } from "./smartrecruiters.client.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../../../../fixtures/smartrecruiters/", import.meta.url),
);

function loadFixture(name: string): string {
  return readFileSync(`${FIXTURE_DIR}${name}`, "utf8");
}

const FETCHED_AT = new Date("2026-08-25T00:00:00.000Z");

function makeBatch(payload: string, slug = "smartrecruiters", page = 0): RawBatch {
  return {
    task: { sourceId: "smartrecruiters", selector: slug, page, runId: "run-1", params: {} },
    payload,
    contentType: "application/json",
    fetchedAt: FETCHED_AT,
    cache: { etag: null, lastModified: null },
    next: null,
  };
}

function makeAdapter(): SmartRecruitersAdapter {
  // `parse` é puro, então os testes de parsing não tocam em HTTP.
  const client = new SmartRecruitersClient(
    null as never,
    new CircuitBreaker("smartrecruiters", { failureThreshold: 3, cooldownMs: 1000 }),
  );
  return new SmartRecruitersAdapter(client);
}

/** Adapter cujo client devolve sempre o mesmo corpo, sem tocar em HTTP. */
function makeAdapterWithBody(body: string): SmartRecruitersAdapter {
  const client = {
    listPostings: async () => ({
      status: 200,
      body,
      contentType: "application/json",
      etag: 'W/"abc"',
      lastModified: null,
    }),
  };
  return new SmartRecruitersAdapter(client as unknown as SmartRecruitersClient);
}

const NO_CACHE = { etag: null, lastModified: null };

describe("SmartRecruitersClient.buildUrl", () => {
  it("monta a janela de paginação", () => {
    const url = SmartRecruitersClient.buildUrl({ slug: "BoschGroup", offset: 100, limit: 100 });

    expect(url).toBe(
      "https://api.smartrecruiters.com/v1/companies/BoschGroup/postings?limit=100&offset=100",
    );
  });

  it("preserva a caixa do identificador — a fonte é case-sensitive", () => {
    // Medido: `smartrecruiters` devolve as 8 vagas da empresa e
    // `SmartRecruiters` devolve lista vazia com HTTP 200, sem erro nenhum.
    // Normalizar a caixa aqui transformaria uma linha correta do registro num
    // board fantasma.
    const url = SmartRecruitersClient.buildUrl({ slug: "BoschGroup", offset: 0, limit: 100 });

    expect(url).toContain("/companies/BoschGroup/");
    expect(url).not.toContain("/companies/boschgroup/");
  });

  it("limita o page size ao teto que a fonte grampeia", () => {
    // Medido: `limit=200` devolve `limit: 100` no envelope e 100 itens.
    const url = SmartRecruitersClient.buildUrl({ slug: "BoschGroup", offset: 0, limit: 5000 });
    expect(url).toContain("limit=100");
  });
});

describe("SmartRecruitersAdapter.discover", () => {
  it("abre a trilha de paginação na página 0", () => {
    const result = makeAdapter().discover(
      { sourceId: "smartrecruiters", selector: "BoschGroup", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value).toEqual([
      { sourceId: "smartrecruiters", selector: "BoschGroup", page: 0, runId: "run-1", params: {} },
    ]);
  });

  it("propaga os params da config para a tarefa", () => {
    // É por aqui que `allowEmptyBoard` chega ao `fetch`.
    const result = makeAdapter().discover(
      {
        sourceId: "smartrecruiters",
        selector: "Visa",
        enabled: true,
        params: { [ALLOW_EMPTY_BOARD_PARAM]: "true" },
      },
      "run-1",
    );

    if (!result.isOk()) throw new Error("discover falhou");
    expect(result.value[0]?.params).toEqual({ [ALLOW_EMPTY_BOARD_PARAM]: "true" });
  });

  it("recusa selector vazio", () => {
    const result = makeAdapter().discover(
      { sourceId: "smartrecruiters", selector: "  ", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(ErrorType.VALIDATION);
  });

  it("recusa identificador com caractere que não cabe na URL", () => {
    const result = makeAdapter().discover(
      { sourceId: "smartrecruiters", selector: "Bosch/postings", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(ErrorType.VALIDATION);
  });
});

describe("SmartRecruitersAdapter.parse — board real completo (smartrecruiters)", () => {
  const adapter = makeAdapter();
  // Board COMPLETO, não recorte: a própria SmartRecruiters publica 8 vagas.
  const payload = loadFixture("postings-smartrecruiters-pagina0.json");

  function parsed() {
    const result = adapter.parse(makeBatch(payload));
    if (!result.isOk()) throw new Error("parse falhou");
    return result.value;
  }

  it("converte o board inteiro em JobPosting", () => {
    const jobs = parsed();

    expect(jobs).toHaveLength(8);

    const [first] = jobs;
    if (!first) throw new Error("fixture vazia");

    expect(first.props.source.id).toBe("smartrecruiters");
    expect(first.props.source.externalId).toBe("744000143115219");
    expect(first.props.title).toBe("Senior Information Security Engineer");
    expect(first.props.company.name).toBe("SmartRecruiters Inc");
    expect(first.props.company.slug).toBe("smartrecruiters");
  });

  it("monta a URL pública, porque a lista só traz a URL da API", () => {
    const jobs = parsed();

    const [first] = jobs;
    if (!first) throw new Error("fixture vazia");

    // `ref` no payload é https://api.smartrecruiters.com/... — inútil para o
    // candidato. A fonte redireciona a forma curta para a versão com o título.
    expect(first.props.source.url).toBe(
      "https://jobs.smartrecruiters.com/smartrecruiters/744000143115219",
    );
    expect(first.props.source.url).not.toContain("api.smartrecruiters.com");
  });

  it("sai SEM descrição — a lista de postings não publica o texto da vaga", () => {
    /**
     * Não é esquecimento: nenhum campo da lista traz o texto, e cinco
     * parâmetros de expansão foram testados contra a API real sem efeito. O
     * texto só existe em `GET .../postings/{id}`, uma requisição POR VAGA
     * (4.800 no `BoschGroup`) — enriquecimento é outro passo, não o `fetch`.
     */
    expect(parsed().every((job) => job.props.description.isEmpty)).toBe(true);
  });

  it("ainda assim extrai senioridade e stack do que existe: o título", () => {
    const jobs = parsed();

    const python = jobs.find((job) => job.props.title === "Senior Software Engineer, Python");
    if (!python) throw new Error("vaga esperada sumiu da fixture");

    expect(python.seniority).toBe("SENIOR");
    expect(python.stack).toContain("python");
  });

  it("lê a modalidade dos booleanos declarados, não do texto do endereço", () => {
    const jobs = parsed();

    const [first] = jobs;
    if (!first) throw new Error("fixture vazia");

    // `fullLocation` aqui é "Poland, REMOTE, Poland" — a fonte planta a
    // modalidade DENTRO do endereço. O booleano `remote` é que decide.
    expect(first.props.location.raw).toBe("Poland, REMOTE, Poland");
    expect(first.props.location.remote).toBe(RemoteMode.REMOTE);
  });

  it("converte o país de ISO-2 minúsculo para maiúsculo", () => {
    const jobs = parsed();

    const uk = jobs.find((job) => job.props.location.raw.startsWith("United Kingdom"));
    if (!uk) throw new Error("vaga esperada sumiu da fixture");

    // A fonte publica "gb"; o VO espera "GB".
    expect(uk.props.location.country).toBe("GB");
  });

  it("traduz typeOfEmployment pelo id, não pelo label de exibição", () => {
    const jobs = parsed();
    const types = new Set(jobs.map((job) => job.props.employmentType));

    // "permanent" -> FULL_TIME. O label da fonte para esse id é "Full-time".
    expect(types.has("FULL_TIME")).toBe(true);
    expect(types.has("CONTRACT")).toBe(true);
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

describe("SmartRecruitersAdapter.parse — recorte do board grande (BoschGroup)", () => {
  const adapter = makeAdapter();
  /**
   * RECORTE, não board completo: `BoschGroup` tem 4.800 vagas. Foram mantidas 8
   * escolhidas por cobrirem as três modalidades e quatro países, e o
   * `totalFound: 4800` foi PRESERVADO de propósito — serve de prova de que o
   * parser não usa o total para nada.
   */
  const payload = loadFixture("postings-boschgroup-pagina0-recorte.json");

  function parsed() {
    const result = adapter.parse(makeBatch(payload, "BoschGroup"));
    if (!result.isOk()) throw new Error("parse falhou");
    return result.value;
  }

  it("parseia o recorte sem se importar com totalFound divergente", () => {
    const jobs = parsed();

    expect(jobs).toHaveLength(8);
    expect(JSON.parse(payload).totalFound).toBe(4800);
    expect(jobs.every((job) => job.props.company.name === "Bosch Group")).toBe(true);
  });

  it("reconhece híbrido pelo booleano da fonte", () => {
    const jobs = parsed();

    const hibrida = jobs.find((job) => job.props.title === "Cost Engineer");
    if (!hibrida) throw new Error("vaga esperada sumiu do recorte");

    expect(hibrida.props.location.remote).toBe(RemoteMode.HYBRID);
  });

  it("não afirma presencial quando os dois booleanos vêm desmarcados", () => {
    const jobs = parsed();

    // Dois booleanos desmarcados são o padrão do formulário, não a afirmação de
    // presencial. O VO fica livre para ler o texto, que aqui não diz nada.
    const semSinal = jobs.find((job) => job.props.title.startsWith("Warehouse Associate"));
    if (!semSinal) throw new Error("vaga esperada sumiu do recorte");

    expect(semSinal.props.location.remote).toBe(RemoteMode.UNKNOWN);
  });

  it("preserva o fullLocation cru, vírgula órfã e tudo", () => {
    const jobs = parsed();

    const india = jobs.find((job) => job.props.location.country === "IN");
    if (!india) throw new Error("vaga esperada sumiu do recorte");

    // A fonte publica "hosur road bangalore, , India" quando a região é vazia.
    // O texto original é preservado — é ele que permite reprocessar depois.
    expect(india.props.location.raw).toBe("hosur road bangalore, , India");
  });

  it("dá identidade distinta a vagas com o mesmo título", () => {
    const jobs = parsed();

    const homonimas = jobs.filter((job) => job.props.title.startsWith("Web Application Developer"));
    expect(homonimas.length).toBe(3);
    // Mesmo título, mesma cidade, ids diferentes: a identidade sai do id externo.
    expect(new Set(homonimas.map((job) => job.id)).size).toBe(3);
  });
});

describe("SmartRecruitersAdapter — A ARMADILHA: 200 vazio é ambíguo", () => {
  const task = {
    sourceId: "smartrecruiters",
    selector: "Visa",
    page: 0,
    runId: "r",
    params: {},
  };

  it("empresa REAL sem vaga e slug de lixo devolvem bytes IDÊNTICOS", () => {
    /**
     * As duas fixtures foram gravadas ao vivo no mesmo minuto: `Visa` é empresa
     * real (tem página em careers.smartrecruiters.com/Visa, "Careers at Visa")
     * e `nao-existe-empresa-xyz-123` é lixo. As respostas são iguais byte a
     * byte — e vieram até com o MESMO ETag,
     * `W/"32-43Q/EKICDDxY23fhngxb6UYn21I"`.
     *
     * Este teste é a razão de existir de tudo o que vem abaixo: não há o que
     * inspecionar no payload para distinguir os dois casos.
     */
    const vazio = loadFixture("postings-vazio.json");
    const lixo = loadFixture("slug-inexistente.json");

    expect(vazio).toBe(lixo);
    expect(JSON.parse(vazio)).toEqual({ offset: 0, limit: 100, totalFound: 0, content: [] });
  });

  it("recusa a primeira página vazia como config inválida em vez de devolver zero vagas", async () => {
    /**
     * A guarda que protege o catálogo. Devolver `ok([])` aqui faria a rodada
     * terminar com `failed === 0`, o sweeper a consideraria íntegra e expiraria
     * TODAS as vagas daquela empresa — em silêncio, sem erro nenhum no log.
     */
    const result = await makeAdapterWithBody(loadFixture("postings-vazio.json")).fetch(
      task,
      NO_CACHE,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;

    expect(result.error.type).toBe(ErrorType.VALIDATION);
    // Não retentável de propósito: é isso que faz o `fetch.handler` chamar
    // `recordFailure` na hora, em vez de esperar a mensagem ir para a DLQ.
    expect(result.error.retryable).toBe(false);
  });

  it("a mensagem de erro diz o que conferir, incluindo a pegadinha da caixa", async () => {
    const result = await makeAdapterWithBody(loadFixture("postings-vazio.json")).fetch(
      task,
      NO_CACHE,
    );

    if (!result.isErr()) throw new Error("deveria ter falhado");

    expect(result.error.message).toContain("Visa");
    expect(result.error.message).toContain("case-sensitive");
    expect(result.error.message).toContain(ALLOW_EMPTY_BOARD_PARAM);
  });

  it("aceita board vazio quando o operador confirmou o slug no registro", async () => {
    // A válvula de escape: `params` é coluna do registro de fontes, então
    // liberar uma empresa que zerou as vagas é editar uma linha, não um deploy.
    const result = await makeAdapterWithBody(loadFixture("postings-vazio.json")).fetch(
      { ...task, params: { [ALLOW_EMPTY_BOARD_PARAM]: "true" } },
      NO_CACHE,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk() || result.value.kind !== "fetched") throw new Error("fetch falhou");
    expect(result.value.batch.next).toBeNull();
  });

  it("e nesse caso o parse devolve lista vazia sem reclamar", () => {
    const result = makeAdapter().parse(makeBatch(loadFixture("postings-vazio.json"), "Visa"));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });

  it("página vazia DEPOIS da primeira é fim de trilha, não board fantasma", async () => {
    // Com "página cheia => tem próxima", uma página N>0 vazia só significa que
    // o total era múltiplo exato de 100. Barrar isso quebraria a paginação.
    const result = await makeAdapterWithBody(loadFixture("postings-vazio.json")).fetch(
      { ...task, selector: "BoschGroup", page: 1 },
      NO_CACHE,
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk() || result.value.kind !== "fetched") throw new Error("fetch falhou");
    expect(result.value.batch.next).toBeNull();
  });

  it("board com vagas passa direto pela guarda", async () => {
    const result = await makeAdapterWithBody(
      loadFixture("postings-smartrecruiters-pagina0.json"),
    ).fetch({ ...task, selector: "smartrecruiters" }, NO_CACHE);

    expect(result.isOk()).toBe(true);
    if (!result.isOk() || result.value.kind !== "fetched") throw new Error("fetch falhou");
    expect(result.value.batch.cache.etag).toBe('W/"abc"');
  });
});

describe("SmartRecruitersAdapter.fetch — paginação por limit/offset", () => {
  function makeAdapterWithPage(itemCount: number, totalFound: number): SmartRecruitersAdapter {
    return makeAdapterWithBody(
      JSON.stringify({
        offset: 0,
        limit: 100,
        totalFound,
        content: Array.from({ length: itemCount }, (_, index) => ({
          id: `${index}`,
          name: "Dev",
        })),
      }),
    );
  }

  const task = {
    sourceId: "smartrecruiters",
    selector: "BoschGroup",
    page: 0,
    runId: "r",
    params: {},
  };

  it("continua quando a página vem cheia", async () => {
    const result = await makeAdapterWithPage(100, 4800).fetch(task, NO_CACHE);

    if (!result.isOk() || result.value.kind !== "fetched") throw new Error("fetch falhou");
    expect(result.value.batch.next).toEqual({ ...task, page: 1 });
  });

  it("para quando a página vem incompleta", async () => {
    const result = await makeAdapterWithPage(37, 4800).fetch(task, NO_CACHE);

    if (!result.isOk() || result.value.kind !== "fetched") throw new Error("fetch falhou");
    expect(result.value.batch.next).toBeNull();
  });

  it("não para só porque totalFound diz que acabou", async () => {
    /**
     * `totalFound` foi verificado HONESTO nesta fonte (offset 4700 devolve 100
     * e offset 4800 devolve 0 num total de 4800), diferente do `total` do Gupy.
     * Mesmo assim a trilha não se apoia nele: o custo de confiar e estar errado
     * é perder vagas em silêncio; o de não confiar é uma requisição a mais.
     */
    const result = await makeAdapterWithPage(100, 100).fetch(task, NO_CACHE);

    if (!result.isOk() || result.value.kind !== "fetched") throw new Error("fetch falhou");
    expect(result.value.batch.next).toEqual({ ...task, page: 1 });
  });

  it("respeita o teto de páginas para não paginar infinitamente", async () => {
    const result = await makeAdapterWithPage(100, 999_999).fetch({ ...task, page: 49 }, NO_CACHE);

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

    const result = await new SmartRecruitersAdapter(
      client as unknown as SmartRecruitersClient,
    ).fetch(task, { etag: 'W/"abc"', lastModified: null });

    if (!result.isOk()) throw new Error("fetch falhou");
    expect(result.value.kind).toBe("not-modified");
  });
});

describe("SmartRecruitersAdapter.fetch — erros de transporte", () => {
  const task = {
    sourceId: "smartrecruiters",
    selector: "BoschGroup",
    page: 0,
    runId: "r",
    params: {},
  };

  function makeAdapterThrowing(error: unknown): SmartRecruitersAdapter {
    const client = {
      listPostings: async () => {
        throw error;
      },
    };
    return new SmartRecruitersAdapter(client as unknown as SmartRecruitersClient);
  }

  it("mantém 5xx como indisponibilidade retentável", async () => {
    const result = await makeAdapterThrowing(new SourceHttpError(503, "HTTP 503")).fetch(
      task,
      NO_CACHE,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;

    expect(result.error.type).toBe(ErrorType.SOURCE_UNAVAILABLE);
    expect(result.error.retryable).toBe(true);
  });

  it("trata timeout (sem resposta) como indisponibilidade", async () => {
    const result = await makeAdapterThrowing(new SourceHttpError(null, "Timeout de 8000ms")).fetch(
      task,
      NO_CACHE,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(ErrorType.SOURCE_UNAVAILABLE);
  });

  it("não trata 404 como slug morto: esta fonte não emite esse sinal", async () => {
    // O único 404 medido veio de rota inexistente (`/v1/companies/{slug}` sem
    // `/postings`), não de board inexistente. Classificar como config inválida
    // aqui daria um diagnóstico falso.
    const result = await makeAdapterThrowing(new SourceHttpError(404, "HTTP 404")).fetch(
      task,
      NO_CACHE,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(ErrorType.SOURCE_CONTRACT_DRIFT);
  });
});

describe("SmartRecruitersAdapter.parse — deriva de contrato", () => {
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
    const result = adapter.parse(
      makeBatch(JSON.stringify({ offset: 0, limit: 100, totalFound: 0, data: [] })),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("'content'");
  });

  it("acusa a perda de totalFound, que é o que detecta board fantasma", () => {
    // Fixture derivada do payload real, sem `totalFound`. Perder esse campo em
    // silêncio apagaria a única proteção deste adapter contra o 200-vazio.
    const result = adapter.parse(makeBatch(loadFixture("postings-deformado.json")));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("board fantasma");
  });

  it("detecta mudança de tipo dentro de um item", () => {
    const payload = JSON.stringify({
      offset: 0,
      limit: 100,
      totalFound: 1,
      content: [{ id: 744000143115219, name: "Dev" }],
    });

    const result = adapter.parse(makeBatch(payload));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("content[0].id");
  });
});
