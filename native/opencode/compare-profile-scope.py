#!/usr/bin/env python3
"""Compare saved profile scope metadata; never read token fields or contact servers."""
import argparse
import hashlib
import json
import os
import pathlib
import sqlite3

FIELDS = ('email', 'orgID', 'server')


def compare(database, reference):
    expected = reference['metadata_sha256']
    if set(expected) != set(FIELDS) or any(
        not isinstance(value, str) or len(value) != 64 or any(c not in '0123456789abcdef' for c in value)
        for value in expected.values()
    ):
        raise ValueError('Invalid metadata comparison reference')
    database = pathlib.Path(database).resolve(strict=True)
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as conn:
        # Native Credential.list sorts ascending, then Integration reverses it.
        # Resolve metadata for the first saved connection, including inactive
        # fallback, without selecting access/refresh tokens or the whole value.
        rows = conn.execute("""
            SELECT json_extract(value, '$.type'),
                   json_extract(value, '$.metadata.email'),
                   json_extract(value, '$.metadata.orgID'),
                   json_extract(value, '$.metadata.server')
            FROM credential WHERE integration_id='opencode'
            ORDER BY active DESC, time_created DESC, id DESC LIMIT 1
        """).fetchall()
    result = {'inference_requested': False, 'saved_connection_present': bool(rows),
              'scope': 'saved database connection; runtime wrapper/plugin overrides not observed'}
    if not rows:
        return result
    kind, *values = rows[0]
    result['selected_saved_type'] = kind if kind in ('oauth', 'api', 'key') else 'unsupported'
    result['matches_staging'] = {
        name: hashlib.sha256(value.encode()).hexdigest() == expected[name] if isinstance(value, str) else None
        for name, value in zip(FIELDS, values)
    }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference', required=True)
    args = parser.parse_args()
    home = pathlib.Path.home()
    data = pathlib.Path(os.environ.get('XDG_DATA_HOME') or home / '.local/share') / 'opencode'
    database = pathlib.Path(os.environ.get('OPENCODE_DB') or data / 'opencode.db')
    try:
        result = compare(database, json.loads(pathlib.Path(args.reference).read_text()))
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
        # SQLite and OS exception messages may include profile paths; print type only.
        print(json.dumps({'inference_requested': False, 'inspection_failed': type(error).__name__}))
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
