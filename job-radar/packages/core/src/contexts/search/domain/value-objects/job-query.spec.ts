import { describe, expect, it } from "vitest";
import { ErrorType } from "../../../../commons/business-error.js";
import { RemoteMode } from "../../../ingestion/domain/value-objects/location.js";
import { Seniority } from "../../../ingestion/domain/value-objects/seniority.js";
import { DEFAULT_PAGE_SIZE, JobQuery, MAX_PAGE_SIZE, MAX_RESULT_WINDOW } from "./job-query.js";

describe("JobQuery — filtros combinados", () => {
  it("combina texto e todas as facetas na mesma consulta", () => {
    const query = JobQuery.create({
      text: "  engenheiro de plataforma  ",
      stack: ["Go", "kubernetes", "go"],
      seniority: ["senior", "STAFF"],
      remote: ["remote"],
      countries: ["br", "pt"],
      salary: { minCents: 1_500_000, maxCents: 3_000_000, currency: "brl" },
      postedAfter: "2026-08-01T00:00:00.000Z",
      postedBefore: "2026-08-28T00:00:00.000Z",
      page: 1,
      size: 10,
      sort: "recent",
    }).unwrapOrThrow();

    expect(query.text).toBe("engenheiro de plataforma");
    // Deduplicado e ordenado: `go` veio duas vezes e em caixa diferente.
    expect(query.stack).toEqual(["go", "kubernetes"]);
    expect(query.seniority).toEqual([Seniority.SENIOR, Seniority.STAFF]);
    expect(query.remote).toEqual([RemoteMode.REMOTE]);
    expect(query.countries).toEqual(["BR", "PT"]);
    expect(query.salary).toEqual({ minCents: 1_500_000, maxCents: 3_000_000, currency: "BRL" });
    expect(query.postedAfter).toBe("2026-08-01T00:00:00.000Z");
    expect(query.sort).toBe("RECENT");
    expect(query.offset).toBe(10);
    expect(query.isEmpty).toBe(false);
  });

  it("consulta vazia é válida e vira o catálogo inteiro, ordenado por data", () => {
    const query = JobQuery.create().unwrapOrThrow();

    expect(query.isEmpty).toBe(true);
    expect(query.size).toBe(DEFAULT_PAGE_SIZE);
    expect(query.page).toBe(0);
    // Sem texto, relevância dá o mesmo score para todo mundo e a ordem fica
    // instável entre requisições — quem pagina veria itens repetidos.
    expect(query.sort).toBe("RECENT");
  });

  it("com texto e sem `sort` explícito, o padrão é relevância", () => {
    expect(JobQuery.create({ text: "rust" }).unwrapOrThrow().sort).toBe("RELEVANCE");
  });
});

describe("JobQuery — entrada inválida vira VALIDATION", () => {
  const cases: ReadonlyArray<readonly [string, Parameters<typeof JobQuery.create>[0]]> = [
    ["stack fora do padrão de token", { stack: ["go; drop table"] }],
    ["senioridade inexistente", { seniority: ["ARQUIMAGO"] }],
    ["modalidade remota inexistente", { remote: ["TELEPORTE"] }],
    ["país fora de ISO alpha-2", { countries: ["Brasil"] }],
    ["data que não é ISO", { postedAfter: "ontem" }],
    ["intervalo de datas invertido", { postedAfter: "2026-08-28", postedBefore: "2026-08-01" }],
    ["ordenação inexistente", { sort: "ALFABETICA" }],
    ["relevância sem texto de busca", { sort: "RELEVANCE" }],
    ["faixa salarial sem moeda", { salary: { minCents: 100 } }],
    ["moeda não suportada", { salary: { minCents: 100, currency: "JPY" } }],
    ["moeda sem faixa nenhuma", { salary: { currency: "BRL" } }],
    ["faixa salarial invertida", { salary: { minCents: 500, maxCents: 100, currency: "BRL" } }],
    ["salário em centavos fracionários", { salary: { minCents: 10.5, currency: "BRL" } }],
    ["página negativa", { page: -1 }],
    ["tamanho de página zero", { size: 0 }],
    ["tamanho de página acima do teto", { size: MAX_PAGE_SIZE + 1 }],
  ];

  for (const [label, input] of cases) {
    it(`recusa ${label}`, () => {
      const result = JobQuery.create(input);

      expect(result.isErr()).toBe(true);
      if (!result.isErr()) return;
      // O tipo é semântico. Quem traduz para 400 é a borda HTTP, e só ela.
      expect(result.error.type).toBe(ErrorType.VALIDATION);
      expect(result.error.retryable).toBe(false);
    });
  }

  it("`page=abc` chega da borda como NaN e é recusado aqui, não lá", () => {
    // A borda só decodifica; a regra de "o que é um número válido" mora no
    // domínio. Se a borda validasse, a mesma regra existiria em dois lugares.
    const result = JobQuery.create({ page: Number("abc") });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.type).toBe(ErrorType.VALIDATION);
  });
});

describe("JobQuery — paginação profunda", () => {
  it("aceita a última página que cabe na janela", () => {
    const query = JobQuery.create({
      page: MAX_RESULT_WINDOW / MAX_PAGE_SIZE - 1,
      size: MAX_PAGE_SIZE,
    }).unwrapOrThrow();

    expect(query.offset + query.size).toBe(MAX_RESULT_WINDOW);
  });

  it("RECUSA a página seguinte em vez de truncar em silêncio", () => {
    // Truncar devolveria uma página vazia indistinguível de "acabaram as
    // vagas", e quem pagina nunca saberia que bateu num limite.
    const result = JobQuery.create({
      page: MAX_RESULT_WINDOW / MAX_PAGE_SIZE,
      size: MAX_PAGE_SIZE,
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error.code).toBe("SEARCH_WINDOW_EXCEEDED");
    expect(result.error.type).toBe(ErrorType.VALIDATION);
    // A mensagem tem que dizer o que fazer no lugar: refinar, não avançar.
    expect(result.error.message).toContain("Refine os filtros");
  });

  it("o teto é de PROFUNDIDADE, não de página: página pequena e funda também cai", () => {
    const result = JobQuery.create({ page: MAX_RESULT_WINDOW, size: 1 });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("SEARCH_WINDOW_EXCEEDED");
  });
});
