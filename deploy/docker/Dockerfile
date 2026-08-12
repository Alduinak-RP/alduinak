# Alduinak / SkyRP game server container.
#
# Build targets:
#   runtime-byo  production. Bring your own Skyrim .esm files.
#   runtime-dev  development ONLY. Bakes Bethesda .esm files into the image.
#                Never push this target to a public registry. See README.md.
#
# Build from the repository root, not from this directory:
#   docker build -f deploy/docker/Dockerfile --target runtime-byo -t alduinak-server:byo .

# ─────────────────────────────────────────────────────────────────────────────
# Toolchain. Mirrors misc/deps_linux/ubuntu-2404.sh, pinned to clang-20.
# ─────────────────────────────────────────────────────────────────────────────
FROM ubuntu:24.04 AS build-base

ENV DEBIAN_FRONTEND=noninteractive TZ=Etc/GMT

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      cmake \
      clang-20 \
      ninja-build \
      nodejs \
      git \
      zip \
      unzip \
      tar \
      pkgconf \
      linux-libc-dev \
      automake \
      libtool \
      autoconf \
      autoconf-archive \
      bison \
      flex \
      libicu-dev \
 && npm install -g yarn \
 && ln -sf /usr/bin/clang-20 /usr/bin/clang \
 && ln -sf /usr/bin/clang++-20 /usr/bin/clang++ \
 && ln -sf /usr/bin/clang-cpp-20 /usr/bin/clang-cpp \
 && rm -rf /var/lib/apt/lists/*

# ─────────────────────────────────────────────────────────────────────────────
# vcpkg checkout. Its own layer because the clone is large and rarely moves.
# The .dockerignore excludes vcpkg/, so the later COPY does not clobber it.
# ─────────────────────────────────────────────────────────────────────────────
FROM build-base AS deps

ARG VCPKG_URL=https://github.com/microsoft/vcpkg.git
# Keep in sync with the vcpkg submodule pin: git submodule status
ARG VCPKG_COMMIT=cb2981c4e03d421fa03b9bb5044cd1986180e7e4

ENV VCPKG_DISABLE_METRICS=1

WORKDIR /src

RUN git clone "$VCPKG_URL" vcpkg \
 && git -C vcpkg checkout "$VCPKG_COMMIT"

# ─────────────────────────────────────────────────────────────────────────────
# Build. Server only: SkyrimPlatform is MSVC-gated and the client is Windows.
#
# CMake resolves the vcpkg manifest during configure, so the packages cannot be
# built in a stage of their own. BuildKit cache mounts carry them between builds
# instead; the first build is slow, later ones reuse the binary cache.
# ─────────────────────────────────────────────────────────────────────────────
FROM deps AS builder

ARG BUILD_TYPE=RelWithDebInfo
# Cap parallelism on builders with little RAM per core
ARG BUILD_JOBS=0

COPY . /src

RUN chmod +x build.sh && sed -i 's/\r$//' build.sh

RUN --mount=type=cache,target=/root/.cache/vcpkg,sharing=locked \
    --mount=type=cache,target=/src/vcpkg/downloads,sharing=locked \
    if [ "${BUILD_JOBS}" != "0" ]; then export VCPKG_MAX_CONCURRENCY=${BUILD_JOBS}; fi \
 && ./build.sh --configure \
      -DCMAKE_BUILD_TYPE=${BUILD_TYPE} \
      -DBUILD_SKYRIM_PLATFORM=OFF \
      -DBUILD_CLIENT=OFF \
      -DBUILD_FRONT=OFF \
      -DBUILD_SCRIPTS=OFF \
      -DBUILD_UNIT_TESTS=OFF \
 && if [ "${BUILD_JOBS}" = "0" ]; then \
      ./build.sh --build --target skymp5-server; \
    else \
      ./build.sh --build --target skymp5-server -- -j${BUILD_JOBS}; \
    fi

# Fail early rather than shipping an image missing its addon
RUN test -f /src/build/dist/server/scam_native.node \
 && test -f /src/build/dist/server/dist_back/skymp5-server.js

# ─────────────────────────────────────────────────────────────────────────────
# Runtime. Pterodactyl conventions: user `container`, home /home/container.
# ─────────────────────────────────────────────────────────────────────────────
FROM ubuntu:24.04 AS runtime-base

ENV DEBIAN_FRONTEND=noninteractive TZ=Etc/GMT

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      nodejs \
      tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -d /home/container -s /bin/bash container

# scam_native.node links only libc, libm, libgcc_s, libresolv and libstdc++;
# vcpkg statically links the rest. Anything else nodejs needs comes in as its
# own apt dependency, so nothing further is pinned here.

COPY --from=builder /src/build/dist/server/scam_native.node /opt/alduinak/scam_native.node
COPY --from=builder /src/build/dist/server/dist_back        /opt/alduinak/dist_back

COPY deploy/docker/entrypoint.sh      /opt/alduinak/entrypoint.sh
COPY deploy/docker/render-settings.js /opt/alduinak/render-settings.js
COPY deploy/docker/build-gamemode.js  /opt/alduinak/build-gamemode.js

# .gitattributes pins these to LF, but a build context can still arrive with
# CRLF (zip export, a checkout predating that rule). A CRLF shebang is fatal.
RUN sed -i 's/\r$//' /opt/alduinak/entrypoint.sh \
                     /opt/alduinak/render-settings.js \
                     /opt/alduinak/build-gamemode.js \
 && chmod +x /opt/alduinak/entrypoint.sh

# Deliberately no SERVER_PORT/UI_PORT/DATA_DIR defaults here. render-settings.js
# only overwrites a key when its variable is set, so baking defaults would make
# those settings permanently unmanageable from server-settings.json. Unset, the
# server and the entrypoint fall back to 7777, the derived ui port and ./data.
ENV ALDUINAK_HOME=/opt/alduinak

USER container
WORKDIR /home/container

EXPOSE 7777/udp 3000/tcp

ENTRYPOINT ["/opt/alduinak/entrypoint.sh"]
CMD ["node", "dist_back/skymp5-server.js"]

# ─────────────────────────────────────────────────────────────────────────────
# Production image. The operator supplies the .esm files.
# ─────────────────────────────────────────────────────────────────────────────
FROM runtime-base AS runtime-byo

LABEL org.opencontainers.image.title="Alduinak Server" \
      org.opencontainers.image.description="SkyRP/Alduinak game server. Requires operator-supplied Skyrim .esm files." \
      org.opencontainers.image.licenses="AGPL-3.0" \
      org.opencontainers.image.source="https://github.com/MesaIndigoRoleplay/alduinak"

# ─────────────────────────────────────────────────────────────────────────────
# Development image. Bakes in Bethesda-copyrighted .esm files.
#
#   DO NOT PUBLISH. DO NOT DISTRIBUTE. LOCAL TESTING ONLY.
#
# These files are Bethesda's property. The mirror below is the one this repo's
# CI already uses for tests; it is not a licensed redistribution channel.
# ─────────────────────────────────────────────────────────────────────────────
FROM runtime-base AS runtime-dev

USER root

ARG SE_DATA_BASE=https://gitlab.com/pospelov/se-data/-/raw/main

# Building this stage must be a deliberate act, so that no CI job or careless
# --target can produce a pushable image full of Bethesda's files by accident.
ARG I_UNDERSTAND_THIS_IMAGE_IS_NOT_DISTRIBUTABLE=no
RUN if [ "${I_UNDERSTAND_THIS_IMAGE_IS_NOT_DISTRIBUTABLE}" != "yes" ]; then \
      echo "runtime-dev bakes copyrighted game files into the image and must never be published." >&2; \
      echo "Rebuild with --build-arg I_UNDERSTAND_THIS_IMAGE_IS_NOT_DISTRIBUTABLE=yes if this is a local dev build." >&2; \
      exit 1; \
    fi

RUN mkdir -p /opt/alduinak/dev-data \
 && for esm in Skyrim.esm Update.esm Dawnguard.esm HearthFires.esm Dragonborn.esm; do \
      echo "fetching $esm"; \
      curl -fsSL --retry 3 -o "/opt/alduinak/dev-data/$esm" "${SE_DATA_BASE}/$esm"; \
    done \
 && chmod -R a+r /opt/alduinak/dev-data

ENV ALDUINAK_DEV_DATA=/opt/alduinak/dev-data

LABEL org.opencontainers.image.title="Alduinak Server (dev)" \
      org.opencontainers.image.description="DEVELOPMENT ONLY. Contains Bethesda-copyrighted game files. Do not distribute." \
      com.alduinak.distributable="false"

# Guard rail: the publish workflow refuses any image carrying this label
LABEL com.alduinak.no-push="true"

USER container
WORKDIR /home/container
