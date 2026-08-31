import { PostingStatus, RemoteMode, Seniority } from "@job-radar/core";
import { describe, expect, it } from "vitest";
import { decodeJobStreamRecord, type StreamImage, toJobStreamRecord } from "./job-stream.js";
import { TABLE_KEYS } from "./single-table.js";

const JOB_ID = "9f8c1a2b3c4d5e6f";
const KEYS = TABLE_KEYS.job(JOB_ID);

/** Uma imagem como o `DynamoJobRepository.upsert` grava, já desmarshalada. */
function jobImage(overrides: Partial<Record<string, unknown>> = {}): StreamImage {
  return {
    pk: KEYS.pk,
    sk: KEYS.sk,
    entity: "JOB",
    gsi1pk: TABLE_KEYS.jobsBySource("greenhouse", PostingStatus.ACTIVE),
    gsi1sk: "2026-08-28T06:00:00.000Z",
    contentHash: "hash-v1",
    fingerprint: "fp-1",
    status: PostingStatus.ACTIVE,
    sourceId: "greenhouse",
    externalId: "4242",
    url: "https://boards.greenhouse.io/acme/jobs/4242",
    companyName: "Acme",
    companySlug: "acme",
    title: "Staff Software Engineer",
    descriptionText: "Go, Kubernetes, Terraform.",
    descriptionHtml: "<p>Go, Kubernetes, Terraform.</p>",
    locationRaw: "Remote - Brazil",
    remoteMode: RemoteMode.REMOTE,
    country: "BR",
    city: null,
    seniority: Seniority.STAFF,
    stack: ["go", "kubernetes", "terraform"],
    employmentType: "FULL_TIME",
    compensation: { minCents: 2_000_000, maxCents: 3_000_000, currency: "BRL", period: "MONTH" },
    postedAt: "2026-08-20T12:00:00.000Z",
    lastSeenAt: "2026-08-28T06:00:00.000Z",
    lastRunId: "2026-08-28T06:00:00-abcd1234",
    firstSeenAt: "2026-08-01T06:00:00.000Z",
    ...overrides,
  };
}

describe("decodeJobStreamRecord — o curto-circuito de contentHash", () => {
  it("IGNORA a vaga cujo conteúdo não mudou", () => {
    // Este é o teste que justifica o projetor existir. O `upsert` grava em
    // TODA rodada para carimbar `lastSeenAt`, então o Stream dispara para o
    // catálogo inteiro todo dia — e ~98% desses eventos não mudaram nada.
    const decision = decodeJobStreamRecord({
      eventName: "MODIFY",
      keys: KEYS,
      oldImage: jobImage({ lastSeenAt: "2026-08-27T06:00:00.000Z" }),
      newImage: jobImage(),
    });

    expect(decision).toEqual({ kind: "ignore", reason: "conteudo-inalterado" });
  });

  it("PROJETA quando o contentHash mudou", () => {
    const decision = decodeJobStreamRecord({
      eventName: "MODIFY",
      keys: KEYS,
      oldImage: jobImage({ contentHash: "hash-v0" }),
      newImage: jobImage({ contentHash: "hash-v1", title: "Principal Software Engineer" }),
    });

    expect(decision.kind).toBe("project");
    if (decision.kind !== "project" || decision.change.kind !== "upserted") return;
    expect(decision.change.job.props.title).toBe("Principal Software Engineer");
  });

  it("PROJETA a vaga nova (INSERT não tem imagem antiga)", () => {
    const decision = decodeJobStreamRecord({
      eventName: "INSERT",
      keys: KEYS,
      newImage: jobImage(),
    });

    expect(decision.kind).toBe("project");
    if (decision.kind === "project") expect(decision.change.kind).toBe("upserted");
  });
});

describe("decodeJobStreamRecord — expiração", () => {
  it("PROJETA a transição para EXPIRED mesmo com o contentHash IGUAL", () => {
    // A armadilha: `expireNotSeenIn` escreve só `status`, `gsi1pk` e
    // `expiredAt` — não toca no `contentHash`. Se o curto-circuito viesse
    // antes da checagem de status, toda expiração seria classificada como
    // "conteúdo inalterado" e a vaga morta ficaria no índice para sempre.
    const decision = decodeJobStreamRecord({
      eventName: "MODIFY",
      keys: KEYS,
      oldImage: jobImage(),
      newImage: jobImage({
        status: PostingStatus.EXPIRED,
        expiredAt: "2026-08-28T10:00:00.000Z",
      }),
    });

    expect(decision.kind).toBe("project");
    if (decision.kind !== "project" || decision.change.kind !== "upserted") return;
    // Quem decide remover é o use-case; aqui o fato é só "o status mudou".
    expect(decision.change.job.status).toBe(PostingStatus.EXPIRED);
  });

  it("PROJETA a reativação de EXPIRED para ACTIVE", () => {
    const decision = decodeJobStreamRecord({
      eventName: "MODIFY",
      keys: KEYS,
      oldImage: jobImage({ status: PostingStatus.EXPIRED }),
      newImage: jobImage({ status: PostingStatus.ACTIVE }),
    });

    expect(decision.kind).toBe("project");
    if (decision.kind !== "project" || decision.change.kind !== "upserted") return;
    expect(decision.change.job.status).toBe(PostingStatus.ACTIVE);
  });

  it("REMOVE tira a vaga do índice usando só as chaves", () => {
    const decision = decodeJobStreamRecord({ eventName: "REMOVE", keys: KEYS });

    expect(decision).toEqual({ kind: "project", change: { kind: "removed", jobId: JOB_ID } });
  });
});

describe("decodeJobStreamRecord — o Stream é da tabela ÚNICA", () => {
  const naoVagas: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["cache de fetch", TABLE_KEYS.fetchCache({ sourceId: "gupy", selector: "backend", page: 0 })],
    ["registro de fontes", TABLE_KEYS.sourceConfig("gupy", "backend")],
    ["placar da rodada", TABLE_KEYS.run("2026-08-28T06:00:00-abcd1234")],
    ["ponteiro de última rodada", TABLE_KEYS.lastRun("gupy")],
  ];

  for (const [label, keys] of naoVagas) {
    it(`ignora ${label}`, () => {
      const decision = decodeJobStreamRecord({
        eventName: "MODIFY",
        keys,
        newImage: { ...keys, entity: "OUTRA_COISA" },
      });

      expect(decision).toEqual({ kind: "ignore", reason: "nao-e-vaga" });
    });
  }

  it("ignora item com pk de vaga mas sk de outra entidade", () => {
    // Erra para o lado de ignorar: chave que não casa EXATAMENTE com o layout
    // de vaga não é vaga, mesmo parecendo.
    const decision = decodeJobStreamRecord({
      eventName: "INSERT",
      keys: { pk: KEYS.pk, sk: "ANEXO" },
      newImage: jobImage({ sk: "ANEXO" }),
    });

    expect(decision).toEqual({ kind: "ignore", reason: "nao-e-vaga" });
  });

  it("ignora evento sem chaves nenhuma", () => {
    expect(decodeJobStreamRecord({ eventName: "MODIFY" })).toEqual({
      kind: "ignore",
      reason: "nao-e-vaga",
    });
  });

  it("ignora vaga com imagem incompleta em vez de derrubar o batch", () => {
    // Linha torta (script manual, versão antiga do repositório) não pode
    // parar a projeção das outras 99 do batch.
    const decision = decodeJobStreamRecord({
      eventName: "INSERT",
      keys: KEYS,
      newImage: { pk: KEYS.pk, sk: KEYS.sk, entity: "JOB" },
    });

    expect(decision).toEqual({ kind: "ignore", reason: "imagem-inutilizavel" });
  });
});

describe("toIndexedJob — o que vai para o índice", () => {
  it("achata a imagem no documento de busca", () => {
    const decision = decodeJobStreamRecord({
      eventName: "INSERT",
      keys: KEYS,
      newImage: jobImage(),
    });

    if (decision.kind !== "project" || decision.change.kind !== "upserted") {
      throw new Error("esperava projeção");
    }

    expect(decision.change.job.props).toMatchObject({
      id: JOB_ID,
      contentHash: "hash-v1",
      status: PostingStatus.ACTIVE,
      sourceId: "greenhouse",
      companySlug: "acme",
      description: "Go, Kubernetes, Terraform.",
      remote: RemoteMode.REMOTE,
      country: "BR",
      seniority: Seniority.STAFF,
      stack: ["go", "kubernetes", "terraform"],
      salary: { minCents: 2_000_000, maxCents: 3_000_000, currency: "BRL", period: "MONTH" },
    });
  });

  it("descarta faixa salarial com moeda desconhecida", () => {
    // Centavos sem unidade não são comparáveis; indexar mentiria no filtro.
    const decision = decodeJobStreamRecord({
      eventName: "INSERT",
      keys: KEYS,
      newImage: jobImage({
        compensation: { minCents: 100, maxCents: 200, currency: "JPY", period: "MONTH" },
      }),
    });

    if (decision.kind !== "project" || decision.change.kind !== "upserted") {
      throw new Error("esperava projeção");
    }
    expect(decision.change.job.props.salary).toBeNull();
  });

  it("cai para UNKNOWN em enum que o índice não reconhece, sem descartar a vaga", () => {
    const decision = decodeJobStreamRecord({
      eventName: "INSERT",
      keys: KEYS,
      newImage: jobImage({ remoteMode: "TELEPORTE", seniority: "ARQUIMAGO" }),
    });

    if (decision.kind !== "project" || decision.change.kind !== "upserted") {
      throw new Error("esperava projeção");
    }
    expect(decision.change.job.props.remote).toBe(RemoteMode.UNKNOWN);
    expect(decision.change.job.props.seniority).toBe(Seniority.UNKNOWN);
  });
});

describe("toJobStreamRecord — desmarshalar o formato do Stream", () => {
  it("converte os atributos marshalados em objeto plano", () => {
    const record = toJobStreamRecord({
      eventName: "MODIFY",
      dynamodb: {
        Keys: { pk: { S: KEYS.pk }, sk: { S: KEYS.sk } },
        OldImage: { contentHash: { S: "hash-v0" }, status: { S: "ACTIVE" } },
        NewImage: {
          contentHash: { S: "hash-v1" },
          status: { S: "ACTIVE" },
          title: { S: "Staff Software Engineer" },
          sourceId: { S: "greenhouse" },
          stack: { L: [{ S: "go" }] },
        },
      },
    });

    expect(record.keys).toEqual({ pk: KEYS.pk, sk: KEYS.sk });
    expect(record.oldImage?.contentHash).toBe("hash-v0");
    expect(record.newImage?.stack).toEqual(["go"]);

    const decision = decodeJobStreamRecord(record);
    expect(decision.kind).toBe("project");
  });
});
