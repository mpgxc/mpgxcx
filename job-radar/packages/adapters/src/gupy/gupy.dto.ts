/**
 * DTOs do portal Gupy, tipados a partir do payload REAL gravado em
 * `fixtures/gupy/`. Estes tipos não saem deste diretório — o core nunca vê
 * `careerPageName` nem `workplaceType`.
 *
 * Endpoint: GET https://employability-portal.gupy.io/api/v1/jobs
 *   ?jobName={termo}&offset={n}&limit={n}
 *
 * Armadilha validada: o parâmetro de busca é `jobName` (ou `term`). Mandar
 * `name=` devolve HTTP 400 {"message":"Bad Request","statusCode":400}.
 */

export interface GupyJobDto {
  readonly id: number;
  readonly name: string;
  readonly companyId: number;
  readonly careerPageId: number;
  readonly careerPageName: string;
  readonly careerPageUrl: string;
  readonly careerPageLogo: string | null;
  readonly jobUrl: string;
  readonly description: string;
  /** "vacancy_type_effective" | "vacancy_type_associate" | ... */
  readonly type: string;
  /** "remote" | "hybrid" | "on-site" — mapeia direto para RemoteMode. */
  readonly workplaceType: string;
  readonly city: string | null;
  readonly state: string | null;
  /** Nome do país em português: "Brasil", "México", "Colômbia". */
  readonly country: string | null;
  readonly isRemoteWork: boolean;
  readonly publishedDate: string;
  readonly applicationDeadline: string | null;
  readonly disabilities: boolean;
  readonly skills: readonly string[];
}

export interface GupyPaginationDto {
  /**
   * NÃO é o total de resultados — o valor é grampeado dependendo do `limit`
   * (com limit=10 devolve o total real, com limit>=50 devolve 100). Está aqui
   * porque a fonte manda, mas a paginação NÃO se apoia nele. Ver
   * `GupyAdapter.buildNextTask`.
   */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface GupyJobsResponseDto {
  readonly data: readonly GupyJobDto[];
  readonly pagination: GupyPaginationDto;
}

/**
 * Guarda de contrato. Não é validação de negócio — é a detecção de que a fonte
 * mudou a API. Falhar aqui com mensagem específica é o que transforma "o
 * pipeline degradou em silêncio" em "o parser do Gupy quebrou no campo X".
 */
export function assertJobsResponse(value: unknown): asserts value is GupyJobsResponseDto {
  if (typeof value !== "object" || value === null) {
    throw new Error("resposta não é um objeto");
  }

  const candidate = value as Record<string, unknown>;

  if (!Array.isArray(candidate.data)) {
    throw new Error(`campo 'data' ausente ou não é array (recebido: ${typeof candidate.data})`);
  }

  const pagination = candidate.pagination as Record<string, unknown> | undefined;
  if (
    typeof pagination !== "object" ||
    pagination === null ||
    typeof pagination.total !== "number" ||
    typeof pagination.offset !== "number" ||
    typeof pagination.limit !== "number"
  ) {
    throw new Error("campo 'pagination' ausente ou sem total/offset/limit numéricos");
  }

  for (const [index, job] of (candidate.data as unknown[]).entries()) {
    const record = job as Record<string, unknown>;
    if (typeof record?.id !== "number") throw new Error(`data[${index}].id não é number`);
    if (typeof record?.name !== "string") throw new Error(`data[${index}].name não é string`);
    if (typeof record?.jobUrl !== "string") throw new Error(`data[${index}].jobUrl não é string`);
    if (typeof record?.careerPageName !== "string") {
      throw new Error(`data[${index}].careerPageName não é string`);
    }
  }
}
