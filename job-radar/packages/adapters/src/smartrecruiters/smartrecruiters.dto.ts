/**
 * DTOs da API pública de postings do SmartRecruiters, tipados a partir do
 * payload REAL gravado em `fixtures/smartrecruiters/`. Estes tipos não saem
 * deste diretório — o core nunca vê `refNumber` nem `customField`.
 *
 * Endpoint: GET https://api.smartrecruiters.com/v1/companies/{slug}/postings
 *   ?limit={n}&offset={n}
 *
 * O que a sondagem revelou e muda o desenho do adapter:
 *
 * - A LISTA NÃO TRAZ DESCRIÇÃO. Nenhum campo, em nenhum nível. O texto da vaga
 *   só existe em `GET .../postings/{id}`, uma requisição POR VAGA — 4.800 delas
 *   só no `BoschGroup`. Testados `expand=jobAd`, `content=true`, `details=true`,
 *   `includeJobAd=true` e `fields=jobAd`: nenhum muda a resposta. Ver
 *   `toJobPosting` no mapper.
 * - A lista também não traz a URL pública da vaga: `ref` é a URL da API. A URL
 *   de exibição é montada no mapper a partir de (identificador, id).
 * - `totalFound` é HONESTO, ao contrário do `pagination.total` do Gupy. Medido
 *   no `BoschGroup`: `totalFound=4800`, offset 4700 devolve 100 e offset 4800
 *   devolve 0. Ainda assim a paginação não se apoia nele — ver `buildNextTask`.
 * - Slug inexistente responde HTTP 200 com `{"totalFound":0,"content":[]}`,
 *   INDISTINGUÍVEL de empresa real sem vaga aberta. É a armadilha central deste
 *   adapter e está tratada em `SmartRecruitersAdapter.fetch`.
 */

export interface SmartRecruitersLabelledDto {
  readonly id?: string | null;
  readonly label?: string | null;
}

export interface SmartRecruitersCompanyDto {
  /** O slug canônico da empresa na fonte — é ele que vai na URL pública. */
  readonly identifier?: string | null;
  /** Nome de exibição: "Bosch Group", "SmartRecruiters Inc". */
  readonly name?: string | null;
}

/**
 * Geografia da vaga.
 *
 * `remote` e `hybrid` são BOOLEANOS declarados pela fonte — não há texto para
 * adivinhar. `country` vem em ISO-2 MINÚSCULO ("us", "de", "br").
 */
export interface SmartRecruitersLocationDto {
  readonly city?: string | null;
  readonly region?: string | null;
  readonly country?: string | null;
  readonly address?: string | null;
  readonly postalCode?: string | null;
  readonly remote?: boolean;
  readonly hybrid?: boolean;
  readonly hybridDescription?: string | null;
  /** "Londonderry, NH, United States" — mas ver a nota em `buildLocation`. */
  readonly fullLocation?: string | null;
}

export interface SmartRecruitersPostingDto {
  /** Id numérico em string ("744000143115219"). */
  readonly id: string;
  /** O título da vaga. A fonte chama de `name`, não de `title`. */
  readonly name: string;
  readonly uuid?: string | null;
  readonly refNumber?: string | null;
  readonly company?: SmartRecruitersCompanyDto | null;
  /** ISO 8601 com Z. */
  readonly releasedDate?: string | null;
  readonly location?: SmartRecruitersLocationDto | null;
  readonly industry?: SmartRecruitersLabelledDto | null;
  readonly department?: SmartRecruitersLabelledDto | null;
  readonly function?: SmartRecruitersLabelledDto | null;
  /** id: "permanent" | "part-time" | "contract" | "intern" — label é exibição. */
  readonly typeOfEmployment?: SmartRecruitersLabelledDto | null;
  readonly experienceLevel?: SmartRecruitersLabelledDto | null;
  readonly visibility?: string | null;
  /** URL da API para o detalhe desta vaga, NÃO a URL pública. */
  readonly ref?: string | null;
  readonly language?: SmartRecruitersLabelledDto | null;
}

export interface SmartRecruitersPostingsResponseDto {
  readonly offset: number;
  readonly limit: number;
  /** Verificado honesto — mas nada depende dele. Ver `buildNextTask`. */
  readonly totalFound: number;
  readonly content: readonly SmartRecruitersPostingDto[];
}

/**
 * Guarda de contrato. Não é validação de negócio — é a detecção de que a fonte
 * mudou a API. Falhar aqui com mensagem específica é o que transforma "o
 * pipeline degradou em silêncio" em "o parser do SmartRecruiters quebrou no
 * campo X".
 *
 * `totalFound` é exigido mesmo sem ser usado para paginar: ele é o campo que a
 * detecção de board fantasma lê, então perdê-lo em silêncio apagaria a única
 * proteção que este adapter tem contra a armadilha do 200-vazio.
 */
export function assertPostingsResponse(
  value: unknown,
): asserts value is SmartRecruitersPostingsResponseDto {
  if (typeof value !== "object" || value === null) {
    throw new Error("resposta não é um objeto");
  }

  const candidate = value as Record<string, unknown>;

  if (!Array.isArray(candidate.content)) {
    throw new Error(
      `campo 'content' ausente ou não é array (recebido: ${typeof candidate.content})`,
    );
  }

  if (typeof candidate.totalFound !== "number") {
    throw new Error(
      `campo 'totalFound' ausente ou não é número — é ele que detecta board fantasma (recebido: ${typeof candidate.totalFound})`,
    );
  }

  if (typeof candidate.offset !== "number" || typeof candidate.limit !== "number") {
    throw new Error("campos 'offset'/'limit' ausentes ou não numéricos");
  }

  for (const [index, posting] of (candidate.content as unknown[]).entries()) {
    const record = posting as Record<string, unknown>;

    if (typeof record?.id !== "string") {
      throw new Error(`content[${index}].id não é string (recebido: ${typeof record?.id})`);
    }
    if (typeof record?.name !== "string") {
      throw new Error(`content[${index}].name (o título) não é string`);
    }

    const location = record?.location;
    if (location !== undefined && location !== null && typeof location !== "object") {
      throw new Error(`content[${index}].location presente mas não é objeto`);
    }
  }
}
