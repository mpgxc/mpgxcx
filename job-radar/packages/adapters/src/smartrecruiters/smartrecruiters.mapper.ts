import { JobPosting, type JobPostingProps, Location, RemoteMode, RichText } from "@job-radar/core";
import type {
  SmartRecruitersLocationDto,
  SmartRecruitersPostingDto,
} from "./smartrecruiters.dto.js";

export const SMARTRECRUITERS_SOURCE_ID = "smartrecruiters";

const PUBLIC_JOB_BASE_URL = "https://jobs.smartrecruiters.com";

/** `typeOfEmployment.id` é enum da fonte; `label` é texto de exibição. */
const EMPLOYMENT_TYPE_BY_ID: Readonly<Record<string, string>> = {
  permanent: "FULL_TIME",
  "full-time": "FULL_TIME",
  "part-time": "PART_TIME",
  contract: "CONTRACT",
  contractor: "CONTRACT",
  temporary: "TEMPORARY",
  intern: "INTERNSHIP",
  internship: "INTERNSHIP",
  apprenticeship: "APPRENTICE",
};

/**
 * Camada 2 — o Anti-Corruption Layer propriamente dito.
 *
 * Nada de `SmartRecruitersPostingDto` atravessa esta função: o que sai é
 * `JobPosting`, que o resto do sistema entende sem saber que o SmartRecruiters
 * existe.
 *
 * ATENÇÃO — a vaga sai daqui SEM DESCRIÇÃO, e isso é limitação da fonte, não
 * esquecimento. A lista de postings não publica o texto em campo nenhum; ele só
 * existe em `GET /v1/companies/{slug}/postings/{id}`, uma requisição POR VAGA
 * (4.800 delas no `BoschGroup`). Cinco parâmetros de expansão foram testados
 * contra a API real e nenhum traz o texto na lista.
 *
 * Buscar o detalhe daqui seria errado por dois motivos, e os dois são de
 * desenho, não de esforço: o client é camada de TRANSPORTE, uma requisição por
 * método, e um laço de N+1 dentro do `fetch` estouraria o timeout da Lambda
 * muito antes de terminar um board grande. O lugar certo de enriquecer é um
 * passo próprio, rodando só sobre o delta (`contentHash` novo ou mudado) —
 * exatamente como o enricher com LLM já previsto em `value-objects/seniority`.
 *
 * A consequência imediata está registrada aqui para não virar surpresa:
 * `inferSeniority` e `extractStack` só enxergam o TÍTULO nesta fonte. É pouco,
 * mas é honesto — e é melhor que sintetizar um texto a partir de
 * `department`/`industry`, que encheria o índice de busca de palavras que a
 * vaga nunca disse.
 */
export function toJobPosting(
  dto: SmartRecruitersPostingDto,
  boardSlug: string,
  seenAt: Date,
): JobPosting {
  const identifier = dto.company?.identifier?.trim() || boardSlug;

  const props: JobPostingProps = {
    source: {
      id: SMARTRECRUITERS_SOURCE_ID,
      externalId: dto.id,
      // `ref` é a URL da API, não serve para o candidato. A URL pública é
      // montada a partir de (identificador, id): a fonte redireciona para a
      // versão com o título no caminho, então a forma curta basta e não depende
      // de slugificar o título por conta própria.
      url: `${PUBLIC_JOB_BASE_URL}/${identifier}/${dto.id}`,
    },
    company: {
      // Diferente do Lever e da Ashby, aqui o payload carrega os dois: o nome de
      // exibição e o identificador canônico.
      name: dto.company?.name?.trim() || identifier,
      slug: identifier,
    },
    title: dto.name.trim(),
    description: RichText.fromPlain(""),
    location: buildLocation(dto.location),
    compensation: null,
    employmentType:
      EMPLOYMENT_TYPE_BY_ID[dto.typeOfEmployment?.id?.trim().toLowerCase() ?? ""] ?? null,
    postedAt: parseDate(dto.releasedDate),
    seenAt,
  };

  return JobPosting.create(props);
}

/**
 * `fullLocation` é o texto de exibição que a própria fonte monta, e é ele que
 * vira `raw` — inclusive com as sujeiras que ela produz:
 *
 *   "hosur road bangalore, , India"   (região vazia deixa vírgula órfã)
 *   "Poland, REMOTE, Poland"          (a fonte injeta a MODALIDADE no meio do
 *                                      endereço e repete o país)
 *
 * Preservar o texto original é regra do `Location` ("nunca descarte o texto
 * original: quando a heurística erra, é ele que permite reprocessar"), e as
 * sujeiras são inofensivas aqui porque a modalidade e o país NÃO são inferidos
 * desse texto: os dois vêm de campos declarados. Sem essa passagem explícita,
 * o "REMOTE" plantado dentro do endereço acabaria decidindo a modalidade de uma
 * vaga que a fonte já classificou.
 *
 * A modalidade só é afirmada quando a fonte afirma. `remote` e `hybrid` são
 * booleanos, mas dois booleanos desmarcados continuam sendo dois booleanos
 * desmarcados — o padrão do formulário, não uma declaração de presencial. Nesse
 * caso o VO fica livre para ler o texto, que às vezes traz a modalidade escrita
 * na cidade. É a mesma leitura conservadora do `telecommuting` no Workable.
 */
function buildLocation(location: SmartRecruitersLocationDto | null | undefined): Location {
  const parts = [location?.city, location?.region, location?.country]
    .map((part) => part?.trim())
    .filter(Boolean);

  const raw = location?.fullLocation?.trim() || parts.join(", ");

  // `country` vem em ISO-2 MINÚSCULO ("us", "de", "br") — o VO espera maiúsculo.
  const country = location?.country?.trim().toUpperCase();
  const declaredRemote = location?.hybrid
    ? RemoteMode.HYBRID
    : location?.remote
      ? RemoteMode.REMOTE
      : null;

  return Location.fromRaw(raw, {
    ...(declaredRemote ? { remote: declaredRemote } : {}),
    ...(country && country.length === 2 ? { country } : {}),
  });
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
