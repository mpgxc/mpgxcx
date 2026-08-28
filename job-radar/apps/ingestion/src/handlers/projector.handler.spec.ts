import { PostingStatus } from "@job-radar/core";
import { TABLE_KEYS } from "@job-radar/infra-aws";
import type { Context, DynamoDBStreamEvent } from "aws-lambda";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handler } from "./projector.handler.js";

beforeAll(() => {
  process.env.SEARCH_ENDPOINT ??= "https://exemplo.us-east-1.aoss.amazonaws.com";
});

afterEach(() => {
  vi.restoreAllMocks();
});

const CONTEXT = { awsRequestId: "req-projector" } as Context;
const JOB_KEYS = TABLE_KEYS.job("9f8c1a2b");

function streamOf(...records: unknown[]): DynamoDBStreamEvent {
  return { Records: records } as DynamoDBStreamEvent;
}

/** Item de vaga no formato marshalado do Stream. */
function jobRecord(options: {
  eventName: string;
  oldHash?: string;
  newHash?: string;
  status?: PostingStatus;
  oldStatus?: PostingStatus;
}) {
  return {
    eventName: options.eventName,
    dynamodb: {
      SequenceNumber: "100",
      Keys: { pk: { S: JOB_KEYS.pk }, sk: { S: JOB_KEYS.sk } },
      ...(options.oldHash
        ? {
            OldImage: {
              contentHash: { S: options.oldHash },
              status: { S: options.oldStatus ?? PostingStatus.ACTIVE },
            },
          }
        : {}),
      ...(options.newHash
        ? {
            NewImage: {
              contentHash: { S: options.newHash },
              status: { S: options.status ?? PostingStatus.ACTIVE },
              title: { S: "Staff Software Engineer" },
              sourceId: { S: "greenhouse" },
              lastSeenAt: { S: "2026-08-28T06:00:00.000Z" },
            },
          }
        : {}),
    },
  };
}

describe("projector.handler — filtra o Stream da tabela única", () => {
  it("ignora tudo que não é vaga sem chamar o índice", async () => {
    // O Stream carrega cache de fetch, registro de fontes, placar de rodada e
    // ponteiro de última rodada junto com as vagas. Nenhum deles pode virar
    // documento, e nenhum deles pode custar uma requisição ao cluster.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "log").mockImplementation(() => {});

    const naoVagas = [
      TABLE_KEYS.fetchCache({ sourceId: "gupy", selector: "backend", page: 0 }),
      TABLE_KEYS.sourceConfig("gupy", "backend"),
      TABLE_KEYS.run("2026-08-28T06:00:00-abcd1234"),
      TABLE_KEYS.lastRun("gupy"),
    ].map((keys, position) => ({
      eventName: "MODIFY",
      dynamodb: {
        SequenceNumber: String(position),
        Keys: { pk: { S: keys.pk }, sk: { S: keys.sk } },
        NewImage: { pk: { S: keys.pk }, sk: { S: keys.sk } },
      },
    }));

    const response = await handler(streamOf(...naoVagas), CONTEXT);

    expect(response.batchItemFailures).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignora a vaga cujo conteúdo não mudou — o curto-circuito da rodada diária", async () => {
    // Numa rodada, ~98% das vagas caem aqui. Reindexá-las é exatamente o
    // desperdício que este projeto foi desenhado para não pagar.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await handler(
      streamOf(
        jobRecord({ eventName: "MODIFY", oldHash: "hash-v1", newHash: "hash-v1" }),
        jobRecord({ eventName: "MODIFY", oldHash: "hash-v1", newHash: "hash-v1" }),
      ),
      CONTEXT,
    );

    expect(response.batchItemFailures).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
