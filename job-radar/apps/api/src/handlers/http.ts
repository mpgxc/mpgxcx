import { type BusinessError, ErrorType } from "@job-radar/core";
import type { APIGatewayProxyResult } from "aws-lambda";

/**
 * A ÚNICA tradução de erro de negócio para status HTTP no sistema inteiro.
 *
 * O domínio fala `ErrorType`, que é semântico; HTTP é detalhe de uma borda
 * específica. Espalhar esse mapa faria dois pontos discordarem sobre o que é
 * 400 e o que é 503, e — pior — convidaria alguém a colocar `404` dentro de um
 * use-case, amarrando o domínio a um protocolo que ele não usa.
 */
const STATUS_BY_TYPE: Record<ErrorType, number> = {
  [ErrorType.VALIDATION]: 400,
  [ErrorType.NOT_FOUND]: 404,
  [ErrorType.CONFLICT]: 409,
  // A fonte aqui é o índice de busca: indisponível é temporário, e 503 é o
  // único status que diz ao cliente (e à CDN) que vale tentar de novo.
  [ErrorType.SOURCE_UNAVAILABLE]: 503,
  // Contrato quebrado a jusante é falha NOSSA de integração, não do cliente.
  [ErrorType.SOURCE_CONTRACT_DRIFT]: 502,
  [ErrorType.UNEXPECTED]: 500,
};

export function statusFor(error: BusinessError): number {
  return STATUS_BY_TYPE[error.type] ?? 500;
}

export interface JsonOptions {
  readonly correlationId: string;
  /** Segundos de `max-age`. Ausente ou 0 vira `no-store`. */
  readonly cacheSeconds?: number;
}

export function json(status: number, body: unknown, options: JsonOptions): APIGatewayProxyResult {
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Devolvido sempre: é o que liga o log estruturado da Lambda ao ticket
      // que o usuário abre com "deu erro".
      "x-correlation-id": options.correlationId,
      "cache-control":
        status === 200 && options.cacheSeconds
          ? `public, max-age=${options.cacheSeconds}`
          : "no-store",
    },
    body: JSON.stringify(body),
  };
}

/** Corpo de erro estável — `code` e `type` são contrato, `message` é humano. */
export function errorResponse(error: BusinessError, options: JsonOptions): APIGatewayProxyResult {
  return json(
    statusFor(error),
    { error: error.toJSON() },
    { correlationId: options.correlationId },
  );
}

/**
 * Junta os dois formatos de query string do API Gateway numa lista.
 *
 * `?stack=go&stack=rust` chega em `multiValueQueryStringParameters`;
 * `?stack=go,rust` chega inteiro em `queryStringParameters`. As duas formas são
 * usadas no mundo real, e recusar uma delas só rende suporte.
 */
export function listParam(
  single: Record<string, string | undefined> | null | undefined,
  multi: Record<string, string[] | undefined> | null | undefined,
  name: string,
): string[] {
  const raw = multi?.[name] ?? (single?.[name] === undefined ? [] : [single[name] as string]);

  return raw
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Número da query string.
 *
 * `undefined` quando ausente, `NaN` quando presente e ilegível — e `NaN` é
 * exatamente o que `JobQuery` recusa. Traduzir aqui para um erro seria
 * duplicar a regra de validação nas duas pontas.
 */
export function numberParam(
  params: Record<string, string | undefined> | null | undefined,
  name: string,
): number | undefined {
  const raw = params?.[name]?.trim();
  return raw === undefined || raw === "" ? undefined : Number(raw);
}

export function stringParam(
  params: Record<string, string | undefined> | null | undefined,
  name: string,
): string | undefined {
  const raw = params?.[name]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}
