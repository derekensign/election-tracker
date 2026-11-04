#!/usr/bin/env bash
# Deploy the election-night recorders (aws/needle-template.yaml: Texas needle and U.S. Senate control) to the
# PERSONAL AWS account.
#   AWS_PROFILE=personal ./aws/deploy-needle.sh
# Packages aws/needle/index.mjs with the pure ingest modules it imports, unchanged, so the Lambda runs exactly the
# model the page and the GitHub recorder run. Test a pass afterwards with:
#   AWS_PROFILE=personal aws lambda invoke --function-name election-tracker-needle /dev/stdout
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
STACK_NAME="election-tracker-needle"
PERSONAL_ACCOUNT_ID="853443719819"
[[ -n "${AWS_PROFILE:-}" ]] || { echo "ERROR: set AWS_PROFILE=personal" >&2; exit 1; }
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ "$ACCOUNT_ID" == "$PERSONAL_ACCOUNT_ID" ]] || { echo "ERROR: expected personal account $PERSONAL_ACCOUNT_ID, got $ACCOUNT_ID" >&2; exit 1; }

# Assemble the package: handler + ingest/{needle,early-vote,http,config}.js + ingest/sources/sos-results.js.
PACKAGE=needle/package
mkdir -p "$PACKAGE/ingest/sources"
find "$PACKAGE" -type f -delete
cp needle/index.mjs "$PACKAGE/"
cp ../ingest/needle.js ../ingest/early-vote.js ../ingest/http.js ../ingest/config.js ../ingest/texas-counties.js ../ingest/senate-returns.js "$PACKAGE/ingest/"
cp ../ingest/sources/sos-results.js "$PACKAGE/ingest/sources/"
echo '{ "type": "module" }' > "$PACKAGE/package.json"

# The Senate recorder: handler + the modules it imports (senate-night needs needle and metrics; senate-returns reads
# the states' results files).
SENATE=senate/package
mkdir -p "$SENATE/ingest"
find "$SENATE" -type f -delete
cp senate/index.mjs senate/extra-ca.pem "$SENATE/"
cp ../ingest/senate-night.js ../ingest/senate-returns.js ../ingest/needle.js ../ingest/early-vote.js ../ingest/metrics.js ../ingest/config.js "$SENATE/ingest/"
echo '{ "type": "module" }' > "$SENATE/package.json"

sam deploy --template-file needle-template.yaml --stack-name "$STACK_NAME" --resolve-s3 --capabilities CAPABILITY_IAM \
  --no-confirm-changeset --no-fail-on-empty-changeset --no-progressbar
aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs" --output table
