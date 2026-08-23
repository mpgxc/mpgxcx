import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorType, type RawBatch, RemoteMode } from "@job-radar/core";
import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../http/circuit-breaker.js";
import { SourceHttpError } from "../http/http-client.js";
import { GreenhouseAdapter } from "./greenhouse.adapter.js";
import { GreenhouseClient } from "./greenhouse.client.js";
import { decodeHtmlEntities } from "./greenhouse.mapper.js";

const FIXTURE_DIR = fileURLToPath(new URL("../../../../fixtures/greenhouse/", import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(`${FIXTURE_DIR}${name}`, "utf8");
}

const FETCHED_AT = new Date("2026-08-23T00:00:00.000Z");

function makeBatch(payload: string, slug = "greenhouse"): RawBatch {
  return {
    task: { sourceId: "greenhouse", selector: slug, page: 0, runId: "run-1", params: {} },
    payload,
    contentType: "application/json",
    fetchedAt: FETCHED_AT,
    cache: { etag: null, lastModified: null },
    next: null,
  };
}

function makeAdapter(): GreenhouseAdapter {
  // `parse` é puro, então os testes de parsing não tocam em HTTP.
  const client = new GreenhouseClient(
    null as never,
    new CircuitBreaker("greenhouse", { failureThreshold: 3, cooldownMs: 1000 }),
  );
  return new GreenhouseAdapter(client);
}

describe("GreenhouseClient.buildUrl", () => {
  it("mantém os dois parâmetros que a fonte exige para devolver o dado", () => {
    // Medido na API real: sem `content=true` a chave `content` some do item, e
    // sem `pay_transparency=true` some `pay_input_ranges`. Este teste existe
    // para que ninguém "limpe" a URL e apague descrição e salário em silêncio.
    const url = GreenhouseClient.buildUrl({ slug: "stripe" });

    expect(url).toBe(
      "https://api.greenhouse.io/v1/boards/stripe/jobs?content=true&pay_transparency=true",
    );
  });

  it("escapa o slug em vez de concatenar texto na URL", () => {
    const url = GreenhouseClient.buildUrl({ slug: "a b/c" });
    expect(url).toContain("/boards/a%20b%2Fc/jobs");
  });
});

describe("GreenhouseAdapter.discover", () => {
  it("emite exatamente UMA tarefa por slug — o endpoint é dump completo", () => {
    const result = makeAdapter().discover(
      { sourceId: "greenhouse", selector: "stripe", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value).toEqual([
      { sourceId: "greenhouse", selector: "stripe", page: 0, runId: "run-1", params: {} },
    ]);
  });

  it("recusa selector vazio", () => {
    const result = makeAdapter().discover(
      { sourceId: "greenhouse", selector: "  ", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(ErrorType.VALIDATION);
  });

  it("recusa slug com caractere que não cabe na URL do board", () => {
    const result = makeAdapter().discover(
      { sourceId: "greenhouse", selector: "stripe/jobs?x=1", enabled: true, params: {} },
      "run-1",
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(ErrorType.VALIDATION);
  });
});

describe("GreenhouseAdapter.fetch — dump completo, sem paginação", () => {
  const task = { sourceId: "greenhouse", selector: "greenhouse", page: 0, runId: "r", params: {} };
  const noCache = { etag: null, lastModified: null };

  function makeAdapterWithBody(body: string): GreenhouseAdapter {
    const client = {
      listJobs: async () => ({
        status: 200,
        body,
        contentType: "application/json",
        etag: 'W/"abc"',
        lastModified: null,
      }),
    };
    return new GreenhouseAdapter(client as unknown as GreenhouseClient);
  }

  it("nunca devolve continuação, mesmo com o board cheio", async () => {
    // A prova de que a `JobSourcePort` cobre os dois formatos sem mudança no
    // core: o Gupy encadeia páginas por `next`, aqui `next` é sempre nulo.
    const result = await makeAdapterWithBody(loadFixture("board-greenhouse.json")).fetch(
      task,
      noCache,
    );

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
    const result = await new GreenhouseAdapter(client as unknown as GreenhouseClient).fetch(task, {
      etag: 'W/"abc"',
      lastModified: null,
    });

    if (!result.isOk()) throw new Error("fetch falhou");
    expect(result.value.kind).toBe("not-modified");
  });
});

describe("GreenhouseAdapter.parse — board real completo", () => {
  const adapter = makeAdapter();
  // Board do próprio Greenhouse: 15 vagas, dump completo, gravado em 23/08/2026.
  const payload = loadFixture("board-greenhouse.json");

  it("converte o board inteiro em JobPosting", () => {
    const result = adapter.parse(makeBatch(payload));

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value).toHaveLength(15);

    const [first] = result.value;
    if (!first) throw new Error("fixture vazia");

    expect(first.props.source.id).toBe("greenhouse");
    expect(first.props.source.externalId).toBe("8141795");
    expect(first.props.source.url).toContain("job-boards.greenhouse.io/greenhouse/jobs/");
    expect(first.props.company.name).toBe("Greenhouse");
    expect(first.props.company.slug).toBe("greenhouse");
    expect(first.props.title).toBe("Director, People Systems and Operations");
  });

  it("usa o slug da tarefa como identidade da empresa", () => {
    // `company_name` é texto de exibição e pode faltar; o slug do board não.
    const result = adapter.parse(makeBatch(payload, "outro-slug"));
    if (!result.isOk()) throw new Error("parse falhou");

    expect(result.value.every((job) => job.props.company.slug === "outro-slug")).toBe(true);
  });

  it("entrega a descrição como HTML de verdade, não como entidades", () => {
    const result = adapter.parse(makeBatch(payload));
    if (!result.isOk()) throw new Error("parse falhou");

    const [first] = result.value;
    if (!first) throw new Error("fixture vazia");

    expect(first.props.description.html).toContain("<p>");
    expect(first.props.description.html).not.toContain("&lt;p&gt;");
    expect(first.props.description.text).not.toContain("&lt;");
    expect(first.props.description.isEmpty).toBe(false);
  });

  it("extrai stack de dentro da descrição, que só existe depois do desescape", () => {
    const result = adapter.parse(makeBatch(payload));
    if (!result.isOk()) throw new Error("parse falhou");

    const engineer = result.value.find((job) => job.props.title.startsWith("Software Engineer"));
    if (!engineer) throw new Error("vaga esperada sumiu da fixture");

    // Nenhum destes termos está no título: vieram do HTML desescapado.
    expect(engineer.stack).toContain("typescript");
    expect(engineer.stack).toContain("react");
  });

  it("preserva o texto livre de localização e infere modalidade e país", () => {
    const result = adapter.parse(makeBatch(payload));
    if (!result.isOk()) throw new Error("parse falhou");

    const anywhere = result.value.find((job) =>
      job.props.location.raw.startsWith("Anywhere in the United States"),
    );
    if (!anywhere) throw new Error("vaga esperada sumiu da fixture");

    expect(anywhere.props.location.country).toBe("US");
    // "Anywhere in..." é remoto para o VO — sem parser novo aqui.
    expect(anywhere.props.location.remote).toBe(RemoteMode.REMOTE);
  });

  it("usa first_published como data de publicação", () => {
    const result = adapter.parse(makeBatch(payload));
    if (!result.isOk()) throw new Error("parse falhou");

    expect(result.value.every((job) => job.props.postedAt instanceof Date)).toBe(true);
  });

  it("deixa employmentType nulo: o endpoint não publica tipo de contrato", () => {
    const result = adapter.parse(makeBatch(payload));
    if (!result.isOk()) throw new Error("parse falhou");

    expect(result.value.every((job) => job.props.employmentType === null)).toBe(true);
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

describe("GreenhouseAdapter.parse — recorte do board grande", () => {
  const adapter = makeAdapter();
  /**
   * RECORTE, não board completo: a resposta real do `stripe` tem 4.387.089
   * bytes e 575 vagas. Foram mantidas 10 vagas representativas (engenharia +
   * variedade de `location.name`), e `meta.total` foi preservado em 575 de
   * propósito — serve de prova de que o parser não usa o total para nada.
   */
  const payload = loadFixture("board-stripe-recorte.json");

  it("parseia o recorte sem se importar com meta.total divergente", () => {
    const result = adapter.parse(makeBatch(payload, "stripe"));

    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;

    expect(result.value).toHaveLength(10);
    expect(JSON.parse(payload).meta.total).toBe(575);
    expect(result.value.every((job) => job.props.company.name === "Stripe")).toBe(true);
  });

  it("reconhece 'US - Remote' como trabalho remoto", () => {
    const result = adapter.parse(makeBatch(payload, "stripe"));
    if (!result.isOk()) throw new Error("parse falhou");

    const remote = result.value.find((job) => job.props.location.raw === "US - Remote");
    if (!remote) throw new Error("vaga esperada sumiu do recorte");

    expect(remote.props.location.remote).toBe(RemoteMode.REMOTE);
  });

  it("extrai stack de vagas de engenharia do recorte", () => {
    const result = adapter.parse(makeBatch(payload, "stripe"));
    if (!result.isOk()) throw new Error("parse falhou");

    const android = result.value.find((job) => job.props.title.startsWith("Android BSP Engineer"));
    if (!android) throw new Error("vaga esperada sumiu do recorte");

    expect(android.stack).toContain("android");
  });
});

describe("GreenhouseAdapter.parse — faixa salarial (pay_transparency)", () => {
  const adapter = makeAdapter();
  /**
   * RECORTE de 6 vagas do board `robinhood` (130 no total), escolhidas por
   * cobrirem os três casos de período que a fonte NÃO declara: valor por hora,
   * mensal e anual — mais uma vaga sem faixa nenhuma.
   */
  const payload = loadFixture("board-robinhood-recorte.json");

  function parsed() {
    const result = adapter.parse(makeBatch(payload, "robinhood"));
    if (!result.isOk()) throw new Error("parse falhou");
    return result.value;
  }

  it("consolida as faixas por zona em min-dos-mínimos e max-dos-máximos", () => {
    const job = parsed().find((item) => item.props.title === "Android Engineer, Money Experience");
    if (!job) throw new Error("vaga esperada sumiu do recorte");

    // Zonas 1/2/3: 166.000–195.000, 147.000–172.000 e 130.000–152.000 USD.
    expect(job.props.compensation?.min?.amountCents).toBe(13_000_000);
    expect(job.props.compensation?.max?.amountCents).toBe(19_500_000);
    expect(job.props.compensation?.currency).toBe("USD");
    expect(job.props.compensation?.period).toBe("YEAR");
  });

  it("deduz período por hora pela magnitude, que o rótulo da zona não revela", () => {
    // Rótulo é só geográfico ("Zone 3 (Lake Mary, FL; ...)") e min_cents=1960.
    const job = parsed().find((item) => item.props.title === "Account Maintenance Associate");
    if (!job) throw new Error("vaga esperada sumiu do recorte");

    expect(job.props.compensation?.period).toBe("HOUR");
    expect(job.props.compensation?.min?.amountCents).toBe(1_960);
  });

  it("deduz período mensal pelo rótulo da faixa", () => {
    const job = parsed().find((item) => item.props.title === "Deputy CCO");
    if (!job) throw new Error("vaga esperada sumiu do recorte");

    expect(job.props.compensation?.period).toBe("MONTH");
    expect(job.props.compensation?.currency).toBe("EUR");
  });

  it("deixa compensation nulo quando o board não publica faixa", () => {
    const job = parsed().find((item) => item.props.title === "Derivatives Risk Oversight Lead");
    if (!job) throw new Error("vaga esperada sumiu do recorte");

    expect(job.props.compensation).toBeNull();
  });
});

describe("decodeHtmlEntities", () => {
  it("desescapa as entidades que o Greenhouse realmente emite", () => {
    expect(decodeHtmlEntities("&lt;p&gt;Olá &amp; tchau&lt;/p&gt;")).toBe("<p>Olá & tchau</p>");
    expect(decodeHtmlEntities("&lt;a href=&quot;/x&quot;&gt;")).toBe('<a href="/x">');
  });

  it("desescapa a entidade numérica do apóstrofo", () => {
    // `&#39;` aparece nos cinco boards sondados — não é caso hipotético.
    expect(decodeHtmlEntities("we&#39;re hiring")).toBe("we're hiring");
  });

  it("desescapa UMA vez só, preservando o conteúdo duplamente escapado", () => {
    // 1.373 ocorrências de `&amp;nbsp;` / `&amp;lt;` só no board da Figma.
    // Trocar `&amp;` antes das demais viraria `<`, injetando uma tag falsa.
    expect(decodeHtmlEntities("&amp;lt;script&amp;gt;")).toBe("&lt;script&gt;");
    expect(decodeHtmlEntities("&lt;p&gt;3&amp;nbsp;dias&lt;/p&gt;")).toBe("<p>3&nbsp;dias</p>");
  });

  it("não inventa nada para o que não está na tabela", () => {
    expect(decodeHtmlEntities("&mdash; &#x27;")).toBe("&mdash; &#x27;");
  });
});

describe("GreenhouseAdapter.parse — board vazio e deriva de contrato", () => {
  const adapter = makeAdapter();

  it("aceita board sem vagas (o board 'test' responde exatamente isso)", () => {
    const result = adapter.parse(makeBatch(loadFixture("board-vazio.json"), "test"));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual([]);
  });

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
    const result = adapter.parse(makeBatch(JSON.stringify({ data: [], meta: { total: 0 } })));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("'jobs'");
  });

  it("detecta mudança de tipo dentro de um item", () => {
    const payload = JSON.stringify({
      jobs: [
        {
          id: "8141795",
          title: "Dev",
          absolute_url: "https://x",
          content: "",
          location: { name: "Remote" },
        },
      ],
    });

    const result = adapter.parse(makeBatch(payload));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("jobs[0].id");
  });

  it("acusa a perda de content=true na URL em vez de esvaziar a descrição", () => {
    // Sem o parâmetro a chave `content` some do item — o modo de falha mais
    // caro desta fonte, porque o pipeline continuaria "funcionando".
    const payload = JSON.stringify({
      jobs: [
        {
          id: 1,
          title: "Dev",
          absolute_url: "https://x",
          location: { name: "Remote" },
        },
      ],
    });

    const result = adapter.parse(makeBatch(payload));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("content=true");
  });

  it("acusa location.name ausente", () => {
    const payload = JSON.stringify({
      jobs: [{ id: 1, title: "Dev", absolute_url: "https://x", content: "" }],
    });

    const result = adapter.parse(makeBatch(payload));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain("jobs[0].location.name");
  });
});

describe("GreenhouseAdapter.fetch — slug inexistente", () => {
  const task = { sourceId: "greenhouse", selector: "board-que-nao-existe", page: 0, runId: "r" };
  const noCache = { etag: null, lastModified: null };

  function makeAdapterThrowing(error: unknown): GreenhouseAdapter {
    const client = {
      listJobs: async () => {
        throw error;
      },
    };
    return new GreenhouseAdapter(client as unknown as GreenhouseClient);
  }

  it("trata o 404 do board como config inválida, não como deriva de contrato", async () => {
    // Comportamento real medido: HTTP 404 com corpo
    // {"status":404,"error":"Job not found"} — "Job", mesmo sendo o board
    // inteiro que não existe. A API está saudável; o registro de fontes é que
    // aponta para um slug morto.
    const body = loadFixture("slug-inexistente.json");
    const result = await makeAdapterThrowing(
      new SourceHttpError(404, "HTTP 404 em https://api.greenhouse.io/...", body),
    ).fetch({ ...task, params: {} }, noCache);

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;

    expect(result.error.type).toBe(ErrorType.VALIDATION);
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toContain("board-que-nao-existe");
    expect(result.error.message).toContain("Job not found");
  });

  it("mantém 5xx como indisponibilidade retentável", async () => {
    const result = await makeAdapterThrowing(new SourceHttpError(503, "HTTP 503")).fetch(
      { ...task, params: {} },
      noCache,
    );

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;

    expect(result.error.type).toBe(ErrorType.SOURCE_UNAVAILABLE);
    expect(result.error.retryable).toBe(true);
  });

  it("trata timeout (sem resposta) como indisponibilidade", async () => {
    const result = await makeAdapterThrowing(new SourceHttpError(null, "Timeout de 8000ms")).fetch(
      { ...task, params: {} },
      noCache,
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(ErrorType.SOURCE_UNAVAILABLE);
  });
});
