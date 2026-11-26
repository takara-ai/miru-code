#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 ]] || [[ ${MIRU_SHARED_URL:-} != https://* ]] || [[ -z ${MIRU_SHARED_REGION:-} ]] || [[ -z ${MIRU_SMOKE_READER_PROFILE:-} ]]; then
  echo 'Usage: MIRU_SHARED_URL=https://... MIRU_SHARED_REGION=... MIRU_SMOKE_READER_PROFILE=... bash smoke-pilot.sh DISPOSABLE_REPOSITORY' >&2
  exit 2
fi
if [[ -n ${MIRU_SHARED_LOCAL_TOKEN:-} ]]; then
  echo 'Unset MIRU_SHARED_LOCAL_TOKEN to test the deployed IAM path.' >&2
  exit 2
fi

repo=$1
cli="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)/src/cli.ts"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

export MIRU_NO_UPDATE_CHECK=1
export AWS_EC2_METADATA_DISABLED=true

writer() {
  bun "$cli" shared "$@"
}

reader() {
  env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
    AWS_PROFILE="$MIRU_SMOKE_READER_PROFILE" bun "$cli" shared "$@"
}

mkdir "$work/git" "$work/headless"
cd "$work/git"
git init --quiet --template=''
git config user.name 'Miru BOX smoke test'
git config user.email 'miru-smoke@example.invalid'
git config commit.gpgsign false
printf 'export const enforceRateLimit = () => 42;\n' > policy.ts
git add -- policy.ts
git commit --quiet -m 'Add pilot fixture'
revision=$(git rev-parse HEAD)
writer sync-git "$repo" "$revision" | jq -e '.files == 1 and .updated == 1 and .embeddedChunks >= 1' >/dev/null

(cd "$work/headless" && reader search 'enforce rate limit' "$repo") | jq -e --arg repository "$repo" '
  any(.[]; .repository == $repository and .chunk.file_path == "policy.ts"
    and .chunk.start_line == 1 and (.chunk.content | contains("enforceRateLimit")))
' >/dev/null
writer sync-git "$repo" "$revision" | jq -e '.files == 0 and .updated == 0 and .embeddedChunks == 0' >/dev/null

git rm --quiet -- policy.ts
git commit --quiet -m 'Remove pilot fixture'
writer sync-git "$repo" "$(git rev-parse HEAD)" | jq -e '.files == 1 and .updated == 1 and .embeddedChunks == 0' >/dev/null
(cd "$work/headless" && reader search 'enforce rate limit' "$repo") | jq -e '. == []' >/dev/null

echo 'BOX smoke test passed: live embedding, private retrieval, Git replay and deletion.'
