#!/usr/bin/env python3
"""Initialize the pgvector store schema (extension, vector table, naming table, HNSW index).

Idempotent: safe to run repeatedly. Only relevant for VECTOR_STORE=pgvector;
a no-op message is printed when the lance fallback is active.

Usage:
    python scripts/setup_db.py [--drop] [--dsn <postgres://...>]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from refract_store import TABLE, NAMES_TABLE, PgStore, create_store, load_env

DDL_INDEX = (
    f"CREATE INDEX IF NOT EXISTS {TABLE}_vector_hnsw "
    f"ON {TABLE} USING hnsw (vector vector_cosine_ops)"
)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dsn", default=None, help="override SUPABASE_DB_URL")
    ap.add_argument("--drop", action="store_true", help="drop the tables first")
    args = ap.parse_args()

    load_env()
    store = create_store(dsn=args.dsn)
    if not isinstance(store, PgStore):
        print("VECTOR_STORE is lance (no Supabase URL configured) — nothing to do")
        return 0

    with store._connect() as conn:
        if args.drop:
            with conn.cursor() as cur:
                cur.execute(f"DROP TABLE IF EXISTS {TABLE}")
                cur.execute(f"DROP TABLE IF EXISTS {NAMES_TABLE}")
            conn.commit()
            print(f"dropped tables {TABLE}, {NAMES_TABLE}")
        store._ensure_schema(conn, create_index=True)
    print(f"pgvector schema ready: extension + tables {TABLE}/{NAMES_TABLE} + HNSW index")
    return 0


if __name__ == "__main__":
    sys.exit(main())
