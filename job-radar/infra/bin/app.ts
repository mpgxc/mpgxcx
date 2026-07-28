#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { IngestionStack } from "../lib/ingestion-stack.js";

const app = new App();
const stage = app.node.tryGetContext("stage") ?? "dev";

new IngestionStack(app, `JobRadar-Ingestion-${stage}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  description: "Job Radar — pipeline de ingestão de vagas",
});
