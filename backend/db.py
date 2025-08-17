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

-- v2: 精简 models 结构，移除 dir_path/mtime_ns/updated_at/hash_algo
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  name TEXT,
  type TEXT NOT NULL,
  size_bytes INTEGER,
  hash_hex TEXT NOT NULL,
  created_at INTEGER NOT NULL,
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


def _ensure_schema_v2(conn: sqlite3.Connection) -> None:
    # 读取已有版本
    try:
        cur = conn.execute("SELECT version FROM schema_version LIMIT 1")
        row = cur.fetchone()
        ver = int(row["version"]) if row and row.get("version") is not None else None
    except sqlite3.Error:
        ver = None
    # 检查 models 列是否符合 v2
    def _is_v2() -> bool:
        try:
            cur2 = conn.execute("PRAGMA table_info(models)")
            cols = [r["name"] for r in cur2.fetchall()]
            expected = ["id","path","name","type","size_bytes","hash_hex","created_at","meta_json","extra_json"]
            return cols and cols == expected
        except sqlite3.Error:
            return False
    ok = (ver == 2) and _is_v2()
    if ok:
        return
    # 丢弃旧表重建（开发阶段数据无价值）
    try:
        conn.executescript(
            """
            DROP TABLE IF EXISTS model_tags;
            DROP TABLE IF EXISTS tags;
            DROP TABLE IF EXISTS models;
            DROP TABLE IF EXISTS directories;
            DROP TABLE IF EXISTS schema_version;
            """
        )
    except sqlite3.Error:
        pass
    conn.executescript(SCHEMA_SQL)
    conn.execute("INSERT INTO schema_version(version) VALUES (?)", (2,))


def init_db() -> None:
    conn = get_conn()
    with conn:
        _ensure_schema_v2(conn)
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

def upsert_model(*, path: str, name: str, type_: str, size_bytes: int,
                 hash_hex: str, created_at_ms: int, meta_json: Optional[str] = None) -> int:
    # 放宽：允许任意类型字符串（来自 models 根一级子目录）；无法判定时上游应传 'other'
    conn = get_conn()
    now = int(time.time() * 1000)
    with conn:
        # 预取旧记录
        cur = conn.execute("SELECT id, type FROM models WHERE path=?", (path,))
        row = cur.fetchone()
        old_id = int(row["id"]) if row else None
        old_type = row["type"] if row else None
        if row:
            conn.execute(
                "UPDATE models SET name=?, type=?, size_bytes=?, hash_hex=?, meta_json=? WHERE id=?",
                (name, type_, size_bytes, hash_hex, meta_json, old_id),
            )
            model_id = old_id
        else:
            cur2 = conn.execute(
                "INSERT INTO models(path, name, type, size_bytes, hash_hex, created_at, meta_json, extra_json)\n                 VALUES(?,?,?,?,?,?,?,?)",
                (path, name, type_, size_bytes, hash_hex, created_at_ms, meta_json, None),
            )
            model_id = int(cur2.lastrowid)
            old_type = None
        # 确保新类型标签存在
        type_tag_id = get_or_create_tag_id(type_)
        conn.execute("INSERT OR IGNORE INTO model_tags(model_id, tag_id) VALUES(?,?)", (model_id, type_tag_id))
        # 如果旧类型不同，移除旧类型标签（避免误删其它用户标签）
        if old_type and old_type != type_:
            conn.execute(
                "DELETE FROM model_tags WHERE model_id=? AND tag_id IN (SELECT id FROM tags WHERE name=?)",
                (model_id, old_type),
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


def get_model_by_path(path: str) -> Optional[Dict[str, Any]]:
    conn = get_conn()
    cur = conn.execute("SELECT * FROM models WHERE path=?", (path,))
    return cur.fetchone()


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
        where.append("(m.name LIKE ? OR m.path LIKE ?)")
        like = f"%{q}%"
        args.extend([like, like])
    if type_:
        where.append("m.type=?")
        args.append(type_)
    # v2: 不再支持按 dir_path 过滤（字段已移除）

    base_sql = "SELECT m.* FROM models m"
    count_sql = "SELECT COUNT(1) AS c FROM models m"

    # 标签过滤：统一使用 EXISTS 子查询，避免多 JOIN 组合引起的意外空结果
    if tags:
        tags = [t.strip().lower() for t in tags if t and t.strip()]
        if tags:
            if tags_mode == 'all':
                for t in tags:
                    where.append("EXISTS (SELECT 1 FROM model_tags mt JOIN tags tg ON mt.tag_id=tg.id WHERE mt.model_id=m.id AND tg.name=?)")
                    args.append(t)
            else:  # any
                placeholders = ",".join(["?"] * len(tags))
                where.append(f"EXISTS (SELECT 1 FROM model_tags mt JOIN tags tg ON mt.tag_id=tg.id WHERE mt.model_id=m.id AND tg.name IN ({placeholders}))")
                args.extend(tags)

    if where:
        base_sql += " WHERE " + " AND ".join(where)
        count_sql += " WHERE " + " AND ".join(where)

    # sort mapping（v2: mtime 映射到 created_at）
    sort_map = {
        'created': 'm.created_at',
        'name': 'm.name',
        'mtime': 'm.created_at',
        'size': 'm.size_bytes',
        'type': 'm.type',
    }
    order_col = sort_map.get(sort, 'm.created_at')
    order_dir = 'ASC' if order.lower() == 'asc' else 'DESC'

    base_sql += f" ORDER BY {order_col} {order_dir} LIMIT ? OFFSET ?"
    args_with_page = list(args) + [int(limit), int(offset)]

    cur = conn.execute(base_sql, tuple(args_with_page))
    items = list(cur.fetchall())

    cur2 = conn.execute(count_sql, tuple(args))
    total = int(cur2.fetchone()["c"]) if cur2 else 0

    return items, total


# --- New: Tag queries by type and facets ---

def types_with_counts() -> List[Dict[str, Any]]:
    """Return available model types with counts (no zero-fill)."""
    conn = get_conn()
    cur = conn.execute("SELECT type AS name, COUNT(1) AS cnt FROM models GROUP BY type ORDER BY name ASC")
    rows = list(cur.fetchall())
    return [{"name": r["name"], "count": int(r["cnt"]) } for r in rows]


def _first_level_dir(path: str, roots: List[str]) -> str:
    apath = os.path.abspath(path)
    for r in roots:
        rabs = os.path.abspath(r)
        try:
            common = os.path.commonpath([os.path.normcase(rabs), os.path.normcase(apath)])
        except Exception:
            continue
        if common == os.path.normcase(rabs):
            rel = os.path.relpath(apath, rabs)
            parts = [p for p in rel.replace('\\','/').split('/') if p and p not in ('.','..')]
            if parts:
                return parts[0].strip().lower()
    return 'other'


def migrate_types_by_roots(model_roots: List[str]) -> int:
    """Recompute model type by first-level dir under provided roots; update tags accordingly. Return updated count."""
    if not model_roots:
        return 0
    roots = [os.path.abspath(p) for p in model_roots if isinstance(p, str) and os.path.isdir(p)]
    if not roots:
        return 0
    conn = get_conn()
    cur = conn.execute("SELECT id, path, type FROM models")
    rows = list(cur.fetchall())
    updated = 0
    now = int(time.time() * 1000)
    with conn:
        for row in rows:
            mid = int(row['id'])
            old_path = row['path']
            old_type = row['type']
            new_type = _first_level_dir(old_path, roots)
            if new_type != old_type:
                conn.execute("UPDATE models SET type=? WHERE id=?", (new_type, mid))
                # 更新标签：移除旧类型，添加新类型
                if old_type:
                    conn.execute("DELETE FROM model_tags WHERE model_id=? AND tag_id IN (SELECT id FROM tags WHERE name=?)", (mid, old_type))
                new_type_tid = get_or_create_tag_id(new_type)
                conn.execute("INSERT OR IGNORE INTO model_tags(model_id, tag_id) VALUES(?,?)", (mid, new_type_tid))
                updated += 1
    return updated


def list_tags_by_type(type_: str) -> List[Dict[str, Any]]:
    """List tags used by models of given type, excluding the type tag itself."""
    conn = get_conn()
    cur = conn.execute("""
        SELECT t.id, t.name, t.color, COUNT(DISTINCT mt.model_id) AS count
        FROM tags t
        JOIN model_tags mt ON t.id = mt.tag_id
        JOIN models m ON mt.model_id = m.id
        WHERE m.type = ? AND t.name != ?
        GROUP BY t.id, t.name, t.color
        ORDER BY count DESC, t.name ASC
    """, (type_, type_))
    return [{"id": r["id"], "name": r["name"], "color": r["color"], "count": r["count"]} for r in cur.fetchall()]


def tag_facets(*, type_: Optional[str] = None, q: Optional[str] = None,
               selected: Optional[List[str]] = None, mode: Literal['all', 'any'] = 'all') -> List[Dict[str, Any]]:
    """Return tag facets for current filter."""
    conn = get_conn()

    # 构建基础查询
    base_where = []
    args = []

    if type_:
        base_where.append("m.type = ?")
        args.append(type_)

    if q:
        base_where.append("(m.name LIKE ? OR m.path LIKE ?)")
        like = f"%{q}%"
        args.extend([like, like])

    # 处理已选择的标签
    if selected:
        selected = [t.strip().lower() for t in selected if t and t.strip()]
        if selected:
            if mode == 'all':
                # 所有选中标签都必须存在
                for i, tag in enumerate(selected):
                    alias = f"mt_sel_{i}"
                    base_where.append(f"""
                        EXISTS (
                            SELECT 1 FROM model_tags {alias} 
                            JOIN tags t_sel_{i} ON {alias}.tag_id = t_sel_{i}.id 
                            WHERE {alias}.model_id = m.id AND t_sel_{i}.name = ?
                        )
                    """)
                    args.append(tag)
            else:
                # 任一选中标签存在即可
                placeholders = ",".join(["?"] * len(selected))
                base_where.append(f"""
                    EXISTS (
                        SELECT 1 FROM model_tags mt_sel 
                        JOIN tags t_sel ON mt_sel.tag_id = t_sel.id 
                        WHERE mt_sel.model_id = m.id AND t_sel.name IN ({placeholders})
                    )
                """)
                args.extend(selected)

    where_clause = " AND ".join(base_where) if base_where else "1=1"

    # 查询标签计数
    sql = f"""
        SELECT t.id, t.name, t.color, COUNT(DISTINCT m.id) AS count
        FROM tags t
        JOIN model_tags mt ON t.id = mt.tag_id
        JOIN models m ON mt.model_id = m.id
        WHERE {where_clause}
        GROUP BY t.id, t.name, t.color
        HAVING count > 0
        ORDER BY count DESC, t.name ASC
    """

    cur = conn.execute(sql, args)
    return [{"id": r["id"], "name": r["name"], "color": r["color"], "count": r["count"]} for r in cur.fetchall()]


def list_tags() -> List[Dict[str, Any]]:
    """List all tags with their usage counts."""
    conn = get_conn()
    cur = conn.execute("""
        SELECT t.id, t.name, t.color, t.created_at, COUNT(mt.model_id) AS count
        FROM tags t
        LEFT JOIN model_tags mt ON t.id = mt.tag_id
        GROUP BY t.id, t.name, t.color, t.created_at
        ORDER BY t.name ASC
    """)
    return [{"id": r["id"], "name": r["name"], "color": r["color"],
             "created_at": r["created_at"], "count": r["count"]} for r in cur.fetchall()]


def create_tag(name: str, color: Optional[str] = None) -> Dict[str, Any]:
    """Create a new tag."""
    name = name.strip().lower()
    if not name:
        raise ValueError("Tag name cannot be empty")

    conn = get_conn()
    now = int(time.time() * 1000)

    with conn:
        # 检查是否已存在
        cur = conn.execute("SELECT * FROM tags WHERE name = ?", (name,))
        existing = cur.fetchone()
        if existing:
            raise ValueError(f"Tag '{name}' already exists")

        # 创建新标签
        cur = conn.execute(
            "INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)",
            (name, color, now)
        )
        tag_id = cur.lastrowid

        # 返回创建的标签
        cur = conn.execute("SELECT * FROM tags WHERE id = ?", (tag_id,))
        return dict(cur.fetchone())


def update_tag(tag_id: int, name: Optional[str] = None, color: Optional[str] = None) -> Dict[str, Any]:
    """Update an existing tag."""
    conn = get_conn()

    with conn:
        # 检查标签是否存在
        cur = conn.execute("SELECT * FROM tags WHERE id = ?", (tag_id,))
        existing = cur.fetchone()
        if not existing:
            raise KeyError(f"Tag with id {tag_id} not found")

        # 更新字段
        updates = []
        args = []

        if name is not None:
            name = name.strip().lower()
            if not name:
                raise ValueError("Tag name cannot be empty")
            updates.append("name = ?")
            args.append(name)

        if color is not None:
            updates.append("color = ?")
            args.append(color)

        if updates:
            sql = f"UPDATE tags SET {', '.join(updates)} WHERE id = ?"
            args.append(tag_id)
            conn.execute(sql, args)

        # 返回更新后的标签
        cur = conn.execute("SELECT * FROM tags WHERE id = ?", (tag_id,))
        return dict(cur.fetchone())


def delete_tag(tag_id: int) -> None:
    """Delete a tag and all its associations."""
    conn = get_conn()

    with conn:
        # 检查标签是否存在
        cur = conn.execute("SELECT name FROM tags WHERE id = ?", (tag_id,))
        row = cur.fetchone()
        if not row:
            raise KeyError(f"Tag with id {tag_id} not found")

        # 检查是否为系统标签
        tag_name = row["name"]
        if tag_name in SYSTEM_TAGS:
            raise ValueError(f"Cannot delete system tag '{tag_name}'")

        # 删除关联和标签本身
        conn.execute("DELETE FROM model_tags WHERE tag_id = ?", (tag_id,))
        conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
