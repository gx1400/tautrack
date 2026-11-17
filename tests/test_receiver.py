"""GPS receiver identity: parsing the ``:DIAG:IDEN:GPS?`` reply.

The reference unit's reply comes from the replay fixture; the others are published
captures from other units, testing tolerance across receivers rather than one layout.
"""

from __future__ import annotations

import json

from tautrack.device.receiver import parse_gps_identity

#: HP Z3801A, posted to the TAPR tacgps list (2006-03-10).
#: https://www.mail-archive.com/tacgps@lists.tapr.org/msg00060.html
Z3801A = (
    '"COPYRIGHT 1991-1995 MOTOROLA INC.","SFTW P/N # 98-P39972M     ",'
    '"SOFTWARE VER # 8          ","SOFTWARE REV # 4          ",'
    '"SOFTWARE DATE  13 JUL 1995","MODEL #    B1121P1114     ",'
    '"HDWR P/N # _              ","SERIAL #   SSG0215870     ",'
    '"MANUFACTUR DATE 7C12      ","OPTIONS LIST    IB        "'
)

#: Lucent KS-24361, posted to time-nuts (2014-11). A different Oncore, and its
#: firmware spells the hardware label HWDR. No OPTIONS LIST field.
#: https://www.febo.com/pipermail/time-nuts/2014-November/087816.html
KS24361 = (
    '"COPYRIGHT 1991-1997 MOTOROLA INC.","SFTW P/N # 98-P36848P ","SOFTWARE VER # 2 ",'
    '"SOFTWARE REV # 2 ","SOFTWARE DATE APR 24 1998","MODEL # R5122U1152 ",'
    '"HWDR P/N # 5 ","SERIAL # R08FG1 ","MANUFACTUR DATE 0E05 "'
)


def test_parses_the_reference_unit_reply(session_fixture) -> None:
    """Captured from S/N 3542A05653 (firmware 3543-A) on 2026-11-17."""
    rec = next(
        r
        for r in map(json.loads, session_fixture.read_text(encoding="utf-8").splitlines())
        if r["command"] == ":DIAG:IDEN:GPS?"
    )
    got = parse_gps_identity(rec["body"])
    assert got["model"] == "B1121P1114"
    assert got["firmware"] == "8.4"
    assert got["serial"] == "SSG0243552"
    assert got["hardware_part"] == ""
    assert len(got) == 11


def test_parses_the_published_z3801a_reply() -> None:
    assert parse_gps_identity(Z3801A) == {
        "copyright": "COPYRIGHT 1991-1995 MOTOROLA INC.",
        "software_part": "98-P39972M",
        "software_version": "8",
        "software_revision": "4",
        "software_date": "13 JUL 1995",
        "model": "B1121P1114",
        "hardware_part": "",
        "serial": "SSG0215870",
        "manufacture_date": "7C12",
        "options": "IB",
        "firmware": "8.4",
    }


def test_parses_a_different_receiver_with_its_label_typo() -> None:
    got = parse_gps_identity(KS24361)
    assert got["model"] == "R5122U1152"
    assert got["firmware"] == "2.2"
    assert got["hardware_part"] == "5"
    assert got["software_date"] == "APR 24 1998"
    assert "options" not in got


def test_reply_split_across_lines_parses_the_same() -> None:
    """Terminal captures show one field per line; the parser must not care."""
    assert parse_gps_identity(Z3801A.replace(",", ",\r\n")) == parse_gps_identity(Z3801A)


def test_unknown_fields_are_kept_not_dropped() -> None:
    got = parse_gps_identity('"MODEL # X1","SOMETHING NEW 42"')
    assert got == {"model": "X1", "field_1": "SOMETHING NEW 42"}


def test_firmware_needs_both_version_and_revision() -> None:
    assert "firmware" not in parse_gps_identity('"SOFTWARE VER # 8"')


def test_unrecognisable_reply_gives_nothing() -> None:
    assert parse_gps_identity("") == {}
    assert parse_gps_identity("+0") == {}
