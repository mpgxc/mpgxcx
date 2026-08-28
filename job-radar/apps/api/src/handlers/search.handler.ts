import type { JobQueryInput, SearchHit, SearchJobsOutput } from "@job-radar/core";
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import { buildContainer } from "../composition.js";
import { errorResponse, json, listParam, numberParam, stringParam } from "./http.js";

/** Três linhas de descrição na listagem; o resto está a um clique de distância. */
const EXCERPT_LENGTH = 280;

/**
 * `GET /jobs` — busca com texto livre e facetas combináveis.
 *
 * Query string aceita:
 *   q, stack, seniority, remote, country, salaryMin, salaryMax,
 *   salaryCurrency, postedAfter, postedBefore, page, size, sort
 *
 * As facetas aceitam repetição (`?stack=go&stack=rust`) ou lista
 * (`?stack=go,rust`) — as duas viram a mesma consulta.
 *
 * Não existe filtro de status: o índice só guarda vaga ativa, por decisão do
 * projetor (ver `ProjectJobChangesUseCase`). Um parâmetro com um único valor
 * possível seria ruído na API.
 */
export async function handler(
  event: APIGatewayProxyEvent,
  context: Context,
): Promise<APIGatewayProxyResult> {
  const container = buildContainer();
  const correlationId =
    event.headers?.["x-correlation-id"] ??
    event.headers?.["X-Correlation-Id"] ??
    context.awsRequestId;
  const logger = container.logger.child({ correlationId });

  const result = await container.searchJobs.execute(toJobQueryInput(event));

  if (result.isErr()) {
    // WARN, não ERROR: entrada inválida de cliente é o caso esperado de uma API
    // pública. Logar como erro afogaria o alarme que existe para falha nossa.
    logger.warn("consulta recusada", result.error.toJSON());
    return errorResponse(result.error, { correlationId });
  }

  logger.info("busca concluída", {
    total: result.value.total,
    returned: result.value.hits.length,
    page: result.value.query.page,
    sort: result.value.query.sort,
  });

  return json(200, toResponseBody(result.value), {
    correlationId,
    cacheSeconds: container.config.cacheSeconds,
  });
}

/**
 * Query string -> entrada do domínio. Pura e exportada para o teste.
 *
 * A tradução só DECODIFICA: divide listas, converte números, normaliza vazio
 * para ausente. Nenhuma regra de aceitação mora aqui — `Number("abc")` vira
 * `NaN` e segue, porque quem decide o que é um número válido é `JobQuery`. Se
 * a borda começasse a validar, a mesma regra passaria a existir em dois
 * lugares e um dia divergiria.
 */
export function toJobQueryInput(event: APIGatewayProxyEvent): JobQueryInput {
  const single = event.queryStringParameters;
  const multi = event.multiValueQueryStringParameters;

  return {
    text: stringParam(single, "q") ?? null,
    stack: listParam(single, multi, "stack"),
    seniority: listParam(single, multi, "seniority"),
    remote: listParam(single, multi, "remote"),
    countries: listParam(single, multi, "country"),
    salary: {
      minCents: numberParam(single, "salaryMin") ?? null,
      maxCents: numberParam(single, "salaryMax") ?? null,
      currency: stringParam(single, "salaryCurrency") ?? null,
    },
    postedAfter: stringParam(single, "postedAfter") ?? null,
    postedBefore: stringParam(single, "postedBefore") ?? null,
    page: numberParam(single, "page") ?? null,
    size: numberParam(single, "size") ?? null,
    sort: stringParam(single, "sort") ?? null,
  };
}

/**
 * A consulta entendida é ecoada na resposta.
 *
 * Sem isso, o cliente que mandou `sort` inválido... não manda: o domínio
 * recusa. O que ele MANDA e não percebe é `sort` ausente, e aí a ordenação
 * padrão muda conforme exista texto ou não. Devolver o que foi aplicado torna
 * esse comportamento visível em vez de mágico.
 */
function toResponseBody(output: SearchJobsOutput) {
  const { query } = output;

  return {
    jobs: output.hits.map(toJobBody),
    total: output.total,
    totalIsLowerBound: output.totalIsLowerBound,
    hasMore: output.hasMore,
    query: {
      q: query.text,
      stack: query.stack,
      seniority: query.seniority,
      remote: query.remote,
      country: query.countries,
      salary: query.salary,
      postedAfter: query.postedAfter,
      postedBefore: query.postedBefore,
      page: query.page,
      size: query.size,
      sort: query.sort,
    },
  };
}

function toJobBody(hit: SearchHit) {
  const { props } = hit.job;

  return {
    id: props.id,
    title: props.title,
    company: { name: props.companyName, slug: props.companySlug },
    source: { id: props.sourceId, externalId: props.externalId, url: props.url },
    location: {
      raw: props.locationRaw,
      remote: props.remote,
      country: props.country,
      city: props.city,
    },
    /**
     * Recorte, não a descrição inteira. Uma vaga do Greenhouse tem descrição de
     * vários KB; devolver 20 delas numa página faria um payload de megabytes
     * para uma tela que mostra três linhas. Quem quer o texto todo segue a
     * `url` — que é, aliás, para onde o candidato vai de qualquer forma.
     */
    excerpt: props.description.slice(0, EXCERPT_LENGTH),
    seniority: props.seniority,
    stack: props.stack,
    employmentType: props.employmentType,
    salary: props.salary,
    postedAt: props.postedAt,
    firstSeenAt: props.firstSeenAt,
    lastSeenAt: props.lastSeenAt,
    score: hit.score,
  };
}
