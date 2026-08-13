## Pre-built Images:

CI (`.github/workflows/docker.yml`) builds `docker/Dockerfile` for `linux/amd64` and
`linux/arm64` and publishes a multi-arch image to this repository's GitHub Packages:

```sh
docker pull ghcr.io/kaikaisd/mirakurun-bs4k-merged:latest
```

Tags:

| tag | source |
| --- | --- |
| `latest`, `bs4k-merged` | every push to `bs4k-merged` |
| `<version>`, `<major>.<minor>` | git tags like `4.1.3-bs4k.0` / `v4.1.3` |
| `sha-<short-sha>` | every published build |

To run the pre-built image with the bundled compose file, override the image:

```sh
MIRAKURUN_IMAGE_TAG=latest \
  docker compose -f docker/docker-compose.yml up -d
```

(the compose file points at `chinachu/mirakurun` by default — edit the `image:` line to
`ghcr.io/kaikaisd/mirakurun-bs4k-merged` to use this fork's image.)

## Docker Development Commands:

```sh
# build
npm run docker:build
# setup
npm run docker:run-setup
# run
npm run docker:run
# run w/ env
docker compose -f docker/docker-compose.yml run --rm --service-ports -e LOG_LEVEL=3 mirakurun
# up
npm run docker:up
# down
npm run docker:down
# logs
npm run docker:logs
# bash
npm run docker:bash
```
