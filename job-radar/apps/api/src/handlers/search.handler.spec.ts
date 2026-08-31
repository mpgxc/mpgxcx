import { ErrorType, JobQuery, RemoteMode, Seniority } from "@job-radar/core";
import type { APIGatewayProxyEvent, Context } from "aws-lambda";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { statusFor } from "./http.js";
import { handler, toJobQueryInput } from "./search.handler.js";

/** A composição exige o endpoint no cold start; a busca válida não é exercida aqui. */
beforeAll(() => {
  process.env.SEARCH_ENDPOINT ??= "https://exemplo.us-east-1.aoss.amazonaws.com";
});

afterEach(() => {
  vi.restoreAllMocks();
});

const CONTEXT = { awsRequestId: "req-1" } as Context;

function eventWith(
  single: Record<string, string> | null,
  multi: Record<string, string[]> | null = null,
): APIGatewayProxyEvent {
  return {
    queryStringParameters: single,
    multiValueQueryStringParameters: multi,
    headers: {},
  } as unknown as APIGatewayProxyEvent;
}

describe("toJobQueryInput — query string vira consulta do domínio", () => {
  it("traduz texto e todas as facetas combinadas", () => {
    const query = JobQuery.create(
      toJobQueryInput(
        eventWith({
          q: "engenheiro de plataforma",
          stack: "go,kubernetes",
          seniority: "SENIOR",
          remote: "REMOTE",
          country: "br",
          salaryMin: "1500000",
          salaryMax: "3000000",
          salaryCurrency: "BRL",
          postedAfter: "2026-08-01T00:00:00.000Z",
          page: "2",
          size: "10",
          sort: "RECENT",
        }),
      ),
    ).unwrapOrThrow();

    expect(query.text).toBe("engenheiro de plataforma");
    expect(query.stack).toEqual(["go", "kubernetes"]);
    expect(query.seniority).toEqual([Seniority.SENIOR]);
    expect(query.remote).toEqual([RemoteMode.REMOTE]);
    expect(query.countries).toEqual(["BR"]);
    expect(query.salary).toEqual({ minCents: 1_500_000, maxCents: 3_000_000, currency: "BRL" });
    expect(query.postedAfter).toBe("2026-08-01T00:00:00.000Z");
    expect(query.page).toBe(2);
    expect(query.size).toBe(10);
    expect(query.sort).toBe("RECENT");
  });

  it("aceita a faceta repetida (`?stack=go&stack=rust`) igual à lista", () => {
    // As duas formas existem no mundo real; recusar uma delas só rende suporte.
    const repetida = toJobQueryInput(eventWith({ stack: "rust" }, { stack: ["go", "rust"] }));
    const lista = toJobQueryInput(eventWith({ stack: "go,rust" }));

    expect(JobQuery.create(repetida).unwrapOrThrow().stack).toEqual(
      JobQuery.create(lista).unwrapOrThrow().stack,
    );
  });

  it("query string vazia vira a consulta vazia, que é válida", () => {
    const query = JobQuery.create(toJobQueryInput(eventWith(null))).unwrapOrThrow();

    expect(query.isEmpty).toBe(true);
    expect(query.page).toBe(0);
  });

  it("só DECODIFICA: número ilegível vira NaN e a regra fica no domínio", () => {
    // Se a borda validasse, a mesma regra existiria em dois lugares e um dia
    // divergiria. Aqui ela sai como NaN e `JobQuery` recusa.
    expect(toJobQueryInput(eventWith({ page: "abc" })).page).toBeNaN();
  });
});

describe("handler — entrada inválida", () => {
  it("responde 400 com BusinessError do tipo VALIDATION", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await handler(eventWith({ seniority: "ARQUIMAGO" }), CONTEXT);
    const body = JSON.parse(response.body) as { error: { type: string; code: string } };

    expect(response.statusCode).toBe(400);
    expect(body.error.type).toBe(ErrorType.VALIDATION);
    expect(body.error.code).toBe("INVALID_SEARCH_QUERY");
    // Resposta de erro nunca é cacheável — o cliente tem que ver a correção.
    expect(response.headers?.["cache-control"]).toBe("no-store");
    expect(response.headers?.["x-correlation-id"]).toBe("req-1");
  });

  it("recusa paginação profunda com 400 e diz o que fazer no lugar", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await handler(eventWith({ page: "500", size: "100" }), CONTEXT);
    const body = JSON.parse(response.body) as { error: { code: string; message: string } };

    expect(response.statusCode).toBe(400);
    expect(body.error.code).toBe("SEARCH_WINDOW_EXCEEDED");
    expect(body.error.message).toContain("Refine os filtros");
  });

  it("NÃO toca no índice quando a consulta é inválida", async () => {
    // A recusa acontece antes do I/O: consulta torta não custa requisição ao
    // cluster. Se tocasse, `fetch` seria chamado — e aqui ele explodiria.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await handler(eventWith({ size: "9999" }), CONTEXT);

    expect(response.statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("statusFor — a única tradução ErrorType -> HTTP do sistema", () => {
  it("mapeia cada tipo semântico para o status certo", () => {
    const expected: Record<ErrorType, number> = {
      [ErrorType.VALIDATION]: 400,
      [ErrorType.NOT_FOUND]: 404,
      [ErrorType.CONFLICT]: 409,
      [ErrorType.SOURCE_UNAVAILABLE]: 503,
      [ErrorType.SOURCE_CONTRACT_DRIFT]: 502,
      [ErrorType.UNEXPECTED]: 500,
    };

    for (const [type, status] of Object.entries(expected)) {
      // O domínio nunca fala HTTP; o mapa vive só aqui, na borda.
      expect(statusFor({ type } as Parameters<typeof statusFor>[0])).toBe(status);
    }
  });
});
