// Start the GitHub Actions "Daily snapshot" workflow. The AWS SDK v3 ships with the nodejs22.x runtime.
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const secrets = new SecretsManagerClient({});

export async function handler() {
  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.GITHUB_TOKEN_SECRET_ID }));
  let token = SecretString.trim();
  if (token.startsWith("{")) token = JSON.parse(token).token;
  const url = `https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/actions/workflows/${process.env.WORKFLOW_FILE}/dispatches`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "election-tracker-dispatch" },
    body: JSON.stringify({ ref: "main" }),
  });
  if (response.status !== 204) {
    const body = await response.text();
    throw new Error(`workflow dispatch failed: HTTP ${response.status} ${body.slice(0, 300)}`);
  }
  console.log(`dispatched ${process.env.WORKFLOW_FILE} on ${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}`);
  return { ok: true };
}
