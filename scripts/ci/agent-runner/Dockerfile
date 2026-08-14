# Self-hosted GitHub Actions runner for heron's agent workflows.
#
# Serves the `heron` label: pr-review, pr-revise, issue-triage, issue-implement
# and pr-review-probe. Those jobs check out PR-branch code and run this repo's
# `just build all && just test all`, so they need a full toolchain — and they
# must not run on the production host, which is why this is a container.
#
# Build:
#   docker build -t heron-agent-runner scripts/ci/agent-runner
#   # optional, on a network where crates.io is slow:
#   docker build --build-arg CARGO_MIRROR_URL=<sparse-index-url> ...
#
# Run: see README.md in this directory.
FROM ubuntu:24.04

ARG NODE_MAJOR=22
ARG JUST_VERSION=1.36.0
ARG RUNNER_VERSION=2.336.0
# Empty by default: the image stays generic. Pass a sparse index URL to build on
# a network where the default crates.io index is unusably slow.
ARG CARGO_MIRROR_URL=""

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# `envsubst` is gettext-base; the review workflow templates its prompts with it.
# libpcap-dev is not optional even for crates that never capture — h-storage
# pulls h-capture in transitively, so the link fails without it.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget git jq unzip zip xz-utils sudo \
        python3 python3-venv gettext-base \
        build-essential pkg-config libssl-dev libpcap-dev \
        tzdata locales \
    && rm -rf /var/lib/apt/lists/*

# gh CLI — the agent workflows drive PRs, issues and labels through it.
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Node — for the Claude Code CLI, and because `bun run build` shells out to
# tsc through its `#!/usr/bin/env node` shebang. Ubuntu's own node is far too
# old for either.
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code

RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         amd64) j=x86_64-unknown-linux-musl ;; \
         arm64) j=aarch64-unknown-linux-musl ;; \
         *) echo "unsupported arch $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/casey/just/releases/download/${JUST_VERSION}/just-${JUST_VERSION}-${j}.tar.gz" \
        | tar -xz -C /usr/local/bin just

RUN useradd -m -s /bin/bash runner \
    && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner \
    && chmod 0440 /etc/sudoers.d/runner
USER runner
WORKDIR /home/runner

ENV PATH=/home/runner/.cargo/bin:/home/runner/.bun/bin:$PATH

RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
    && rustup component add rustfmt clippy \
    && curl -fsSL https://bun.sh/install | bash

# Host-local registry mirror, if one was supplied. Kept out of the repo and out
# of the default image: it is a property of the network the image runs on, and
# baking someone else's mirror into a committed Dockerfile is how a build starts
# resolving crates from a host nobody remembers choosing.
RUN if [ -n "$CARGO_MIRROR_URL" ]; then \
      mkdir -p /home/runner/.cargo && printf '%s\n' \
        '[source.crates-io]' \
        'replace-with = "mirror"' \
        '' \
        '[source.mirror]' \
        "registry = \"$CARGO_MIRROR_URL\"" \
        > /home/runner/.cargo/config.toml; \
    fi

RUN mkdir -p /home/runner/actions-runner && cd /home/runner/actions-runner \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in amd64) r=x64 ;; arm64) r=arm64 ;; esac \
    && curl -fsSL -o runner.tar.gz \
        "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${r}-${RUNNER_VERSION}.tar.gz" \
    && tar xzf runner.tar.gz && rm runner.tar.gz

COPY --chown=runner:runner entrypoint.sh /home/runner/entrypoint.sh
RUN chmod +x /home/runner/entrypoint.sh

ENTRYPOINT ["/home/runner/entrypoint.sh"]
