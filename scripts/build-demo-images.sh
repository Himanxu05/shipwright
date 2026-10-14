#!/bin/sh
# Build three versions of the demo app: two healthy, one whose health check fails.
set -e
cd "$(dirname "$0")/../demo-app"
docker build -q -t shipwright-demo:v1 --build-arg VERSION=v1 . >/dev/null
docker build -q -t shipwright-demo:v2 --build-arg VERSION=v2 . >/dev/null
docker build -q -t shipwright-demo:v3-broken --build-arg VERSION=v3 --build-arg BROKEN=1 . >/dev/null
echo "built shipwright-demo:v1, :v2, :v3-broken"
