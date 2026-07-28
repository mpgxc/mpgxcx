/**
 * Como o trabalho acontece no espaço. Deriva do texto livre da vaga, então
 * `UNKNOWN` é um estado legítimo — fingir certeza aqui polui a busca.
 */
export enum RemoteMode {
  ONSITE = "ONSITE",
  HYBRID = "HYBRID",
  REMOTE = "REMOTE",
  UNKNOWN = "UNKNOWN",
}

const REMOTE_HINTS = [
  "remoto",
  "remota",
  "100% remoto",
  "trabalho remoto",
  "anywhere",
  "remote",
  "work from home",
  "home office",
  "homeoffice",
  "teletrabalho",
] as const;

const HYBRID_HINTS = ["híbrido", "hibrido", "hybrid", "semipresencial", "semi-presencial"] as const;

const ONSITE_HINTS = ["presencial", "on-site", "onsite", "in office", "in-office"] as const;

/** Sinônimos de país que aparecem no texto livre das fontes. */
const COUNTRY_HINTS: ReadonlyArray<readonly [code: string, patterns: readonly string[]]> = [
  ["BR", ["brasil", "brazil", " br ", "(br)"]],
  ["US", ["united states", "usa", " us ", "(us)", "estados unidos"]],
  ["PT", ["portugal"]],
  ["CA", ["canada", "canadá"]],
  ["GB", ["united kingdom", "reino unido", " uk ", "(uk)"]],
  ["DE", ["germany", "alemanha", "deutschland"]],
  ["ES", ["spain", "espanha", "españa"]],
];

export class Location {
  private constructor(
    readonly raw: string,
    readonly remote: RemoteMode,
    readonly country: string | null,
    readonly city: string | null,
  ) {}

  /**
   * `raw` é sempre preservado. Nunca descarte o texto original: quando a
   * heurística erra, é ele que permite reprocessar sem re-raspar a fonte.
   */
  static fromRaw(raw: string, hints: { remote?: RemoteMode; country?: string } = {}): Location {
    const text = raw.trim();
    const haystack = ` ${text.toLowerCase()} `;

    const remote = hints.remote ?? Location.inferRemote(haystack);
    const country = hints.country?.toUpperCase() ?? Location.inferCountry(haystack);
    const city = Location.inferCity(text);

    return new Location(text, remote, country, city);
  }

  private static inferRemote(haystack: string): RemoteMode {
    // Híbrido primeiro: "híbrido - remoto 3x" contém ambos os sinais e não é remoto.
    if (HYBRID_HINTS.some((hint) => haystack.includes(hint))) return RemoteMode.HYBRID;
    if (REMOTE_HINTS.some((hint) => haystack.includes(hint))) return RemoteMode.REMOTE;
    if (ONSITE_HINTS.some((hint) => haystack.includes(hint))) return RemoteMode.ONSITE;
    return RemoteMode.UNKNOWN;
  }

  private static inferCountry(haystack: string): string | null {
    for (const [code, patterns] of COUNTRY_HINTS) {
      if (patterns.some((pattern) => haystack.includes(pattern))) return code;
    }
    return null;
  }

  private static inferCity(text: string): string | null {
    // Convenção quase universal nos boards: "Cidade, Estado" ou "Cidade - Estado".
    const [head] = text.split(/[,\-–|]/);
    const candidate = head?.trim() ?? "";
    if (candidate.length < 2 || candidate.length > 60) return null;

    const lowered = ` ${candidate.toLowerCase()} `;
    const isModeWord = [...REMOTE_HINTS, ...HYBRID_HINTS, ...ONSITE_HINTS].some((hint) =>
      lowered.includes(hint),
    );
    return isModeWord ? null : candidate;
  }

  get isRemote(): boolean {
    return this.remote === RemoteMode.REMOTE;
  }
}
