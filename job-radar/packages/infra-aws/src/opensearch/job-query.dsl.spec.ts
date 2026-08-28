import { JobQuery, MAX_RESULT_WINDOW } from "@job-radar/core";
import { describe, expect, it } from "vitest";
import { buildSearchBody } from "./job-query.dsl.js";

function bodyOf(input: Parameters<typeof JobQuery.create>[0]): Record<string, unknown> {
  return buildSearchBody(JobQuery.create(input).unwrapOrThrow());
}

function filtersOf(body: Record<string, unknown>): Record<string, unknown>[] {
  const query = body.query as { bool?: { filter?: Record<string, unknown>[] } };
  return query.bool?.filter ?? [];
}

describe("buildSearchBody — semântica das facetas", () => {
  it("dentro da faceta é OU: um `terms` com os dois valores", () => {
    // Marcar um segundo valor da MESMA faceta tem que ALARGAR o resultado.
    // Se virasse dois `term`, a consulta pediria vaga de Go E de Rust ao mesmo
    // tempo, e a contagem de facetas passaria a mentir.
    expect(filtersOf(bodyOf({ stack: ["go", "rust"] }))).toEqual([
      { terms: { stack: ["go", "rust"] } },
    ]);
  });

  it("entre facetas é E: cada faceta vira um item do mesmo `filter`", () => {
    const filters = filtersOf(
      bodyOf({ stack: ["go"], seniority: ["SENIOR"], remote: ["REMOTE"], countries: ["BR"] }),
    );

    expect(filters).toEqual([
      { terms: { stack: ["go"] } },
      { terms: { seniority: ["SENIOR"] } },
      { terms: { remote: ["REMOTE"] } },
      { terms: { country: ["BR"] } },
    ]);
  });

  it("facetas ficam em `filter`, não em `must`: filtro não pontua e é cacheável", () => {
    const body = bodyOf({ text: "plataforma", stack: ["go"] });
    const query = body.query as { bool: { must?: unknown[]; filter?: unknown[] } };

    expect(query.bool.must).toHaveLength(1);
    expect(query.bool.filter).toHaveLength(1);
  });

  it("consulta sem nada vira `match_all`, não um `bool` vazio", () => {
    expect(bodyOf({}).query).toEqual({ match_all: {} });
  });
});

describe("buildSearchBody — texto livre", () => {
  it("pesa o título acima da descrição e exige todos os termos", () => {
    const body = bodyOf({ text: "engenheiro de dados" });
    const must = (body.query as { bool: { must: Array<{ multi_match: Record<string, unknown> }> } })
      .bool.must;

    expect(must[0]?.multi_match).toMatchObject({
      query: "engenheiro de dados",
      // `or` devolveria tudo que contém "de".
      operator: "and",
    });
    expect(must[0]?.multi_match.fields).toContain("title^4");
    expect(must[0]?.multi_match.fields).toContain("description");
  });
});

describe("buildSearchBody — faixa salarial", () => {
  it("filtra por INTERSEÇÃO de faixas, usando os limites materializados", () => {
    // "A partir de 15k" tem que aparecer para quem pediu "até 20k". Os campos
    // `floorCents`/`ceilingCents` existem no documento justamente para que isso
    // caiba em dois `range` legíveis.
    const filters = filtersOf(
      bodyOf({ salary: { minCents: 1_000_000, maxCents: 2_000_000, currency: "BRL" } }),
    );

    expect(filters).toEqual([
      { term: { "salary.currency": "BRL" } },
      { range: { "salary.ceilingCents": { gte: 1_000_000 } } },
      { range: { "salary.floorCents": { lte: 2_000_000 } } },
    ]);
  });

  it("um lado só da faixa gera um `range` só, e a moeda continua obrigatória", () => {
    expect(filtersOf(bodyOf({ salary: { minCents: 800_000, currency: "USD" } }))).toEqual([
      { term: { "salary.currency": "USD" } },
      { range: { "salary.ceilingCents": { gte: 800_000 } } },
    ]);
  });
});

describe("buildSearchBody — data e paginação", () => {
  it("junta as duas pontas do intervalo num `range` só", () => {
    const filters = filtersOf(
      bodyOf({ postedAfter: "2026-08-01T00:00:00.000Z", postedBefore: "2026-08-28T00:00:00.000Z" }),
    );

    expect(filters).toEqual([
      {
        range: {
          postedAt: { gte: "2026-08-01T00:00:00.000Z", lte: "2026-08-28T00:00:00.000Z" },
        },
      },
    ]);
  });

  it("traduz página para `from`/`size` e limita a contagem à janela", () => {
    const body = bodyOf({ page: 3, size: 25 });

    expect(body.from).toBe(75);
    expect(body.size).toBe(25);
    // Contar além do que ninguém consegue paginar é varrer a coleção à toa.
    expect(body.track_total_hits).toBe(MAX_RESULT_WINDOW);
  });
});

describe("buildSearchBody — ordenação", () => {
  it("toda ordenação termina em `id` para a paginação ser estável", () => {
    // Sem desempate, dois documentos empatados trocam de posição entre
    // requisições, e quem pagina vê o mesmo item duas vezes.
    for (const input of [{ text: "go" }, { sort: "RECENT" }, { sort: "SALARY" }] as const) {
      const sort = bodyOf(input).sort as Array<Record<string, unknown>>;
      expect(sort.at(-1)).toEqual({ id: { order: "asc" } });
    }
  });

  it("RECENT usa `postedAt` com `lastSeenAt` de rede de segurança", () => {
    expect(bodyOf({ sort: "RECENT" }).sort).toEqual([
      // Fonte que não publica data não pode afundar por falta de campo.
      { postedAt: { order: "desc", missing: "_last" } },
      { lastSeenAt: { order: "desc" } },
      { id: { order: "asc" } },
    ]);
  });

  it("SALARY joga para o fim quem não publicou salário", () => {
    expect(bodyOf({ sort: "SALARY" }).sort).toEqual([
      { "salary.ceilingCents": { order: "desc", missing: "_last" } },
      { id: { order: "asc" } },
    ]);
  });
});
