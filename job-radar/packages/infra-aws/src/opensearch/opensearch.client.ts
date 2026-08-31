import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

/**
 * Falha de transporte contra o índice. `status === null` significa que não
 * houve resposta — timeout, DNS, socket —, a mesma convenção do
 * `SourceHttpError` dos adapters de fonte.
 */
export class OpenSearchHttpError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = "OpenSearchHttpError";
  }
}

export interface OpenSearchClientOptions {
  /** Endpoint da coleção, com esquema: `https://abc123.us-east-1.aoss.amazonaws.com`. */
  readonly endpoint: string;
  readonly region: string;
  /**
   * Nome do serviço na assinatura SigV4. `aoss` para OpenSearch Serverless,
   * `es` para um domínio gerenciado. Errar isto devolve 403 sem explicação —
   * é a pegadinha número um de quem assina requisição para o OpenSearch na mão.
   */
  readonly service?: "aoss" | "es";
  readonly timeoutMs?: number;
  /** Injetável para teste; em Lambda o provider padrão lê a role da execução. */
  readonly credentials?: SignerCredentials;
}

export interface OpenSearchResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Derivado do próprio assinador em vez de importado de `@smithy/types`: o
 * pacote de tipos é dependência transitiva do SDK, e depender dele
 * explicitamente amarraria este arquivo a uma versão que ninguém declara.
 */
type SignerCredentials = ConstructorParameters<typeof SignatureV4>[0]["credentials"];

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Camada 1 — só transporte assinado.
 *
 * Não conhece `IndexedJob`, `JobQuery` nem `BusinessError`: recebe caminho e
 * corpo, devolve JSON ou lança `OpenSearchHttpError`. A tradução para domínio
 * acontece na camada 2, como em toda fonte deste projeto.
 *
 * Não usamos `@opensearch-project/opensearch`: a única coisa que o cliente
 * oficial resolve aqui é assinar SigV4 e serializar JSON — trinta linhas —,
 * e em troca ele entra no bundle da Lambda inteiro, com transporte, pool de
 * conexões e sniffing que não fazem sentido contra um endpoint serverless.
 */
export class OpenSearchClient {
  private readonly signer: SignatureV4;
  private readonly url: URL;
  private readonly timeoutMs: number;

  constructor(options: OpenSearchClientOptions) {
    this.url = new URL(options.endpoint);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.signer = new SignatureV4({
      credentials: options.credentials ?? defaultProvider(),
      region: options.region,
      service: options.service ?? "aoss",
      sha256: Sha256,
    });
  }

  async request(method: string, path: string, body?: string): Promise<OpenSearchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        host: this.url.hostname,
        // NDJSON do `_bulk` e JSON do `_search` compartilham o mesmo cliente;
        // quem chama já monta o corpo no formato certo do endpoint.
        "content-type": body?.endsWith("\n") ? "application/x-ndjson" : "application/json",
      };

      const signed = await this.signer.sign(
        new HttpRequest({
          method,
          protocol: this.url.protocol,
          hostname: this.url.hostname,
          path,
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      );

      const response = await fetch(new URL(path, this.url).toString(), {
        method,
        headers: signed.headers as Record<string, string>,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        throw new OpenSearchHttpError(
          response.status,
          `HTTP ${response.status} em ${method} ${path}`,
          text.slice(0, 500),
        );
      }

      return { status: response.status, body: text ? JSON.parse(text) : null };
    } catch (error) {
      if (error instanceof OpenSearchHttpError) throw error;

      const isAbort = error instanceof Error && error.name === "AbortError";
      throw new OpenSearchHttpError(
        null,
        isAbort
          ? `Timeout de ${this.timeoutMs}ms em ${method} ${path}`
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
