#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${DOCKER_REPOSITORY:-dockermajor}"
TAG="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)}"
PUSH_LATEST="${PUSH_LATEST:-1}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[docker-push] docker is not installed." >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[docker-push] docker daemon is not available." >&2
  exit 1
fi

images=(
  "little-legend-api apps/api/Dockerfile"
  "little-legend-worker apps/worker/Dockerfile"
  "little-legend-web apps/web/Dockerfile"
)

echo "[docker-push] repository: ${REPOSITORY}"
echo "[docker-push] tag: ${TAG}"
echo "[docker-push] push latest: ${PUSH_LATEST}"

for image_entry in "${images[@]}"; do
  image_name="${image_entry%% *}"
  dockerfile="${image_entry##* }"
  full_image="${REPOSITORY}/${image_name}"

  echo "[docker-push] building ${full_image}:${TAG} using ${dockerfile}"
  docker build -f "${dockerfile}" -t "${full_image}:${TAG}" .

  echo "[docker-push] pushing ${full_image}:${TAG}"
  docker push "${full_image}:${TAG}"

  if [[ "${PUSH_LATEST}" == "1" ]]; then
    docker tag "${full_image}:${TAG}" "${full_image}:latest"
    echo "[docker-push] pushing ${full_image}:latest"
    docker push "${full_image}:latest"
  fi
done

echo "[docker-push] complete"
