/**
 * DTOs do job board público do Greenhouse, tipados a partir do payload REAL
 * gravado em `fixtures/greenhouse/`. Estes tipos não saem deste diretório — o
 * core nunca vê `absolute_url` nem `pay_input_ranges`.
 *
 * Endpoint: GET https://api.greenhouse.io/v1/boards/{slug}/jobs
 *   ?content=true&pay_transparency=true
 *
 * Duas armadilhas validadas contra a API real:
 *
 * - SEM `content=true` a chave `content` não vem vazia: ela simplesmente NÃO
 *   EXISTE no item. Uma regressão na URL apagaria a descrição de todas as
 *   vagas em silêncio, então `content` é obrigatório na guarda de contrato.
 * - SEM `pay_transparency=true` a chave `pay_input_ranges` também não existe.
 *   Com o parâmetro, os boards que publicam faixa devolvem os valores (94 de
 *   161 vagas na Figma) e os que não publicam devolvem array vazio.
 */

/** Campos ignorados de propósito: não têm destino na entidade canônica. */
export interface GreenhouseOfficeDto {
  readonly id: number;
  readonly name: string;
  /** "London, England, United Kingdom" — pode ser `null`. */
  readonly location: string | null;
}

export interface GreenhouseDepartmentDto {
  readonly id: number;
  readonly name: string;
}

export interface GreenhouseMetadataDto {
  readonly id: number;
  readonly name: string;
  readonly value: unknown;
  readonly value_type: string;
}

/**
 * Faixa salarial de UMA zona geográfica. Um board publica várias por vaga
 * ("Zone 1", "US Zone 2", "Lithuania Gross Monthly Pay Range").
 *
 * `min_cents`/`max_cents` já vêm em centavos inteiros — sem conversão de
 * decimal, ao contrário do que o resto do mundo faz.
 */
export interface GreenhousePayRangeDto {
  readonly min_cents: number;
  readonly max_cents: number;
  /** "USD", "CAD", "EUR", "GBP", "PLN" — nem toda moeda tem suporte em `Money`. */
  readonly currency_type: string;
  /** Rótulo livre da zona. É o único lugar que às vezes revela o período. */
  readonly title: string | null;
  /** HTML CRU (não escapado, diferente de `content`). Não usado. */
  readonly blurb: string | null;
}

export interface GreenhouseJobDto {
  readonly id: number;
  readonly internal_job_id: number;
  readonly title: string;
  /** ISO 8601 com offset: "2026-08-18T18:06:19-04:00". */
  readonly updated_at: string;
  readonly first_published: string | null;
  /** Código interno da requisição; vem `null` em ~11% das vagas medidas. */
  readonly requisition_id: string | null;
  readonly location: { readonly name: string };
  readonly absolute_url: string;
  /** HTML com entidades ESCAPADAS. Ver `decodeHtmlEntities` no mapper. */
  readonly content: string;
  readonly company_name: string | null;
  readonly metadata: readonly GreenhouseMetadataDto[];
  readonly departments: readonly GreenhouseDepartmentDto[];
  readonly offices: readonly GreenhouseOfficeDto[];
  /** Só existe com `pay_transparency=true` na URL. */
  readonly pay_input_ranges?: readonly GreenhousePayRangeDto[];
}

export interface GreenhouseJobsResponseDto {
  readonly jobs: readonly GreenhouseJobDto[];
  /**
   * `meta.total` bate com `jobs.length` em todos os boards medidos — ao
   * contrário do Gupy, aqui o total é honesto. Ainda assim nada depende dele:
   * o endpoint é dump completo, não há página seguinte para calcular.
   */
  readonly meta?: { readonly total: number };
}

/**
 * Guarda de contrato. Não é validação de negócio — é a detecção de que a fonte
 * mudou a API. Falhar aqui com mensagem específica é o que transforma "o
 * pipeline degradou em silêncio" em "o parser do Greenhouse quebrou no campo X".
 *
 * Só é exigido o que o mapper realmente consome. Exigir `departments` ou
 * `metadata` derrubaria o board inteiro por um campo que ninguém lê.
 */
export function assertJobsResponse(value: unknown): asserts value is GreenhouseJobsResponseDto {
  if (typeof value !== "object" || value === null) {
    throw new Error("resposta não é um objeto");
  }

  const candidate = value as Record<string, unknown>;

  if (!Array.isArray(candidate.jobs)) {
    throw new Error(`campo 'jobs' ausente ou não é array (recebido: ${typeof candidate.jobs})`);
  }

  if (candidate.meta !== undefined) {
    const meta = candidate.meta as Record<string, unknown> | null;
    if (typeof meta !== "object" || meta === null || typeof meta.total !== "number") {
      throw new Error("campo 'meta' presente mas sem 'total' numérico");
    }
  }

  for (const [index, job] of (candidate.jobs as unknown[]).entries()) {
    const record = job as Record<string, unknown>;
    if (typeof record?.id !== "number") throw new Error(`jobs[${index}].id não é number`);
    if (typeof record?.title !== "string") throw new Error(`jobs[${index}].title não é string`);
    if (typeof record?.absolute_url !== "string") {
      throw new Error(`jobs[${index}].absolute_url não é string`);
    }
    // A ausência de `content` é o sintoma de `content=true` ter sumido da URL.
    if (typeof record?.content !== "string") {
      throw new Error(
        `jobs[${index}].content não é string — a URL perdeu 'content=true'? (recebido: ${typeof record?.content})`,
      );
    }

    const location = record?.location as Record<string, unknown> | undefined;
    if (typeof location !== "object" || location === null || typeof location.name !== "string") {
      throw new Error(`jobs[${index}].location.name ausente ou não é string`);
    }
  }
}
