/**
 * DTOs do job board público do Lever, tipados a partir do payload REAL gravado
 * em `fixtures/lever/`. Estes tipos não saem deste diretório — o core nunca vê
 * `hostedUrl` nem `categories.commitment`.
 *
 * Endpoint: GET https://api.lever.co/v0/postings/{slug}?mode=json&skip=&limit=
 *
 * Duas diferenças de forma em relação às outras fontes deste pacote:
 *
 * - a raiz é um ARRAY, não um objeto com envelope. Não há `total`, `meta` nem
 *   ponteiro de próxima página: quem pagina é `skip`/`limit`, e o único sinal
 *   de fim é a página vir incompleta.
 * - a descrição vem QUEBRADA em seções (`description`, `lists[]`,
 *   `additional`), e não num campo único. Ver `toJobPosting` no mapper.
 *
 * Slug inexistente devolve HTTP 404 `{"ok":false,"error":"Document not found"}`
 * — medido com cinco slugs de lixo distintos. É o que separa "board morto no
 * registro" de "empresa sem vaga aberta", que responde 200 com `[]` (medido em
 * `lever` e `plaid`).
 */

export interface LeverCategoriesDto {
  /** "Full-time", "Contract", "Internship", "Fixed Term", "Apprenticeship"... */
  readonly commitment?: string | null;
  /** Texto livre: "London, United Kingdom", "Seoul, South Korea". */
  readonly location?: string | null;
  readonly team?: string | null;
  readonly department?: string | null;
  readonly allLocations?: readonly string[];
}

/**
 * Uma seção em tópicos da vaga ("Key Responsibilities", "Qualifications").
 *
 * `content` é HTML de `<li>` SEM a `<ul>` em volta — a fonte entrega os itens
 * soltos dentro de uma `<div>`.
 */
export interface LeverListDto {
  readonly text: string;
  readonly content: string;
}

/**
 * Faixa salarial. Só aparece nos boards que ativaram transparência: 49 das 79
 * vagas do `matchgroup`, e NENHUMA das 308 do `palantir`.
 *
 * `min`/`max` vêm em unidade DECIMAL (150000 = US$ 150 mil/ano), ao contrário
 * do Greenhouse, que já publica centavos. A conversão mora no mapper.
 */
export interface LeverSalaryRangeDto {
  readonly min?: number | null;
  readonly max?: number | null;
  /** "USD", "CAD", "AUD" na amostra — nem toda moeda tem suporte em `Money`. */
  readonly currency?: string | null;
  /** "per-year-salary" em 100% da amostra; a fonte documenta outros períodos. */
  readonly interval?: string | null;
}

export interface LeverPostingDto {
  /** UUID em string — diferente do Greenhouse e do Gupy, que usam number. */
  readonly id: string;
  /** O título da vaga. A fonte chama de `text`, não de `title`. */
  readonly text: string;
  readonly categories?: LeverCategoriesDto | null;
  /** ISO 3166-1 alfa-2 JÁ NORMALIZADO ("US", "KR", "JP") — ou "" quando não há. */
  readonly country?: string | null;
  /** "remote" | "hybrid" | "onsite" — enum da fonte, não texto livre. */
  readonly workplaceType?: string | null;
  /** Epoch em MILISSEGUNDOS, não ISO 8601. */
  readonly createdAt?: number | null;
  /** Seção de abertura, em HTML. */
  readonly description?: string | null;
  readonly descriptionPlain?: string | null;
  /** Seções em tópicos, na ordem publicada. */
  readonly lists?: readonly LeverListDto[];
  /** Seção de fechamento, em HTML. */
  readonly additional?: string | null;
  readonly hostedUrl: string;
  readonly applyUrl?: string | null;
  readonly salaryRange?: LeverSalaryRangeDto | null;
}

export type LeverPostingsResponseDto = readonly LeverPostingDto[];

/**
 * Guarda de contrato. Não é validação de negócio — é a detecção de que a fonte
 * mudou a API. Falhar aqui com mensagem específica é o que transforma "o
 * pipeline degradou em silêncio" em "o parser do Lever quebrou no campo X".
 *
 * Só é exigido o que o mapper realmente consome. `categories` e `salaryRange`
 * ficam de fora porque faltam legitimamente em vagas reais — exigi-los
 * derrubaria o board inteiro por um campo opcional.
 */
export function assertPostingsResponse(value: unknown): asserts value is LeverPostingsResponseDto {
  if (!Array.isArray(value)) {
    // O sintoma mais provável é `group=` ter entrado na URL: com ele a raiz
    // vira `[{title, postings:[...]}]` e a resposta continua sendo 200.
    throw new Error(
      `raiz não é array de vagas (recebido: ${value === null ? "null" : typeof value}) — a URL ganhou um parâmetro de agrupamento?`,
    );
  }

  for (const [index, posting] of (value as unknown[]).entries()) {
    const record = posting as Record<string, unknown>;

    if (typeof record?.id !== "string") {
      throw new Error(`[${index}].id não é string (recebido: ${typeof record?.id})`);
    }
    if (typeof record?.text !== "string") {
      throw new Error(`[${index}].text (o título) não é string`);
    }
    if (typeof record?.hostedUrl !== "string") {
      throw new Error(`[${index}].hostedUrl não é string`);
    }
    if (record.lists !== undefined && record.lists !== null && !Array.isArray(record.lists)) {
      throw new Error(`[${index}].lists presente mas não é array`);
    }
  }
}
