# The Chorus box: a clean Debian 12 with the AI CLIs at the newest versions Chorus has tested. Chorus itself is installed when the box
# starts, on the channel you pick (stable or preview), by the same install.sh everyone uses (docker/box/entrypoint.sh).
# Plan: docs/plans/2026-11-07-browser-everywhere-and-docker.md, part B. Built by .github/workflows/docker.yml:
#   docker build $(node docker/box/tested.mjs --build-args ../chorus-core/src/tested.json) -t chorus-box docker/box
FROM node:22-bookworm-slim

ARG CLAUDE_VERSION
ARG CODEX_VERSION
ARG AGY_VERSION
ARG TARGETARCH

# the tools agents reach for in a project (git, a compiler, Python), the installer's (curl, tar), tini to reap the agents' processes
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client tar xz-utils gzip unzip less procps \
      python3 python3-pip python3-venv build-essential tini locales \
 && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/*

# the CLIs, pinned; installed as root into /usr/local, so they can't be replaced from inside the box either
RUN test -n "$CLAUDE_VERSION" && test -n "$CODEX_VERSION" && test -n "$AGY_VERSION" \
 && npm install -g --no-fund --no-audit --loglevel=error "@anthropic-ai/claude-code@${CLAUDE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && case "$TARGETARCH" in amd64) AGY_TARGET=linux_x64 ;; arm64) AGY_TARGET=linux_arm64 ;; *) echo "no agy for $TARGETARCH" >&2; exit 1 ;; esac \
 && mkdir -p /opt/agy \
 && curl -fsSL "https://github.com/google-antigravity/antigravity-cli/releases/download/${AGY_VERSION}/agy_cli_${AGY_TARGET}.tar.gz" | tar -xz -C /opt/agy \
 && ln -s /opt/agy/antigravity /usr/local/bin/agy \
 && npm cache clean --force

# auto-update off: Claude Code (DISABLE_AUTOUPDATER) and agy (AGY_CLI_DISABLE_AUTO_UPDATE, chorus-core docs/integrations/antigravity-agy.md §9)
ENV DISABLE_AUTOUPDATER=1 \
    AGY_CLI_DISABLE_AUTO_UPDATE=1 \
    LANG=en_US.UTF-8 \
    TERM=xterm-256color \
    CHORUS_PORT=4318 \
    CHORUS_BOX=1 \
    CHORUS_BOX_CLAUDE=${CLAUDE_VERSION} \
    CHORUS_BOX_CODEX=${CODEX_VERSION} \
    CHORUS_BOX_AGY=${AGY_VERSION}

# agents never run as root: the image's uid-1000 user becomes `chorus`; the entrypoint matches it to your ids on a Linux host
RUN usermod -l chorus -d /home/chorus -m node && groupmod -n chorus node \
 && mkdir -p /home/chorus && chown chorus:chorus /home/chorus

COPY entrypoint.sh /usr/local/bin/chorus-box
RUN chmod 755 /usr/local/bin/chorus-box

LABEL org.opencontainers.image.source="https://github.com/chauvoluuhuong/chorus" \
      org.opencontainers.image.description="Chorus in your browser, with Claude Code, Codex and Antigravity at the versions Chorus has tested" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

VOLUME /home/chorus
EXPOSE 4318
WORKDIR /home/chorus
ENTRYPOINT ["tini", "--", "/usr/local/bin/chorus-box"]
