/**
 * Dicionário de stack. Cada entrada é `[tag canônica, padrões]`.
 *
 * Os padrões são casados com fronteira de palavra construída na mão porque
 * `\b` não funciona com `c++`, `c#`, `.net` e `node.js` — os caracteres finais
 * não são word chars, então `\b` nunca fecha. Esse detalhe é justamente o que
 * quebra silenciosamente a maioria dos extratores caseiros.
 */
const DICTIONARY: ReadonlyArray<readonly [tag: string, patterns: readonly string[]]> = [
  ["typescript", ["typescript", "ts"]],
  ["javascript", ["javascript", "js", "ecmascript"]],
  ["node", ["node.js", "nodejs", "node"]],
  ["react", ["react.js", "reactjs", "react"]],
  ["nextjs", ["next.js", "nextjs"]],
  ["vue", ["vue.js", "vuejs", "vue"]],
  ["angular", ["angular"]],
  ["python", ["python"]],
  ["django", ["django"]],
  ["fastapi", ["fastapi"]],
  ["java", ["java"]],
  ["kotlin", ["kotlin"]],
  ["spring", ["spring boot", "spring"]],
  ["go", ["golang", "go"]],
  ["rust", ["rust"]],
  ["ruby", ["ruby on rails", "rails", "ruby"]],
  ["php", ["php", "laravel"]],
  ["csharp", ["c#", "csharp", ".net", "dotnet"]],
  ["cpp", ["c++", "cpp"]],
  ["elixir", ["elixir", "phoenix"]],
  ["scala", ["scala"]],
  ["swift", ["swift"]],
  ["postgres", ["postgresql", "postgres"]],
  ["mysql", ["mysql", "mariadb"]],
  ["mongodb", ["mongodb", "mongo"]],
  ["redis", ["redis"]],
  ["dynamodb", ["dynamodb"]],
  ["elasticsearch", ["elasticsearch", "opensearch"]],
  ["kafka", ["kafka"]],
  ["rabbitmq", ["rabbitmq"]],
  ["graphql", ["graphql"]],
  ["grpc", ["grpc"]],
  ["aws", ["aws", "amazon web services"]],
  ["gcp", ["gcp", "google cloud"]],
  ["azure", ["azure"]],
  ["docker", ["docker"]],
  ["kubernetes", ["kubernetes", "k8s"]],
  ["terraform", ["terraform"]],
  ["serverless", ["serverless", "lambda"]],
  ["nestjs", ["nest.js", "nestjs"]],
  ["flutter", ["flutter"]],
  ["android", ["android"]],
  ["ios", ["ios"]],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fronteira própria: exige que o termo não seja precedido nem seguido por
 * letra/dígito. Assim `go` não casa dentro de "google" nem de "django", e
 * `c++` continua casando apesar do `+`.
 */
const BOUNDARY_BEFORE = "(?<![a-z0-9+#.])";
const BOUNDARY_AFTER = "(?![a-z0-9+#])";

const COMPILED: ReadonlyArray<readonly [string, RegExp]> = DICTIONARY.map(([tag, patterns]) => {
  const alternation = patterns.map(escapeRegExp).join("|");
  return [tag, new RegExp(`${BOUNDARY_BEFORE}(?:${alternation})${BOUNDARY_AFTER}`, "i")] as const;
});

/** Tags canônicas ordenadas — determinístico, então o `contentHash` é estável. */
export function extractStack(...texts: ReadonlyArray<string | null | undefined>): string[] {
  const haystack = texts.filter(Boolean).join(" \n ").toLowerCase();
  if (!haystack.trim()) return [];

  const found = COMPILED.filter(([, pattern]) => pattern.test(haystack)).map(([tag]) => tag);
  return [...new Set(found)].sort();
}
