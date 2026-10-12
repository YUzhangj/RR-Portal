#!/usr/bin/env python3
"""Accept only the single, literal VoyagePlex mailbox environment addition.

Exit 0 means update-server.sh may deploy voyageplex-api incrementally. All other
changes and read failures exit 1, preserving the full Compose rollout fallback.
Read Git blobs only; never expand .env values or print Compose contents.
"""

import re
import subprocess
import sys


COMPOSE_PATH = "docker-compose.cloud.yml"
MAILBOX_KEY = b"VOYAGEPLEX_HUADENG_MAILBOXES_JSON"
ADDED_LINE = b"      " + MAILBOX_KEY + b": ${" + MAILBOX_KEY + b":-}\n"


def is_mailbox_only_addition(before: bytes, after: bytes) -> bool:
    # No removals, edits, duplicate definitions, line-ending changes, or changes
    # elsewhere qualify. In particular, this does not allow any literal secret.
    if MAILBOX_KEY in before or after.count(ADDED_LINE) != 1:
        return False
    if after.replace(ADDED_LINE, b"", 1) != before:
        return False

    # Verify the literal is a mapping entry in services.voyageplex-api.environment,
    # not a similarly named variable under another service or a YAML block scalar.
    # Deliberately accept only the existing, plain indentation convention; unusual
    # YAML layouts fail closed rather than trying to infer their semantics.
    lines = after.splitlines(keepends=True)
    service = None
    section = None
    in_services = False
    services_seen = 0
    api_seen = 0
    environments_seen = 0
    eligible = False
    for line in lines:
        if not line.strip() or line.lstrip().startswith(b"#"):
            continue
        if not line.startswith(b" "):
            in_services = line == b"services:\n"
            services_seen += int(in_services)
            service = section = None
            continue
        if not in_services:
            continue
        if line.startswith(b"  ") and not line.startswith(b"   "):
            if not re.fullmatch(rb"  [A-Za-z0-9_-]+:\n", line):
                return False
            service = line[2:-2]
            api_seen += int(service == b"voyageplex-api")
            section = None
            continue
        if service != b"voyageplex-api":
            continue
        if line.startswith(b"    ") and not line.startswith(b"     "):
            section = b"environment" if line == b"    environment:\n" else None
            environments_seen += int(section == b"environment")
            continue
        if section == b"environment":
            if line == ADDED_LINE:
                eligible = True
            # Only plain, one-line environment map entries are understood here.
            # This excludes multiline values, anchors and nested structures that
            # could make an apparently indented variable be literal data instead.
            elif not re.fullmatch(rb"      [A-Za-z_][A-Za-z0-9_]*: [^\r\n]+\n", line):
                return False
            elif re.search(rb": [>|&*!]", line):
                return False
    return eligible and services_seen == api_seen == environments_seen == 1


def main() -> int:
    if len(sys.argv) != 3:
        return 1
    blobs = []
    try:
        for revision in sys.argv[1:]:
            # update-server.sh supplies verified hashes; enforce that contract so
            # a revision cannot be interpreted as a git option or path expression.
            if not re.fullmatch(r"[0-9a-fA-F]{40,64}", revision):
                return 1
            result = subprocess.run(
                ["git", "show", f"{revision}:{COMPOSE_PATH}"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=True,
            )
            blobs.append(result.stdout)
    except (OSError, subprocess.CalledProcessError):
        return 1
    return 0 if is_mailbox_only_addition(*blobs) else 1


if __name__ == "__main__":
    sys.exit(main())
