#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'usage: %s <review.txt>\n' "$0" >&2
  exit 64
fi

review_file=$1
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${PR:?PR is required}"
: "${HEAD_SHA:?HEAD_SHA is required}"

if [[ ! "$PR" =~ ^[0-9]+$ ]]; then
  printf 'PR must be a numeric pull request number.\n' >&2
  exit 64
fi

if [[ ! "$HEAD_SHA" =~ ^[[:xdigit:]]{40}$ ]]; then
  printf 'HEAD_SHA must be a full 40-character commit SHA.\n' >&2
  exit 64
fi

head_sha=${HEAD_SHA,,}
head_sha_short=${head_sha:0:7}
added_re='^- \+ `([^`]+)`'
root_re=' — `([^`]+)`'
total_added=0
declare -a judged_destinations=()
declare -a outside_lines=()

while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" =~ $added_re ]]; then
    destination=${BASH_REMATCH[1]}
    total_added=$((total_added + 1))

    root=
    if [[ "$line" =~ $root_re ]]; then
      root=${BASH_REMATCH[1]}
    fi

    if [[ "$root" == "Runner.Worker" ]]; then
      judged_destinations+=("$destination")
    else
      outside_lines+=("$line")
    fi
  fi
done < "$review_file"

if (( total_added == 0 )); then
  printf 'No added workload destination rows were found; cannot safely infer destinations from another format.\n'
  exit 2
fi

if (( ${#outside_lines[@]} > 0 )); then
  printf "Outside the workflow's process tree, not judged:\n"
  printf '%s\n' "${outside_lines[@]}"
fi

if (( ${#judged_destinations[@]} == 0 )); then
  printf 'No Runner.Worker-rooted additions remain to judge; no acknowledgement is required.\n'
  exit 0
fi

if [[ -n "${GARNET_ACK_FIXTURE_DIR:-}" ]]; then
  labels_json=$(<"$GARNET_ACK_FIXTURE_DIR/labels.json")
  comments_json=$(<"$GARNET_ACK_FIXTURE_DIR/comments.json")
else
  labels_json=$(gh api --paginate --slurp "repos/${GITHUB_REPOSITORY}/issues/${PR}/labels?per_page=100" | jq 'add')
  comments_json=$(gh api --paginate --slurp "repos/${GITHUB_REPOSITORY}/issues/${PR}/comments?per_page=100" | jq 'add')
fi

if ! jq -e 'type == "array"' <<<"$labels_json" >/dev/null; then
  printf 'Label response must be a JSON array.\n' >&2
  exit 1
fi

if ! jq -e 'type == "array"' <<<"$comments_json" >/dev/null; then
  printf 'Comment response must be a JSON array.\n' >&2
  exit 1
fi

destinations_json=$(printf '%s\n' "${judged_destinations[@]}" | jq -R . | jq -s .)
match=$(jq -r --arg head "$head_sha" --arg short "$head_sha_short" --argjson destinations "$destinations_json" '
  first(
    .[]
    | select((.body | type) == "string" and (.user.login | type) == "string" and (.user.type | type) == "string" and (.html_url | type) == "string")
    | select(.user.type == "User" and ((.author_association // "") | IN("OWNER","MEMBER","COLLABORATOR")))
    | . as $comment
    | select(
        [
          $comment.body
          | split("\n")[]
          | sub("\r$"; "")
          | select(test("^garnet-ack (" + $head + "|" + $short + ")([[:space:]]|$)"))
        ] | length > 0
      )
    | select(all($destinations[]; . as $destination | ($comment.body | contains($destination))))
    | [$comment.user.login, $comment.html_url] | @tsv
  ) // empty
' <<<"$comments_json")

ignored_match=
if [[ -z "$match" ]]; then
  ignored_match=$(jq -r --arg head "$head_sha" --arg short "$head_sha_short" --argjson destinations "$destinations_json" '
    first(
      .[]
      | select((.body | type) == "string" and (.user.login | type) == "string" and (.user.type | type) == "string" and (.html_url | type) == "string")
      | . as $comment
      | select(
          [
            $comment.body
            | split("\n")[]
            | sub("\r$"; "")
            | select(test("^garnet-ack (" + $head + "|" + $short + ")([[:space:]]|$)"))
          ] | length > 0
        )
      | select(all($destinations[]; . as $destination | ($comment.body | contains($destination))))
      | select($comment.user.type != "User" or ((($comment.author_association // "") | IN("OWNER","MEMBER","COLLABORATOR")) | not))
      | [$comment.user.login, $comment.user.type, ($comment.author_association // "")] | @tsv
    ) // empty
  ' <<<"$comments_json")
fi

has_ack_label=false
if jq -e 'any(.[]; .name == "garnet-ack")' <<<"$labels_json" >/dev/null; then
  has_ack_label=true
fi

if [[ "$has_ack_label" == true && -n "$match" ]]; then
  IFS=$'\t' read -r comment_author comment_url <<<"$match"
  printf 'garnet/evidence: change acknowledged for %s by @%s — %s\n' "$head_sha_short" "$comment_author" "$comment_url"
  printf 'Acknowledged destinations:\n'
  for destination in "${judged_destinations[@]}"; do
    printf -- '- `%s`\n' "$destination"
  done
  exit 0
fi

if [[ -n "$ignored_match" ]]; then
  IFS=$'\t' read -r ignored_author ignored_type ignored_association <<<"$ignored_match"
  printf "Ignored acknowledgement by @%s (%s, %s): acknowledgements must come from a maintainer, not the pull request's agent or bot.\n" "$ignored_author" "$ignored_type" "$ignored_association"
fi

printf 'Destinations requiring acknowledgement:\n'
for destination in "${judged_destinations[@]}"; do
  printf -- '- `%s`\n' "$destination"
done
printf '%s\n' '::error title=garnet/evidence: unacknowledged runtime change::'
printf '%s\n' 'A maintainer decides whether every destination above is intended: they comment a line `garnet-ack <head sha>` followed by each destination exactly as listed and why it is expected, then add the `garnet-ack` label to re-run this check. Agents and bots cannot acknowledge. A new push needs a new acknowledgement. Evidence never approves; the acknowledgement is the maintainer'\''s decision.'
exit 2
