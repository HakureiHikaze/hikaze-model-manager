# -*- coding: utf-8 -*-
from __future__ import annotations

import os
import sqlite3
import threading
import time
from typing import Any, Dict, Iterable, List, Literal, Optional, Tuple

try:
    from .config import DB_PATH, SYSTEM_TAGS  # type: ignore
except Exception:
    # fallback for script-run context
    import importlib.util, sys as _sys
    _BDIR = os.path.dirname(__file__)
    _spec = importlib.util.spec_from_file_location("hikaze_mm_config", os.path.join(_BDIR, "config.py"))
    if _spec is None or _spec.loader is None:
        raise ImportError("cannot load config.py")
    _mod = importlib.util.module_from_spec(_spec)
    _sys.modules["hikaze_mm_config"] = _mod
    _spec.loader.exec_module(_mod)
    DB_PATH = _mod.DB_PATH
    SYSTEM_TAGS = _mod.SYSTEM_TAGS

_CONN_LOCK = threading.Lock()
_conn: Optional[sqlite3.Connection] = None


def _dict_factory(cursor: sqlite3.Cursor, row: Tuple[Any, ...]) -> Dict[str, Any]:
    return {col[0]: row[idx] for idx, col in enumerate(cursor.description)}


def get_conn() -> sqlite3.Connection:
    global _conn
    with _CONN_LOCK:
        if _conn is None:
            os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
            _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
            _conn.row_factory = _dict_factory
            _conn.execute("PRAGMA journal_mode=WAL;")
            _conn.execute("PRAGMA synchronous=NORMAL;")
            _conn.execute("PRAGMA foreign_keys=ON;")
        return _conn


SCHEMA_SQL = r"""
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS directories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  alias TEXT,
  parent_id INTEGER,
  FOREIGN KEY(parent_id) REFERENCES directories(id)
);

CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  dir_path TEXT NOT NULL,
  name TEXT,
  type TEXT NOT NULL,
  size_bytes INTEGER,
  mtime_ns INTEGER,
  hash_algo TEXT NOT NULL,
  hash_hex TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  meta_json TEXT,
  extra_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_models_hash ON models(hash_hex);
CREATE INDEX IF NOT EXISTS idx_models_type ON models(type);
CREATE INDEX IF NOT EXISTS idx_models_path ON models(path);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS model_tags (
  model_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (model_id, tag_id),
  FOREIGN KEY(model_id) REFERENCES models(id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
"""


def init_db() -> None:
    conn = get_conn()
    with conn:
        conn.executescript(SCHEMA_SQL)
        # init schema_version if empty
        cur = conn.execute("SELECT COUNT(1) AS c FROM schema_version")
        row = cur.fetchone()
        if not row or row["c"] == 0:
            conn.execute("INSERT INTO schema_version(version) VALUES (?)", (1,))
        # ensure system tags exist
        now = int(time.time() * 1000)
        for t in SYSTEM_TAGS:
            try:
                conn.execute("INSERT OR IGNORE INTO tags(name, created_at) VALUES (?,?)", (t, now))
            except sqlite3.Error:
                pass


# --- Tag helpers ---

def get_or_create_tag_id(name: str) -> int:
    name = name.strip().lower()
    if not name:
        raise ValueError("empty tag name")
    conn = get_conn()
    cur = conn.execute("SELECT id FROM tags WHERE name=?", (name,))
    row = cur.fetchone()
    if row:
        return int(row["id"])
    now = int(time.time() * 1000)
    with conn:
        cur = conn.execute("INSERT INTO tags(name, created_at) VALUES(?,?)", (name, now))
        return int(cur.lastrowid)


def list_tags() -> List[Dict[str, Any]]:
    conn = get_conn()
    cur = conn.execute("SELECT id, name, color, created_at FROM tags ORDER BY name ASC")
    return list(cur.fetchall())


def create_tag(name: str, color: Optional[str] = None) -> Dict[str, Any]:
    tid = get_or_create_tag_id(name)
    if color is not None:
        with get_conn():
            get_conn().execute("UPDATE tags SET color=? WHERE id=?", (color, tid))
    cur = get_conn().execute("SELECT id, name, color, created_at FROM tags WHERE id=?", (tid,))
    return cur.fetchone()


def update_tag(tag_id: int, name: Optional[str] = None, color: Optional[str] = None) -> Dict[str, Any]:
    if name is None and color is None:
        cur = get_conn().execute("SELECT id, name, color, created_at FROM tags WHERE id=?", (tag_id,))
        row = cur.fetchone()
        if not row:
            raise KeyError("tag not found")
        return row
    sets = []
    args: List[Any] = []
    if name is not None:
        sets.append("name=?")
        args.append(name.strip().lower())
    if color is not None:
        sets.append("color=?")
        args.append(color)
    args.append(tag_id)
    with get_conn():
        get_conn().execute(f"UPDATE tags SET {', '.join(sets)} WHERE id=?", args)
    cur = get_conn().execute("SELECT id, name, color, created_at FROM tags WHERE id=?", (tag_id,))
    row = cur.fetchone()
    if not row:
        raise KeyError("tag not found")
    return row


def delete_tag(tag_id: int) -> None:
    with get_conn():
        get_conn().execute("DELETE FROM tags WHERE id=?", (tag_id,))


# --- Model helpers ---

def upsert_model(*, path: str, dir_path: str, name: str, type_: str, size_bytes: int, mtime_ns: int,
                 hash_algo: str, hash_hex: str, created_at_ms: int, meta_json: Optional[str] = None) -> int:
    if type_ not in SYSTEM_TAGS:
        type_ = "other"
    conn = get_conn()
    now = int(time.time() * 1000)
    with conn:
        # try update by path
        cur = conn.execute(
            "UPDATE models SET dir_path=?, name=?, type=?, size_bytes=?, mtime_ns=?, hash_algo=?, hash_hex=?, updated_at=?, meta_json=? WHERE path=?",
            (dir_path, name, type_, size_bytes, mtime_ns, hash_algo, hash_hex, now, meta_json, path),
        )
        if cur.rowcount == 0:
            cur = conn.execute(
                "INSERT INTO models(path, dir_path, name, type, size_bytes, mtime_ns, hash_algo, hash_hex, created_at, updated_at, meta_json)\n                 VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (path, dir_path, name, type_, size_bytes, mtime_ns, hash_algo, hash_hex, created_at_ms, now, meta_json),
            )
            model_id = int(cur.lastrowid)
        else:
            # fetch id
            cur = conn.execute("SELECT id FROM models WHERE path=?", (path,))
            model_id = int(cur.fetchone()["id"])
        # ensure type tag attached
        type_tag_id = get_or_create_tag_id(type_)
        conn.execute("INSERT OR IGNORE INTO model_tags(model_id, tag_id) VALUES(?,?)", (model_id, type_tag_id))
        # remove other system type tags if any (keep only current type)
        if SYSTEM_TAGS:
            placeholders = ",".join(["?"] * len(SYSTEM_TAGS))
            conn.execute(
                f"DELETE FROM model_tags WHERE model_id=? AND tag_id IN (SELECT id FROM tags WHERE name IN ({placeholders}) AND name <> ?)",
                (model_id, *SYSTEM_TAGS, type_),
            )
    return model_id


def set_model_tags(model_id: int, add_names: Iterable[str] = (), remove_names: Iterable[str] = (), ensure_type: Optional[str] = None) -> List[str]:
    conn = get_conn()
    add_ids = [get_or_create_tag_id(n) for n in add_names]
    remove_ids = []
    for n in remove_names:
        n1 = n.strip().lower()
        if ensure_type and n1 == ensure_type:
            raise ValueError("cannot remove system type tag")
        # resolve id if exists
        cur = conn.execute("SELECT id FROM tags WHERE name=?", (n1,))
        row = cur.fetchone()
        if row:
            remove_ids.append(int(row["id"]))
    with conn:
        for tid in add_ids:
            conn.execute("INSERT OR IGNORE INTO model_tags(model_id, tag_id) VALUES(?,?)", (model_id, tid))
        for tid in remove_ids:
            conn.execute("DELETE FROM model_tags WHERE model_id=? AND tag_id=?", (model_id, tid))
        # ensure type tag present
        if ensure_type:
            type_tid = get_or_create_tag_id(ensure_type)
            conn.execute("INSERT OR IGNORE INTO model_tags(model_id, tag_id) VALUES(?,?)", (model_id, type_tid))
        # return names
        cur = conn.execute(
            "SELECT t.name FROM model_tags mt JOIN tags t ON mt.tag_id=t.id WHERE mt.model_id=? ORDER BY t.name",
            (model_id,),
        )
        return [r["name"] for r in cur.fetchall()]


def get_model_by_id(model_id: int) -> Optional[Dict[str, Any]]:
    conn = get_conn()
    cur = conn.execute("SELECT * FROM models WHERE id=?", (model_id,))
    row = cur.fetchone()
    return row


def list_model_tags(model_id: int) -> List[str]:
    cur = get_conn().execute(
        "SELECT t.name FROM model_tags mt JOIN tags t ON mt.tag_id=t.id WHERE mt.model_id=? ORDER BY t.name",
        (model_id,),
    )
    return [r["name"] for r in cur.fetchall()]


def query_models(*, q: Optional[str] = None, type_: Optional[str] = None, dir_path: Optional[str] = None,
                 tags: Optional[List[str]] = None, tags_mode: Literal['all', 'any'] = 'all',
                 limit: int = 50, offset: int = 0, sort: str = 'created', order: Literal['asc', 'desc'] = 'desc') -> Tuple[List[Dict[str, Any]], int]:
    conn = get_conn()
    where = []
    args: List[Any] = []
    if q:
        where.append("(name LIKE ? OR path LIKE ?)")
        like = f"%{q}%"
        args.extend([like, like])
    if type_:
        where.append("type=?")
        args.append(type_)
    if dir_path:
        where.append("dir_path=?")
        args.append(dir_path)

    base_sql = "SELECT m.* FROM models m"
    count_sql = "SELECT COUNT(1) AS c FROM models m"

    if tags:
        # normalize tags
        tags = [t.strip().lower() for t in tags if t and t.strip()]
        if tags:
            if tags_mode == 'all':
                # join per tag and ensure count match
                idx = 0
                join_sql = ""
                for t in tags:
                    idx += 1
                    alias = f"mt{idx}"
                    join_sql += f" JOIN model_tags {alias} ON {alias}.model_id=m.id JOIN tags t{idx} ON {alias}.tag_id=t{idx}.id AND t{idx}.name=?"
                    args.append(t)
                base_sql += join_sql
                count_sql += join_sql
            else:
                # any: IN subquery
                placeholders = ",".join(["?"] * len(tags))
                base_sql += f" WHERE EXISTS (SELECT 1 FROM model_tags mt JOIN tags t ON mt.tag_id=t.id WHERE mt.model_id=m.id AND t.name IN ({placeholders}))"
                count_sql += f" WHERE EXISTS (SELECT 1 FROM model_tags mt JOIN tags t ON mt.tag_id=t.id WHERE mt.model_id=m.id AND t.name IN ({placeholders}))"
                args.extend(tags)

    if where:
        base_sql += (" WHERE " if " WHERE " not in base_sql else " AND ") + " AND ".join(where)
        count_sql += (" WHERE " if " WHERE " not in count_sql else " AND ") + " AND ".join(where)

    # sort mapping
    sort_map = {
        'created': 'created_at',
        'name': 'name',
        'mtime': 'mtime_ns',
        'size': 'size_bytes',
        'type': 'type',
    }
    order_col = sort_map.get(sort, 'created_at')
    order_dir = 'ASC' if order.lower() == 'asc' else 'DESC'

    base_sql += f" ORDER BY {order_col} {order_dir} LIMIT ? OFFSET ?"
    args.extend([int(limit), int(offset)])

    cur = conn.execute(base_sql, tuple(args))
    items = list(cur.fetchall())

    cur2 = conn.execute(count_sql, tuple(args[:-2])) if len(args) >= 2 else conn.execute(count_sql)
    total = int(cur2.fetchone()["c"]) if cur2 else 0

    return items, total


# --- New: Tag queries by type and facets ---

def list_tags_by_type(type_: str) -> List[str]:
    """List distinct tags that are attached to models of given type, excluding the type tag itself."""
    conn = get_conn()
    cur = conn.execute(
        """
        SELECT DISTINCT t.name AS name
        FROM models m
        JOIN model_tags mt ON mt.model_id = m.id
        JOIN tags t ON t.id = mt.tag_id
        WHERE m.type = ? AND t.name <> ?
        ORDER BY t.name ASC
        """,
        (type_, type_),
    )
    return [r["name"] for r in cur.fetchall()]


def tag_facets(*, type_: Optional[str] = None, q: Optional[str] = None, selected: Optional[List[str]] = None,
               mode: Literal['all', 'any'] = 'all') -> List[Dict[str, Any]]:
    """Return tag counts under current filters. Excludes system type tag when type_ specified.
    Output: [{"name": str, "count": int}]
    """
    conn = get_conn()
    filters = []
    args: List[Any] = []
    if type_:
        filters.append("m.type = ?")
        args.append(type_)
    if q:
        filters.append("(m.name LIKE ? OR m.path LIKE ?)")
        like = f"%{q}%"
        args.extend([like, like])

    # Build selected-tags constraint
    join_selected = ""
    if selected:
        selected = [t.strip().lower() for t in selected if t and t.strip()]
        if selected:
            if mode == 'all':
                idx = 0
                for tname in selected:
                    idx += 1
                    alias = f"smt{idx}"
                    join_selected += f" JOIN model_tags {alias} ON {alias}.model_id=m.id JOIN tags st{idx} ON {alias}.tag_id=st{idx}.id AND st{idx}.name=?"
                    args.append(tname)
            else:
                placeholders = ",".join(["?"] * len(selected))
                filters.append(f"EXISTS (SELECT 1 FROM model_tags smt JOIN tags st ON smt.tag_id=st.id WHERE smt.model_id=m.id AND st.name IN ({placeholders}))")
                args.extend(selected)

    where_sql = (" WHERE " + " AND ".join(filters)) if filters else ""

    sql = f"""
        SELECT t.name AS name, COUNT(1) AS cnt
        FROM (
            SELECT m.id AS id
            FROM models m
            {join_selected}
            {where_sql}
        ) AS sub
        JOIN model_tags mt ON mt.model_id = sub.id
        JOIN tags t ON t.id = mt.tag_id
        {{exclude_type}}
        GROUP BY t.name
        ORDER BY t.name ASC
    """

    exclude_type_clause = ""
    if type_:
        exclude_type_clause = "WHERE t.name <> ?"
        args2 = tuple(args) + (type_,)
    else:
        args2 = tuple(args)

    cur = conn.execute(sql.replace("{exclude_type}", exclude_type_clause), args2)
    return [{"name": r["name"], "count": int(r["cnt"]) } for r in cur.fetchall()]


def types_with_counts() -> List[Dict[str, Any]]:
    """Return available model types with counts."""
    conn = get_conn()
    cur = conn.execute("SELECT type AS name, COUNT(1) AS cnt FROM models GROUP BY type ORDER BY name ASC")
    rows = list(cur.fetchall())
    # Ensure all SYSTEM_TAGS present with zero count if absent
    existing = {r["name"] for r in rows}
    for t in sorted(SYSTEM_TAGS):
        if t not in existing:
            rows.append({"name": t, "cnt": 0})
    # sort again by name
    rows = sorted(rows, key=lambda r: r["name"])  # type: ignore
    return [{"name": r["name"], "count": int(r["cnt"]) } for r in rows]
