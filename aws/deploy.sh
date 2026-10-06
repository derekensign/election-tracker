#!/usr/bin/env bash
# Deploy the morning dispatch Lambda to the PERSONAL AWS account.
#   AWS_PROFILE=personal ./aws/deploy.sh
# Prereq: Secrets Manager secret election-tracker/github-dispatch-token holding a GitHub token with the
# `workflow` scope. The gh CLI's own token works (`gh auth token`) but dies if you ever run `gh auth logout`
# or `gh auth refresh`; a fine-grained PAT with Actions: write on this repo is the durable choice.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
STACK_NAME="election-tracker-dispatch"
PERSONAL_ACCOUNT_ID="853443719819"
SECRET_ID="election-tracker/github-dispatch-token"
[[ -n "${AWS_PROFILE:-}" ]] || { echo "ERROR: set AWS_PROFILE=personal" >&2; exit 1; }
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
[[ "$ACCOUNT_ID" == "$PERSONAL_ACCOUNT_ID" ]] || { echo "ERROR: expected personal account $PERSONAL_ACCOUNT_ID, got $ACCOUNT_ID" >&2; exit 1; }
aws secretsmanager describe-secret --secret-id "$SECRET_ID" >/dev/null 2>&1 || { echo "ERROR: secret $SECRET_ID missing. Create it: aws secretsmanager create-secret --name $SECRET_ID --secret-string \"\$(gh auth token)\"" >&2; exit 1; }
sam build
sam deploy --stack-name "$STACK_NAME" --resolve-s3 --capabilities CAPABILITY_IAM --no-confirm-changeset --no-fail-on-empty-changeset --no-progressbar
echo "Deployed. Test with: AWS_PROFILE=$AWS_PROFILE aws lambda invoke --function-name election-tracker-dispatch /dev/stdout"
