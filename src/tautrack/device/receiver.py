"""Identity of the GPS receiver inside the instrument (``:DIAG:IDEN:GPS?``).

The Z3801A's SCPI port never exposes the receiver's own protocol: the instrument CPU
talks Motorola binary to an internal Oncore VP and answers SCPI on its behalf. This
undocumented query is the one window onto that receiver, relaying the Oncore's ID
block as a list of quoted, space-padded strings::

    "COPYRIGHT 1991-1995 MOTOROLA INC.","SFTW P/N # 98-P39972M     ",
    "SOFTWARE VER # 8          ","SOFTWARE REV # 4          ", ...

It is worth recording because the receiver is a separately failing, separately
replaceable part. Units have been fitted with different Oncore models and firmware,
and a "GPS Rcv: Err" health flag is far easier to reason about knowing which one.

Parsing is by label, not by position, and every field is optional. A sibling unit
with a different receiver (the Lucent KS-24361 reports ``HWDR`` where HP units say
``HDWR``) must degrade to fewer named fields, never to an exception.
"""

from __future__ import annotations

import re

_QUOTED = re.compile(r'"([^"]*)"')

#: Field label prefix -> key. Longest prefixes first, so ``SOFTWARE VER`` is not
#: swallowed by a shorter label. ``HWDR`` is a real typo in some Oncore firmware.
_LABELS: tuple[tuple[str, str], ...] = (
    ("SOFTWARE VER #", "software_version"),
    ("SOFTWARE REV #", "software_revision"),
    ("SOFTWARE DATE", "software_date"),
    ("SFTW P/N #", "software_part"),
    ("HDWR P/N #", "hardware_part"),
    ("HWDR P/N #", "hardware_part"),
    ("MANUFACTUR DATE", "manufacture_date"),
    ("OPTIONS LIST", "options"),
    ("SERIAL #", "serial"),
    ("MODEL #", "model"),
)


def parse_gps_identity(body: str) -> dict[str, str]:
    """Split the ``:DIAG:IDEN:GPS?`` reply into named fields.

    Returns an empty dict if the reply holds no quoted fields at all. Unrecognised
    fields are kept under ``field_N`` rather than dropped, so a receiver that reports
    something new is still visible in the stored record.

    ``firmware`` is derived as ``VER.REV`` (``8.4``) when both are present, because
    that is how Oncore firmware is conventionally named and the two fields are
    meaningless apart.
    """
    out: dict[str, str] = {}
    for i, raw in enumerate(_QUOTED.findall(body)):
        field = " ".join(raw.split())
        if not field:
            continue
        if field.upper().startswith("COPYRIGHT"):
            out["copyright"] = field
            continue
        for label, key in _LABELS:
            if field.upper().startswith(label):
                value = field[len(label) :].strip()
                # The Oncore pads an empty field with a single underscore.
                out[key] = "" if value == "_" else value
                break
        else:
            out[f"field_{i}"] = field

    ver, rev = out.get("software_version"), out.get("software_revision")
    if ver and rev:
        out["firmware"] = f"{ver}.{rev}"
    return out
