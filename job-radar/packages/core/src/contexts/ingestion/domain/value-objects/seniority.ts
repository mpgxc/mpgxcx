export enum Seniority {
  INTERN = "INTERN",
  JUNIOR = "JUNIOR",
  MID = "MID",
  SENIOR = "SENIOR",
  STAFF = "STAFF",
  PRINCIPAL = "PRINCIPAL",
  MANAGER = "MANAGER",
  UNKNOWN = "UNKNOWN",
}

/**
 * Ordem importa: a primeira regra que casar vence. Os níveis mais específicos
 * vêm antes — "senior staff engineer" tem que virar STAFF, não SENIOR, e
 * "estágio" tem que vencer qualquer outro sinal na mesma string.
 */
const RULES: ReadonlyArray<readonly [Seniority, RegExp]> = [
  [Seniority.INTERN, /\b(est[áa]gi|intern(ship)?|traine[e]?|aprendiz)\w*/i],
  [Seniority.PRINCIPAL, /\b(principal|distinguished|fellow)\b/i],
  [Seniority.STAFF, /\b(staff|architect|arquitet[oa])\b/i],
  [Seniority.MANAGER, /\b(manager|gerente|head\s+of|coordenador[a]?|tech\s+lead|l[íi]der)\b/i],
  [Seniority.SENIOR, /\b(s[êe]nior|senior|sr\.?|especialista|expert)\b/i],
  [Seniority.JUNIOR, /\b(j[úu]nior|junior|jr\.?|entry[- ]level)\b/i],
  [Seniority.MID, /\b(pleno|mid[- ]?level|middle|pl\.?)\b/i],
];

/**
 * Extração determinística: versionada, grátis, testável e reproduzível.
 * Um enricher com LLM entra depois atrás de uma porta própria, rodando só
 * sobre o delta (vagas cujo `contentHash` mudou) — o custo escala com volume.
 */
export function inferSeniority(...texts: ReadonlyArray<string | null | undefined>): Seniority {
  const haystack = texts.filter(Boolean).join(" \n ");
  if (!haystack.trim()) return Seniority.UNKNOWN;

  for (const [seniority, pattern] of RULES) {
    if (pattern.test(haystack)) return seniority;
  }
  return Seniority.UNKNOWN;
}
