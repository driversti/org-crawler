#!/bin/bash
set -e

REGISTRY="${REGISTRY_URL:-registry.yurii.live}"
IMAGE_NAME="org-crawler"
TAG="${1:-latest}"

# Create and use buildx builder if not exists
docker buildx inspect multiarch >/dev/null 2>&1 || \
    docker buildx create --name multiarch --use

# Login to registry
if [ -n "$REGISTRY_USER" ] && [ -n "$REGISTRY_PASSWORD" ]; then
    echo "$REGISTRY_PASSWORD" | docker login "$REGISTRY" -u "$REGISTRY_USER" --password-stdin
fi

# Build and push for both architectures
docker buildx build \
    --platform linux/amd64,linux/arm64 \
    --tag "$REGISTRY/$IMAGE_NAME:$TAG" \
    --tag "$REGISTRY/$IMAGE_NAME:latest" \
    --push \
    .

echo "Pushed $REGISTRY/$IMAGE_NAME:$TAG"
