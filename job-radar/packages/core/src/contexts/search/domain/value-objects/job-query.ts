import type { BusinessError } from "../../../../commons/business-error.js";
import { Result } from "../../../../commons/result.js";
import { RemoteMode } from "../../../ingestion/domain/value-objects/location.js";
import { type Currency, Money } from "../../../ingestion/domain/value-objects/money.js";
import { Seniority } from "../../../ingestion/domain/value-objects/seniority.js";
import { InvalidSearchQuery, SearchWindowExceeded } from "../search.errors.js";

export type SearchSort = "RELEVANCE" | "RECENT" | "SALARY";

const SORTS: readonly SearchSort[] = ["RELEVANCE", "RECENT", "SALARY"];

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/**
 * Teto da janela de resultados: `(page + 1) * size` nunca passa disto.
 *
 * Índice invertido pagina por `from + size`, e cada nó tem que ordenar
 * `from + size` documentos para devolver os últimos `size` — o custo cresce com
 * a PROFUNDIDADE, não com o tamanho da página. Pedir a página 5.000 é um jeito
 * barato de derrubar o cluster de fora.
 *
 * A alternativa correta para varrer tudo é cursor (`search_after`), que não
 * permite pular para uma página arbitrária. Como ninguém navega até a página
 * 50 de vagas — quem chega lá é robô ou é gente que devia ter filtrado —, o
 * desenho recusa a profundidade em vez de sustentá-la, e diz na resposta o que
 * fazer no lugar. É uma recusa explícita, nunca um truncamento silencioso.
 */
export const MAX_RESULT_WINDOW = 1_000;

/** Texto livre longo demais não é busca, é payload. */
const MAX_TEXT_LENGTH = 200;
const MAX_FACET_VALUES = 20;

/** Tags de stack são canônicas e minúsculas; `c++`, `c#` e `.net` estão nelas. */
const STACK_TOKEN = /^[a-z0-9+#._-]{1,40}$/;
/** País vem de `Location`, que trabalha em ISO-3166 alpha-2. */
const COUNTRY_CODE = /^[A-Z]{2}$/;

export interface SalaryFilterInput {
  readonly minCents?: number | null;
  readonly maxCents?: number | null;
  readonly currency?: string | null;
}

export interface SalaryFilter {
  readonly minCents: number | null;
  readonly maxCents: number | null;
  readonly currency: Currency;
}

/**
 * A consulta como chega da borda: já decodificada (listas são listas, números
 * são números), ainda NÃO validada.
 *
 * Os campos numéricos são `number` e não `string` de propósito: decodificar
 * query string é trabalho da borda HTTP, e o domínio não deve saber que
 * `?page=abc` existe. O que a borda produz nesse caso é `NaN`, e `NaN` é
 * justamente um número que este value-object recusa — a validação continua
 * inteira aqui, sem o domínio encostar em HTTP.
 */
export interface JobQueryInput {
  readonly text?: string | null;
  readonly stack?: readonly string[] | null;
  readonly seniority?: readonly string[] | null;
  readonly remote?: readonly string[] | null;
  readonly countries?: readonly string[] | null;
  readonly salary?: SalaryFilterInput | null;
  /** ISO-8601. Recorta por `postedAt`, a data que a fonte publicou. */
  readonly postedAfter?: string | null;
  readonly postedBefore?: string | null;
  /** 0-based, como o resto do projeto. */
  readonly page?: number | null;
  readonly size?: number | null;
  readonly sort?: string | null;
}

/**
 * Consulta de vagas validada.
 *
 * Semântica das facetas, que é o que a maioria dos agregadores erra: dentro de
 * uma faceta os valores são OU (`stack=go,rust` traz vaga de Go OU de Rust),
 * entre facetas é E (`stack=go&remote=REMOTE` traz vaga de Go E remota).
 * Qualquer outra combinação torna a contagem de facetas mentirosa: marcar um
 * segundo valor da MESMA faceta tem que alargar o resultado, nunca estreitar.
 *
 * Note que não existe filtro de status: o índice guarda apenas vaga ativa
 * (ver `ProjectJobChangesUseCase`). "Está no índice" já significa "está viva",
 * e um filtro que só tem um valor possível é ruído na API.
 */
export class JobQuery {
  private constructor(
    readonly text: string | null,
    readonly stack: readonly string[],
    readonly seniority: readonly Seniority[],
    readonly remote: readonly RemoteMode[],
    readonly countries: readonly string[],
    readonly salary: SalaryFilter | null,
    readonly postedAfter: string | null,
    readonly postedBefore: string | null,
    readonly page: number,
    readonly size: number,
    readonly sort: SearchSort,
  ) {}

  static create(input: JobQueryInput = {}): Result<JobQuery, BusinessError> {
    const text = normalizeText(input.text);
    if (text.isErr()) return Result.err(text.error);

    const stack = normalizeTokens("stack", input.stack, (value) => {
      const token = value.trim().toLowerCase();
      return STACK_TOKEN.test(token) ? token : null;
    });
    if (stack.isErr()) return Result.err(stack.error);

    const seniority = normalizeTokens("seniority", input.seniority, (value) =>
      enumValue(Seniority, value),
    );
    if (seniority.isErr()) return Result.err(seniority.error);

    const remote = normalizeTokens("remote", input.remote, (value) => enumValue(RemoteMode, value));
    if (remote.isErr()) return Result.err(remote.error);

    const countries = normalizeTokens("country", input.countries, (value) => {
      const code = value.trim().toUpperCase();
      return COUNTRY_CODE.test(code) ? code : null;
    });
    if (countries.isErr()) return Result.err(countries.error);

    const salary = normalizeSalary(input.salary);
    if (salary.isErr()) return Result.err(salary.error);

    const window = normalizeWindow(input.page, input.size);
    if (window.isErr()) return Result.err(window.error);

    const dates = normalizeDateRange(input.postedAfter, input.postedBefore);
    if (dates.isErr()) return Result.err(dates.error);

    const sort = normalizeSort(input.sort, text.value !== null);
    if (sort.isErr()) return Result.err(sort.error);

    return Result.ok(
      new JobQuery(
        text.value,
        stack.value,
        seniority.value,
        remote.value,
        countries.value,
        salary.value,
        dates.value.after,
        dates.value.before,
        window.value.page,
        window.value.size,
        sort.value,
      ),
    );
  }

  /** Deslocamento no índice. Já provado dentro da janela por `create`. */
  get offset(): number {
    return this.page * this.size;
  }

  /** True quando nenhuma faceta e nenhum texto estreitam o catálogo. */
  get isEmpty(): boolean {
    return (
      this.text === null &&
      this.stack.length === 0 &&
      this.seniority.length === 0 &&
      this.remote.length === 0 &&
      this.countries.length === 0 &&
      this.salary === null &&
      this.postedAfter === null &&
      this.postedBefore === null
    );
  }
}

function normalizeText(raw: string | null | undefined): Result<string | null, BusinessError> {
  const text = (raw ?? "").trim();
  if (!text) return Result.ok(null);

  if (text.length > MAX_TEXT_LENGTH) {
    return Result.err(
      InvalidSearchQuery.create(
        "q",
        `texto com ${text.length} caracteres; o máximo é ${MAX_TEXT_LENGTH}`,
      ),
    );
  }

  return Result.ok(text);
}

/**
 * Facetas são multivaloradas e a ordem não importa, então o resultado é
 * deduplicado e ordenado: duas consultas equivalentes viram a MESMA consulta,
 * o que é o que permite cachear pela chave da consulta mais adiante.
 */
function normalizeTokens<T extends string>(
  field: string,
  raw: readonly string[] | null | undefined,
  parse: (value: string) => T | null,
): Result<readonly T[], BusinessError> {
  if (!raw || raw.length === 0) return Result.ok([]);

  if (raw.length > MAX_FACET_VALUES) {
    return Result.err(
      InvalidSearchQuery.create(field, `${raw.length} valores; o máximo é ${MAX_FACET_VALUES}`),
    );
  }

  const parsed: T[] = [];
  for (const value of raw) {
    const token = parse(value);
    if (token === null) {
      return Result.err(InvalidSearchQuery.create(field, `valor não reconhecido: '${value}'`));
    }
    parsed.push(token);
  }

  return Result.ok([...new Set(parsed)].sort());
}

function enumValue<T extends Record<string, string>>(
  enumeration: T,
  value: string,
): T[keyof T] | null {
  const candidate = value.trim().toUpperCase();
  const known = Object.values(enumeration) as string[];
  return known.includes(candidate) ? (candidate as T[keyof T]) : null;
}

/**
 * A moeda é obrigatória quando existe qualquer limite.
 *
 * Sem ela o filtro compara centavos com centavos e devolve vaga de 8.000 BRL
 * junto com vaga de 8.000 USD como se fossem a mesma faixa. Converter no
 * servidor exigiria taxa de câmbio — dado vivo, que envelhece, e que este
 * sistema não tem nenhuma razão para manter. Exigir a moeda transfere a
 * escolha para quem consulta, que é quem sabe qual mercado está olhando.
 */
function normalizeSalary(
  raw: SalaryFilterInput | null | undefined,
): Result<SalaryFilter | null, BusinessError> {
  const min = raw?.minCents ?? null;
  const max = raw?.maxCents ?? null;
  const currency = raw?.currency?.trim().toUpperCase() ?? "";

  if (min === null && max === null) {
    return currency
      ? Result.err(
          InvalidSearchQuery.create(
            "salaryCurrency",
            "moeda informada sem nenhum limite de faixa; use salaryMin e/ou salaryMax",
          ),
        )
      : Result.ok(null);
  }

  for (const [field, bound] of [
    ["salaryMin", min],
    ["salaryMax", max],
  ] as const) {
    if (bound === null) continue;
    if (!Number.isSafeInteger(bound) || bound < 0) {
      return Result.err(
        InvalidSearchQuery.create(field, `esperado inteiro em centavos >= 0, recebido '${bound}'`),
      );
    }
  }

  if (min !== null && max !== null && min > max) {
    return Result.err(
      InvalidSearchQuery.create("salaryMin", "limite inferior maior que o superior"),
    );
  }

  if (!Money.isCurrency(currency)) {
    return Result.err(
      InvalidSearchQuery.create(
        "salaryCurrency",
        currency
          ? `moeda '${currency}' não suportada`
          : "faixa salarial exige moeda; comparar centavos entre moedas diferentes não significa nada",
      ),
    );
  }

  return Result.ok({ minCents: min, maxCents: max, currency });
}

function normalizeDateRange(
  rawAfter: string | null | undefined,
  rawBefore: string | null | undefined,
): Result<{ after: string | null; before: string | null }, BusinessError> {
  const after = parseInstant("postedAfter", rawAfter);
  if (after.isErr()) return Result.err(after.error);

  const before = parseInstant("postedBefore", rawBefore);
  if (before.isErr()) return Result.err(before.error);

  if (after.value && before.value && after.value > before.value) {
    return Result.err(
      InvalidSearchQuery.create("postedAfter", "início do intervalo posterior ao fim"),
    );
  }

  return Result.ok({ after: after.value, before: before.value });
}

/** Normaliza para ISO com fuso explícito — data sem fuso é ambígua em 24h. */
function parseInstant(
  field: string,
  raw: string | null | undefined,
): Result<string | null, BusinessError> {
  const value = (raw ?? "").trim();
  if (!value) return Result.ok(null);

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return Result.err(InvalidSearchQuery.create(field, `data ISO-8601 inválida: '${value}'`));
  }

  return Result.ok(parsed.toISOString());
}

function normalizeWindow(
  rawPage: number | null | undefined,
  rawSize: number | null | undefined,
): Result<{ page: number; size: number }, BusinessError> {
  const page = rawPage ?? 0;
  const size = rawSize ?? DEFAULT_PAGE_SIZE;

  if (!Number.isSafeInteger(page) || page < 0) {
    return Result.err(
      InvalidSearchQuery.create("page", `esperado inteiro >= 0, recebido '${page}'`),
    );
  }

  if (!Number.isSafeInteger(size) || size < 1) {
    return Result.err(
      InvalidSearchQuery.create("size", `esperado inteiro >= 1, recebido '${size}'`),
    );
  }

  // Teto de página recusa em vez de truncar: devolver 20 quando pediram 500 é
  // mentir sobre o contrato e some com a página seguinte para quem pagina.
  if (size > MAX_PAGE_SIZE) {
    return Result.err(
      InvalidSearchQuery.create("size", `${size} itens por página; o máximo é ${MAX_PAGE_SIZE}`),
    );
  }

  const lastResult = (page + 1) * size;
  if (lastResult > MAX_RESULT_WINDOW) {
    return Result.err(SearchWindowExceeded.create(lastResult, MAX_RESULT_WINDOW));
  }

  return Result.ok({ page, size });
}

/**
 * Sem texto, o padrão é `RECENT` e não `RELEVANCE`: relevância de um `match_all`
 * dá a mesma pontuação para todo documento, e o que sai é uma ordem arbitrária
 * e instável entre requisições — a pior experiência possível para quem pagina.
 */
function normalizeSort(
  raw: string | null | undefined,
  hasText: boolean,
): Result<SearchSort, BusinessError> {
  const value = (raw ?? "").trim().toUpperCase();
  if (!value) return Result.ok(hasText ? "RELEVANCE" : "RECENT");

  if (!(SORTS as readonly string[]).includes(value)) {
    return Result.err(
      InvalidSearchQuery.create("sort", `valor não reconhecido: '${raw}'; use ${SORTS.join(", ")}`),
    );
  }

  if (value === "RELEVANCE" && !hasText) {
    return Result.err(
      InvalidSearchQuery.create(
        "sort",
        "ordenar por relevância exige texto de busca; sem ele todos os documentos empatam",
      ),
    );
  }

  return Result.ok(value as SearchSort);
}
