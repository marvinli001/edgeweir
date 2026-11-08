FROM debian:13-slim
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openssh-server openssh-client sudo curl ca-certificates iptables procps >/dev/null \
  && rm -rf /var/lib/apt/lists/* \
  && useradd -m -s /bin/bash deploy && useradd -m -s /bin/bash nopass && useradd -m -s /bin/bash denied && useradd -m -s /bin/bash notty \
  && printf 'deploy ALL=(ALL) ALL\nnopass ALL=(ALL) NOPASSWD: ALL\nnotty ALL=(ALL) ALL\nDefaults:deploy requiretty\nDefaults:nopass requiretty\n' >/etc/sudoers.d/fixture \
  && chmod 0440 /etc/sudoers.d/fixture \
  && printf 'PermitRootLogin yes\nPasswordAuthentication yes\nAllowAgentForwarding yes\nMatch User notty\n PermitTTY no\n' >/etc/ssh/sshd_config.d/fixture.conf \
  && rm -f /etc/ssh/ssh_host_* && mkdir -p /run/sshd
CMD ["bash", "-ec", "ssh-keygen -A >/dev/null; /usr/sbin/sshd -E /var/log/sshd.log; exec sleep infinity"]
