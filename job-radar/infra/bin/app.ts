#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { IngestionStack } from "../lib/ingestion-stack.js";
import { SearchStack } from "../lib/search-stack.js";

const app = new App();
const stage = app.node.tryGetContext("stage") ?? "dev";

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

const ingestion = new IngestionStack(app, `JobRadar-Ingestion-${stage}`, {
  env,
  description: "Job Radar — pipeline de ingestão de vagas",
});

/**
 * A busca depende da ingestão, nunca o contrário: o índice é uma projeção do
 * catálogo. Duas stacks porque os ciclos de vida são opostos — a de ingestão
 * retém tabela e bucket, esta aqui é descartável e reconstruível.
 */
new SearchStack(app, `JobRadar-Search-${stage}`, {
  env,
  stage,
  table: ingestion.table,
  description: "Job Radar — índice de busca, projetor e API REST",
});
