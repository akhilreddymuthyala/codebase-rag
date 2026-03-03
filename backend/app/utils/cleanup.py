"""
app/utils/cleanup.py
---------------------
Startup utility: wipe the entire chroma_db directory on every server start.

Why full wipe instead of selective cleanup:
    The UUID directories are NOT orphaned — they ARE registered in chroma.sqlite3
    as valid past session collections. ChromaDB never auto-deletes them.
    Since CodeRAG sessions are per-upload (stateless between server restarts),
    there is no value in keeping old session data across restarts.
    A full wipe on startup is the correct and safe approach.
"""

import logging
import shutil
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)


def cleanup_chroma_on_startup() -> None:
    """
    Wipe the entire chroma_db directory at server startup.

    Removes all stale session collections and their UUID segment dirs so
    every server run starts clean. ChromaDB recreates the directory
    automatically when the first PersistentClient is initialised.
    """
    db_path = Path(settings.chroma_persist_directory)

    if not db_path.exists():
        logger.info("chroma_db does not exist yet — nothing to wipe.")
        return

    try:
        shutil.rmtree(db_path)
        logger.info("chroma_db wiped on startup — clean slate for new sessions.")
    except PermissionError as exc:
        # On Windows a previous uvicorn worker may briefly hold a file lock.
        # Log and continue — old data is stale but harmless; ChromaDB will
        # reuse the existing directory safely.
        logger.warning(
            "Could not wipe chroma_db (file lock from previous process): %s. "
            "Old session data may persist until next restart.",
            exc,
        )
    except Exception as exc:
        logger.error("Unexpected error wiping chroma_db: %s", exc)