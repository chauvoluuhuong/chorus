# Linux e2e of Vietnamese typing (fix/vietnamese-input): Ubuntu 22.04 (the Linux build's base) with Xvfb, Openbox, dbus,
# IBus + ibus-bamboo (PPA bamboo-engine/ibus-bamboo), xdotool, ImageMagick, WebKitGTK 4.1, Node 22 and a Linux build of node-pty.
# The Chorus desktop binary and the Node tarball come in the build context (see build.sh); the worktree is mounted at run time.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN printf 'Acquire::http::Timeout "20";\nAcquire::Retries "3";\n' > /etc/apt/apt.conf.d/99timeouts \
 && apt-get update -qq && apt-get install -y -qq --no-install-recommends software-properties-common gpg-agent ca-certificates \
 && add-apt-repository -y ppa:bamboo-engine/ibus-bamboo && apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends xvfb openbox dbus-x11 at-spi2-core ibus ibus-gtk3 ibus-bamboo xdotool xclip x11-utils \
      imagemagick libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1 librsvg2-common fonts-dejavu-core fonts-noto-core \
      build-essential python3 xz-utils curl jq procps locales \
 && locale-gen en_US.UTF-8 && rm -rf /var/lib/apt/lists/*
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
COPY node.tar.xz /tmp/node.tar.xz
RUN mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 && rm /tmp/node.tar.xz
ENV PATH=/opt/node/bin:$PATH
RUN mkdir -p /opt/pty && cd /opt/pty && npm init -y >/dev/null && npm install --no-audit --no-fund node-pty@1.1.0 >/dev/null
COPY chorus-desktop /opt/chorus-desktop
COPY inside.sh /opt/inside.sh
RUN chmod +x /opt/chorus-desktop /opt/inside.sh
