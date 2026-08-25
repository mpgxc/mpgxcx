import {
  Compensation,
  JobPosting,
  type JobPostingProps,
  Location,
  Money,
  RichText,
  type SalaryPeriod,
} from "@job-radar/core";
import type { GreenhouseJobDto, GreenhousePayRangeDto } from "./greenhouse.dto.js";

export const GREENHOUSE_SOURCE_ID = "greenhouse";

/**
 * As únicas entidades que o Greenhouse emite em `content`, medidas nas 1.693
 * vagas dos boards sondados: `&lt; &gt; &quot; &amp; &#39;`.
 *
 * A tabela é curta de propósito. Um decoder completo de HTML exigiria a lista
 * inteira do WHATWG (mais de 2.000 nomes) ou uma dependência nova; o que passa
 * por aqui é sempre saída do próprio Greenhouse, não HTML arbitrário.
 */
const ENTITY_REPLACEMENTS: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&#34;": '"',
  "&#38;": "&",
  "&#60;": "<",
  "&#62;": ">",
};

const ENTITY_PATTERN = new RegExp(Object.keys(ENTITY_REPLACEMENTS).join("|"), "g");

/**
 * Desescapa `content` UMA vez só, em passada única.
 *
 * A passada única não é detalhe de performance, é correção: o Greenhouse
 * publica conteúdo DUPLAMENTE escapado quando o texto original já tinha uma
 * entidade — `&amp;lt;`, `&amp;nbsp;`, `&amp;mdash;` (1.373 ocorrências só no
 * board da Figma). Desescapar em sequência, trocando `&amp;` primeiro,
 * transformaria `&amp;lt;` em `<` e injetaria uma tag falsa no HTML. Com
 * `String.replace` global cada trecho é substituído no máximo uma vez, então
 * `&amp;lt;` vira `&lt;` — que é exatamente o que o `RichText` espera receber.
 */
export function decodeHtmlEntities(value: string): string {
  return value.replace(ENTITY_PATTERN, (entity) => ENTITY_REPLACEMENTS[entity] ?? entity);
}

/** Abaixo disto o valor não é salário anual nem mensal — é valor por hora. */
const HOURLY_CEILING_CENTS = 100_000;

const PERIOD_HINTS: ReadonlyArray<readonly [RegExp, SalaryPeriod]> = [
  [/hour|hourly|\/\s*hr\b|hora/i, "HOUR"],
  [/month|monthly|mensal|mês/i, "MONTH"],
  [/annual|annually|year|yearly|anual/i, "YEAR"],
];

/**
 * Camada 2 — o Anti-Corruption Layer propriamente dito.
 *
 * Nada de `GreenhouseJobDto` atravessa esta função: o que sai é `JobPosting`,
 * que o resto do sistema entende sem saber que o Greenhouse existe.
 *
 * O `boardSlug` entra por parâmetro porque `company_name` é texto de exibição
 * ("Vercel") e pode faltar, enquanto o slug do board é a identidade estável da
 * empresa na fonte — é ele que aparece na URL e no registro de fontes.
 */
export function toJobPosting(dto: GreenhouseJobDto, boardSlug: string, seenAt: Date): JobPosting {
  const props: JobPostingProps = {
    source: {
      id: GREENHOUSE_SOURCE_ID,
      externalId: String(dto.id),
      url: dto.absolute_url,
    },
    company: {
      name: dto.company_name?.trim() || boardSlug,
      slug: boardSlug,
    },
    // 134 das 1.398 vagas medidas vêm com espaço sobrando no título.
    title: dto.title.trim(),
    description: RichText.fromHtml(decodeHtmlEntities(dto.content ?? "")),
    // `location.name` é texto livre e o board escreve de tudo: "San Francisco",
    // "Remote - United States", "Hybrid - London, Berlin", "SF, NYC, SEA, CHI".
    // Nenhum parser novo aqui: o `Location` já infere modalidade e país desse
    // texto, pelo mesmo caminho que o Gupy usa. `offices[].location` traria um
    // endereço mais rico, mas vem vazio em 51 das 1.693 vagas medidas — apoiar
    // o mapeamento nele seria trocar um campo sempre presente por um opcional.
    location: Location.fromRaw(dto.location?.name ?? ""),
    compensation: buildCompensation(dto.pay_input_ranges),
    // O endpoint não publica tipo de contrato. `metadata` é campo LIVRE por
    // board: dos boards sondados só o da Dropbox tem "Employment Type", e o
    // valor publicado é "Regular" — que não é taxonomia de contrato nenhuma.
    // Inventar um valor a partir daí seria pior que a ausência.
    employmentType: null,
    postedAt: parseDate(dto.first_published) ?? parseDate(dto.updated_at),
    seenAt,
  };

  return JobPosting.create(props);
}

/**
 * Faixa salarial só existe porque a URL manda `pay_transparency=true` — sem o
 * parâmetro o campo nem aparece. Onde o board não publica, o array vem vazio e
 * o resultado é `null`, como no Gupy.
 */
function buildCompensation(
  ranges: readonly GreenhousePayRangeDto[] | undefined,
): Compensation | null {
  const valid = (ranges ?? []).filter(isUsableRange);
  const [reference] = valid;
  if (!reference) return null;

  const period = inferPeriod(reference);

  // Um board publica uma faixa por zona geográfica ("Zone 1", "US Zone 2").
  // Consolidar em min-dos-mínimos / max-dos-máximos preserva a amplitude real
  // da vaga; misturar moedas ou períodos diferentes produziria faixa mentirosa.
  const comparable = valid.filter(
    (range) =>
      range.currency_type.toUpperCase() === reference.currency_type.toUpperCase() &&
      inferPeriod(range) === period,
  );

  const minCents = Math.min(...comparable.map((range) => range.min_cents));
  const maxCents = Math.max(...comparable.map((range) => range.max_cents));

  return Compensation.create({
    min: Money.fromCents(minCents, reference.currency_type),
    max: Money.fromCents(maxCents, reference.currency_type),
    period,
  });
}

/** Moeda sem suporte em `Money` (PLN aparece na amostra) vira ausência, não erro. */
function isUsableRange(range: GreenhousePayRangeDto): boolean {
  return (
    Number.isSafeInteger(range.min_cents) &&
    Number.isSafeInteger(range.max_cents) &&
    range.min_cents >= 0 &&
    range.max_cents >= range.min_cents &&
    Money.isCurrency(range.currency_type.trim().toUpperCase())
  );
}

/**
 * O período NÃO é um campo da fonte — precisa ser deduzido.
 *
 * O rótulo da zona às vezes entrega ("Annual Base Salary Range:", "Lithuania
 * Gross Monthly Pay Range"), mas as faixas por hora da Robinhood têm rótulo só
 * geográfico ("Zone 1 (Menlo Park, CA; ...)") com min_cents = 1.960, ou seja
 * US$ 19,60. A magnitude resolve o que o rótulo cala: na amostra, o maior
 * valor por hora é 3.450 (US$ 34,50) e a menor faixa anual começa em 5.900.000
 * (US$ 59.000) — nenhuma sobreposição, e o corte fica no meio dessa lacuna.
 */
function inferPeriod(range: GreenhousePayRangeDto): SalaryPeriod {
  const label = range.title ?? "";
  for (const [pattern, period] of PERIOD_HINTS) {
    if (pattern.test(label)) return period;
  }
  return range.min_cents < HOURLY_CEILING_CENTS ? "HOUR" : "YEAR";
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
