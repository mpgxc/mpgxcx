import { JobPosting, type JobPostingProps, Location, RemoteMode, RichText } from "@job-radar/core";
import type { GupyJobDto } from "./gupy.dto.js";

export const GUPY_SOURCE_ID = "gupy";

/** O Gupy publica o país por extenso e em português. */
const COUNTRY_BY_NAME: Readonly<Record<string, string>> = {
  brasil: "BR",
  brazil: "BR",
  méxico: "MX",
  mexico: "MX",
  colômbia: "CO",
  colombia: "CO",
  argentina: "AR",
  chile: "CL",
  peru: "PE",
  perú: "PE",
  uruguai: "UY",
  paraguai: "PY",
  portugal: "PT",
  "estados unidos": "US",
};

/** `workplaceType` é enum da fonte — mapeia direto, sem adivinhar pelo texto. */
const REMOTE_BY_WORKPLACE_TYPE: Readonly<Record<string, RemoteMode>> = {
  remote: RemoteMode.REMOTE,
  hybrid: RemoteMode.HYBRID,
  "on-site": RemoteMode.ONSITE,
  onsite: RemoteMode.ONSITE,
};

const EMPLOYMENT_TYPE_BY_VACANCY: Readonly<Record<string, string>> = {
  vacancy_type_effective: "FULL_TIME",
  vacancy_type_associate: "ASSOCIATE",
  vacancy_type_apprentice: "APPRENTICE",
  vacancy_type_internship: "INTERNSHIP",
  vacancy_type_temporary: "TEMPORARY",
  vacancy_type_talent_pool: "TALENT_POOL",
  vacancy_type_outsource: "OUTSOURCE",
  vacancy_type_summer: "SUMMER",
  vacancy_type_lecturer: "LECTURER",
  vacancy_type_freelancer: "FREELANCER",
};

/**
 * Camada 2 — o Anti-Corruption Layer propriamente dito.
 *
 * Nada de `GupyJobDto` atravessa esta função: o que sai é `JobPosting`, que o
 * resto do sistema entende sem saber que o Gupy existe.
 *
 * Nota sobre salário: o portal do Gupy simplesmente **não expõe faixa
 * salarial** (verificado no payload real). Por isso `compensation` é sempre
 * `null` aqui — inventar um valor seria pior que a ausência.
 */
export function toJobPosting(dto: GupyJobDto, seenAt: Date): JobPosting {
  const props: JobPostingProps = {
    source: {
      id: GUPY_SOURCE_ID,
      externalId: String(dto.id),
      url: dto.jobUrl,
    },
    company: {
      name: dto.careerPageName,
      slug: slugify(dto.careerPageName),
    },
    title: dto.name.trim(),
    // A descrição do Gupy vem em texto puro, não HTML (verificado na fixture).
    description: RichText.fromPlain(dto.description ?? ""),
    location: buildLocation(dto),
    compensation: null,
    employmentType: EMPLOYMENT_TYPE_BY_VACANCY[dto.type] ?? null,
    postedAt: parseDate(dto.publishedDate),
    seenAt,
  };

  return JobPosting.create(props);
}

function buildLocation(dto: GupyJobDto): Location {
  const raw = [dto.city, dto.state, dto.country].filter(Boolean).join(", ");

  const workplace = dto.workplaceType?.toLowerCase() ?? "";
  // `isRemoteWork` é o desempate quando `workplaceType` vem desconhecido.
  const remote =
    REMOTE_BY_WORKPLACE_TYPE[workplace] ??
    (dto.isRemoteWork ? RemoteMode.REMOTE : RemoteMode.UNKNOWN);

  const country = dto.country ? COUNTRY_BY_NAME[dto.country.trim().toLowerCase()] : undefined;

  return Location.fromRaw(raw || (dto.country ?? ""), {
    remote,
    ...(country ? { country } : {}),
  });
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
