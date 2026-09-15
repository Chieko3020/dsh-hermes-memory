#!/usr/bin/env python3
"""DSH→Hermes memory write-back store — protocol-compatible with Hermes MemoryStore.

Reads a JSON request on stdin, writes the memory file under the same
fcntl.flock lock + atomic-rename protocol as Hermes
(/usr/local/lib/hermes-agent/tools/memory_tool.py), and returns a JSON
response on stdout. Self-contained: no import from the Hermes package.

Request shape (JSON on stdin):
    {"target": "memory"|"user",
     "action": "add"|"replace"|"remove",
     "content": str, "old_text": str}
  or batch shape:
    {"target": ..., "operations": [{"action","content","old_text"}, ...]}

Response shape mirrors Hermes memory_tool responses exactly:
    {"success": bool, "done": bool, "target": str, "usage": str,
     "entry_count": int, "note": str, ...}
  or on failure: {"success": false, "error": str, "current_entries": [...], ...}

Format contract (must stay in lockstep with Hermes):
  - entries joined by "\n§\n" (ENTRY_DELIMITER), each stripped, non-empty kept
  - .lock file + fcntl.flock(LOCK_EX) for cross-process mutual exclusion
  - atomic write via temp file + os.replace (readers never see a partial file)
  - drift guard on replace/remove/batch: if on-disk content wouldn't
    round-trip (§-join of parsed entries == raw) or any single entry exceeds
    the char limit, refuse the mutation and save a .bak.<ts> snapshot
  - char limits: memory 2200 / user 1375 (whole-file budget)
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import sys
import tempfile
import time
import unicodedata
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ── Paths & limits ────────────────────────────────────────────────────────
# Allow HERMES_MEMORIES_DIR override for tests / non-default home, matching
# the DSH plugin side (dsh-hermes-memory/lib/index.js).
MEMORIES_DIR = Path(os.environ.get("HERMES_MEMORIES_DIR", Path.home() / ".hermes" / "memories"))
ENTRY_DELIMITER = "\n§\n"
FILES = {"memory": "MEMORY.md", "user": "USER.md"}
CHAR_LIMITS = {"memory": 2200, "user": 1375}

# ── Threat scan (copied from Hermes tools/threat_patterns.py, MIT) ───────
# Hard cap on scanned text; bounded filler prevents regex backtracking.
MAX_SCAN_CHARS = 65_536
_FILLER = r"(?:\w+\s+){0,8}"

_PATTERNS: List[Tuple[str, str]] = [
    (rf'ignore\s+{_FILLER}(previous|all|above|prior)\s+{_FILLER}instructions', "prompt_injection"),
    (r'system\s+prompt\s+override', "sys_prompt_override"),
    (rf'disregard\s+{_FILLER}(your|all|any)\s+{_FILLER}(instructions|rules|guidelines)', "disregard_rules"),
    (rf'act\s+as\s+(if|though)\s+{_FILLER}you\s+{_FILLER}(have\s+no|don\'t\s+have)\s+{_FILLER}(restrictions|limits|rules)', "bypass_restrictions"),
    (r'<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->', "html_comment_injection"),
    (r'<\s*div\s+style\s*=\s*["\'][^>]{0,2048}display\s*:\s*none', "hidden_div"),
    (r'translate\s+[^\n]{0,512}\s+into\s+[^\n]{0,512}\s+and\s+(execute|run|eval)', "translate_execute"),
    (rf'do\s+not\s+{_FILLER}tell\s+{_FILLER}the\s+user', "deception_hide"),
    (rf'you\s+are\s+{_FILLER}now\s+(?:a|an|the)\s+', "role_hijack"),
    (rf'pretend\s+{_FILLER}(you\s+are|to\s+be)\s+', "role_pretend"),
    (rf'output\s+{_FILLER}(system|initial)\s+prompt', "leak_system_prompt"),
    (rf'(respond|answer|reply)\s+without\s+{_FILLER}(restrictions|limitations|filters|safety)', "remove_filters"),
    (rf'you\s+have\s+been\s+{_FILLER}(updated|upgraded|patched)\s+to', "fake_update"),
    (r'\bname\s+yourself\s+\w+', "identity_override"),
    (r'register\s+(as\s+)?a?\s*node', "c2_node_registration"),
    (r'(heartbeat|beacon|check[\s\-]?in)\s+(to|with)\s+', "c2_heartbeat"),
    (r'pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b', "c2_task_pull"),
    (r'connect\s+to\s+the\s+network\b', "c2_network_connect"),
    (rf'you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b', "forced_action"),
    (r'only\s+use\s+one[\s\-]?liners?\b', "anti_forensic_oneliner"),
    (rf'never\s+{_FILLER}(?:create|write)\s+{_FILLER}(?:script|file)\s+{_FILLER}disk', "anti_forensic_disk"),
    (r'unset\s+\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC)\w*', "env_var_unset_agent"),
    (r'\b(?:cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b', "known_c2_framework"),
    (r'\bc2\s+(?:server|channel|infrastructure|beacon)\b', "c2_explicit"),
    (r'\bcommand\s+and\s+control\b', "c2_explicit_long"),
    (r'curl\s+[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)', "exfil_curl"),
    (r'wget\s+[^\n]{0,2048}\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)', "exfil_wget"),
    (r'cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)', "read_secrets"),
    (r'(send|post|upload|transmit)\s+[^\n]{0,2048}\s+(to|at)\s+https?://', "send_to_url"),
    (rf'(include|output|print|share)\s+{_FILLER}(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)', "context_exfil"),
    (r'authorized_keys', "ssh_backdoor"),
    (r'\$HOME/\.ssh|\~/\.ssh', "ssh_access"),
    (r'\$HOME/\.hermes/\.env|\~/\.hermes/\.env', "hermes_env"),
    (r'(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)', "agent_config_mod"),
    (r'(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}\.hermes/(config\.yaml|SOUL\.md)', "hermes_config_mod"),
    (r'(?:api[_-]?key|token|secret|password)\s*[=:]\s*["\'][A-Za-z0-9+/=_-]{20,}', "hardcoded_secret"),
]

INVISIBLE_CHARS = frozenset({
    '\u200b', '\u200c', '\u200d', '\u2060', '\u2062', '\u2063', '\u2064',
    '\ufeff', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
    '\u2066', '\u2067', '\u2068', '\u2069',
})

_COMPILED: List[Tuple[re.Pattern, str]] = [
    (re.compile(pattern, re.IGNORECASE), pid) for pattern, pid in _PATTERNS
]


def first_threat_message(content: str) -> Optional[str]:
    """Return a human-readable error string for the first threat found, or None."""
    if not content:
        return None
    findings: List[str] = []
    content = content[:MAX_SCAN_CHARS]

    char_set = set(content)
    invisible_hits = char_set & INVISIBLE_CHARS
    for ch in invisible_hits:
        findings.append(f"invisible_unicode_U+{ord(ch):04X}")

    normalised = unicodedata.normalize("NFKC", content)
    for compiled, pid in _COMPILED:
        if compiled.search(normalised):
            findings.append(pid)

    if not findings:
        return None
    pid = findings[0]
    if pid.startswith("invisible_unicode_"):
        codepoint = pid.replace("invisible_unicode_", "")
        return f"Blocked: content contains invisible unicode character {codepoint} (possible injection)."
    return (
        f"Blocked: content matches threat pattern '{pid}'. "
        f"Content is injected into the system prompt and must not contain "
        f"injection or exfiltration payloads."
    )


# ── File primitives (lockstep with Hermes MemoryStore) ────────────────────
@contextmanager
def _file_lock(path: Path):
    """Exclusive lock via a sibling .lock file (fcntl.flock on Unix)."""
    lock_path = path.with_suffix(path.suffix + ".lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = open(lock_path, "a+", encoding="utf-8")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except (OSError, IOError):
            pass
        fd.close()


def _read_file(path: Path) -> List[str]:
    """Read a memory file and split into entries (no locking needed for reads)."""
    if not path.exists():
        return []
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, IOError):
        return []
    if not raw.strip():
        return []
    entries = [e.strip() for e in raw.split(ENTRY_DELIMITER)]
    return [e for e in entries if e]


def _detect_external_drift(path: Path, char_limit: int) -> Optional[str]:
    """Return .bak path if on-disk content shows external drift, else None.

    Signals: round-trip mismatch (re-serialising parsed entries != raw) or
    a single parsed entry exceeding the whole-file char limit (an external
    writer appended free-form content that the tool would treat as one
    entry — flushing would truncate it; issue #26045).
    """
    if not path.exists():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, IOError):
        return None
    if not raw.strip():
        return None

    parsed = [e.strip() for e in raw.split(ENTRY_DELIMITER) if e.strip()]
    roundtrip = ENTRY_DELIMITER.join(parsed)
    max_entry_len = max((len(e) for e in parsed), default=0)
    drift_detected = (raw.strip() != roundtrip) or (max_entry_len > char_limit)
    if not drift_detected:
        return None

    ts = int(time.time())
    bak_path = path.with_suffix(path.suffix + f".bak.{ts}")
    try:
        bak_path.write_text(raw, encoding="utf-8")
    except (OSError, IOError):
        return str(bak_path) + " (BACKUP FAILED — file unchanged on disk)"
    return str(bak_path)


def _write_file(path: Path, entries: List[str]) -> None:
    """Write entries via temp file + atomic rename (readers see full file)."""
    content = ENTRY_DELIMITER.join(entries) if entries else ""
    fd, tmp_path = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp", prefix=".mem_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ── Response builders (mirror Hermes) ─────────────────────────────────────
def _success(target: str, message: str = None, entry_count: int = 0) -> Dict[str, Any]:
    current = _char_count(target)
    limit = CHAR_LIMITS[target]
    pct = min(100, int((current / limit) * 100)) if limit > 0 else 0
    resp = {
        "success": True,
        "done": True,
        "target": target,
        "usage": f"{pct}% — {current:,}/{limit:,} chars",
        "entry_count": entry_count,
    }
    if message:
        resp["message"] = message
    resp["note"] = "Write saved. This update is complete — do not repeat it."
    return resp


def _error(target: str, error: str, entries: Optional[List[str]] = None) -> Dict[str, Any]:
    resp = {"success": False, "error": error}
    if entries is not None:
        resp["current_entries"] = entries
        resp["usage"] = f"{_char_count(target):,}/{CHAR_LIMITS[target]:,}"
    return resp


def _drift_error(path: Path, bak_path: str) -> Dict[str, Any]:
    return {
        "success": False,
        "error": (
            f"Refusing to write {path.name}: file on disk has content that "
            f"wouldn't round-trip through the memory tool (likely added by "
            f"the patch tool, a shell append, a manual edit, or a "
            f"concurrent session). A snapshot was saved to {bak_path}. "
            f"Resolve the drift first — either rewrite the file as a clean "
            f"§-delimited list of entries, or move the extra content out — "
            f"then retry. This guard exists to prevent silent data loss "
            f"(issue #26045)."
        ),
        "drift_backup": bak_path,
        "remediation": (
            "Open the .bak file, integrate the missing entries into the "
            "memory tool one at a time via memory(action=add, content=...), "
            "then remove or rewrite the original file to a clean state."
        ),
    }


def _char_count(target: str) -> int:
    entries = _read_file(_path_for(target))
    if not entries:
        return 0
    return len(ENTRY_DELIMITER.join(entries))


def _path_for(target: str) -> Path:
    return MEMORIES_DIR / FILES[target]


def _previews(entries: List[str], width: int = 80) -> List[str]:
    return [e[:width] + ("..." if len(e) > width else "") for e in entries]


# ── Operations (lockstep with Hermes MemoryStore) ─────────────────────────
def _do_add(target: str, content: str) -> Dict[str, Any]:
    content = content.strip()
    if not content:
        return _error(target, "Content cannot be empty.")
    scan_error = first_threat_message(content)
    if scan_error:
        return _error(target, scan_error)

    path = _path_for(target)
    limit = CHAR_LIMITS[target]
    with _file_lock(path):
        # add is append-only: skip the drift guard (never clobbers existing).
        entries = _read_file(path)
        if content in entries:
            return _success(target, "Entry already exists (no duplicate added).", len(entries))

        new_entries = entries + [content]
        new_total = len(ENTRY_DELIMITER.join(new_entries))
        if new_total > limit:
            current = _char_count(target)
            return {
                "success": False,
                "error": (
                    f"Memory at {current:,}/{limit:,} chars. "
                    f"Adding this entry ({len(content)} chars) would exceed the limit. "
                    f"Consolidate now: use 'replace' to merge overlapping entries into "
                    f"shorter ones or 'remove' stale or less important entries (see "
                    f"current_entries below), then retry this add — all in this turn."
                ),
                "current_entries": entries,
                "usage": f"{current:,}/{limit:,}",
            }

        _write_file(path, new_entries)
    return _success(target, "Entry added.", len(new_entries))


def _do_replace(target: str, old_text: str, new_content: str) -> Dict[str, Any]:
    old_text = old_text.strip()
    new_content = new_content.strip()
    if not old_text:
        return _error(target, "old_text cannot be empty.")
    if not new_content:
        return _error(target, "new_content cannot be empty. Use 'remove' to delete entries.")
    scan_error = first_threat_message(new_content)
    if scan_error:
        return _error(target, scan_error)

    path = _path_for(target)
    limit = CHAR_LIMITS[target]
    with _file_lock(path):
        bak = _detect_external_drift(path, limit)
        if bak:
            return _drift_error(path, bak)

        entries = _read_file(path)
        matches = [(i, e) for i, e in enumerate(entries) if old_text in e]
        if not matches:
            return {
                "success": False,
                "error": f"No entry matched '{old_text}'. Check current_entries below and retry with the exact text of the entry you want to replace.",
                "current_entries": entries,
            }
        if len(matches) > 1:
            unique_texts = {e for _, e in matches}
            if len(unique_texts) > 1:
                return {
                    "success": False,
                    "error": f"Multiple entries matched '{old_text}'. Be more specific.",
                    "matches": _previews([e for _, e in matches]),
                }

        idx = matches[0][0]
        test_entries = entries.copy()
        test_entries[idx] = new_content
        new_total = len(ENTRY_DELIMITER.join(test_entries))
        if new_total > limit:
            current = _char_count(target)
            return {
                "success": False,
                "error": (
                    f"Replacement would put memory at {new_total:,}/{limit:,} chars. "
                    f"Shorten the new content, or 'remove' other stale or less important "
                    f"entries to make room (see current_entries below), then retry — all "
                    f"in this turn."
                ),
                "current_entries": entries,
                "usage": f"{current:,}/{limit:,}",
            }

        entries[idx] = new_content
        _write_file(path, entries)
    return _success(target, "Entry replaced.", len(entries))


def _do_remove(target: str, old_text: str) -> Dict[str, Any]:
    old_text = old_text.strip()
    if not old_text:
        return _error(target, "old_text cannot be empty.")

    path = _path_for(target)
    limit = CHAR_LIMITS[target]
    with _file_lock(path):
        bak = _detect_external_drift(path, limit)
        if bak:
            return _drift_error(path, bak)

        entries = _read_file(path)
        matches = [(i, e) for i, e in enumerate(entries) if old_text in e]
        if not matches:
            return {
                "success": False,
                "error": f"No entry matched '{old_text}'. Check current_entries below and retry with the exact text of the entry you want to remove.",
                "current_entries": entries,
            }
        if len(matches) > 1:
            unique_texts = {e for _, e in matches}
            if len(unique_texts) > 1:
                return {
                    "success": False,
                    "error": f"Multiple entries matched '{old_text}'. Be more specific.",
                    "matches": _previews([e for _, e in matches]),
                }

        idx = matches[0][0]
        entries.pop(idx)
        _write_file(path, entries)
    return _success(target, "Entry removed.", len(entries))


def _do_batch(target: str, operations: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not operations:
        return _error(target, "operations list is empty.")

    for i, op in enumerate(operations):
        act = (op or {}).get("action")
        new_content = (op or {}).get("content")
        if act in {"add", "replace"} and new_content:
            scan_error = first_threat_message(new_content)
            if scan_error:
                return _error(target, f"Operation {i + 1}: {scan_error}")

    path = _path_for(target)
    limit = CHAR_LIMITS[target]
    with _file_lock(path):
        bak = _detect_external_drift(path, limit)
        if bak:
            return _drift_error(path, bak)

        working: List[str] = _read_file(path)

        for i, op in enumerate(operations):
            op = op or {}
            act = op.get("action")
            content = (op.get("content") or "").strip()
            old_text = (op.get("old_text") or "").strip()
            pos = f"Operation {i + 1} ({act or 'unknown'})"

            if act == "add":
                if not content:
                    return _batch_error(target, f"{pos}: content is required.")
                if content in working:
                    continue  # idempotent — skip duplicate, don't fail the batch
                working.append(content)
            elif act == "replace":
                if not old_text:
                    return _batch_error(target, f"{pos}: old_text is required.")
                if not content:
                    return _batch_error(target, f"{pos}: content is required (use action='remove' to delete).")
                matches = [j for j, e in enumerate(working) if old_text in e]
                if not matches:
                    return _batch_error(target, f"{pos}: no entry matched '{old_text}'.")
                if len({working[j] for j in matches}) > 1:
                    return _batch_error(target, f"{pos}: '{old_text}' matched multiple distinct entries -- be more specific.")
                working[matches[0]] = content
            elif act == "remove":
                if not old_text:
                    return _batch_error(target, f"{pos}: old_text is required.")
                matches = [j for j, e in enumerate(working) if old_text in e]
                if not matches:
                    return _batch_error(target, f"{pos}: no entry matched '{old_text}'.")
                if len({working[j] for j in matches}) > 1:
                    return _batch_error(target, f"{pos}: '{old_text}' matched multiple distinct entries -- be more specific.")
                working.pop(matches[0])
            else:
                return _batch_error(target, f"{pos}: unknown action. Use add, replace, or remove.")

        new_total = len(ENTRY_DELIMITER.join(working)) if working else 0
        if new_total > limit:
            current = _char_count(target)
            return {
                "success": False,
                "error": (
                    f"After applying all {len(operations)} operations, memory would be at "
                    f"{new_total:,}/{limit:,} chars -- over the limit. Remove or shorten more "
                    f"entries in the same batch (see current_entries below), then retry."
                ),
                "current_entries": _read_file(path),
                "usage": f"{current:,}/{limit:,}",
            }

        _write_file(path, working)
    return _success(target, f"Applied {len(operations)} operation(s).", len(working))


def _batch_error(target: str, message: str) -> Dict[str, Any]:
    current = _char_count(target)
    limit = CHAR_LIMITS[target]
    return {
        "success": False,
        "error": message + " No operations were applied (batch is all-or-nothing).",
        "current_entries": _read_file(_path_for(target)),
        "usage": f"{current:,}/{limit:,}",
    }


# ── Entry point ───────────────────────────────────────────────────────────
def main() -> None:
    try:
        raw = sys.stdin.read()
        req = json.loads(raw)
    except Exception as exc:  # malformed request — fail loudly, never crash the plugin
        print(json.dumps({"success": False, "error": f"Bad request: {exc}"}))
        return

    target = req.get("target", "memory")
    if target not in FILES:
        print(json.dumps({"success": False, "error": f"Invalid target '{target}'. Use 'memory' or 'user'."}))
        return

    MEMORIES_DIR.mkdir(parents=True, exist_ok=True)

    operations = req.get("operations")
    if operations is not None:
        result = _do_batch(target, operations)
    else:
        action = req.get("action", "")
        content = req.get("content")
        old_text = req.get("old_text")
        if action == "add":
            result = _do_add(target, content)
        elif action == "replace":
            result = _do_replace(target, old_text, content)
        elif action == "remove":
            result = _do_remove(target, old_text)
        else:
            result = _error(target, f"Unknown action '{action}'. Use add, replace, remove, or operations (batch).")

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
