"""Vector database service using ChromaDB."""

import shutil
import time
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional

import chromadb
import numpy as np
from chromadb.config import Settings as ChromaSettings

from app.config import settings
from app.core.exceptions import VectorDBException
from app.services.parser_service import CodeChunk

logger = logging.getLogger(__name__)


# ── Singleton client ──────────────────────────────────────────────────────────
# Root cause of UUID accumulation: instantiating PersistentClient on every
# request registers a NEW segment UUID in chroma.sqlite3 and creates a new
# UUID directory, orphaning the previous one.  One client per process = zero
# accumulation.
_client: Optional[chromadb.PersistentClient] = None


def _get_client() -> chromadb.PersistentClient:
    """Return the shared ChromaDB client, initialising it once on first call."""
    global _client
    if _client is None:
        logger.info("Initialising ChromaDB singleton client.")
        _client = chromadb.PersistentClient(
            path=settings.chroma_persist_directory,
            settings=ChromaSettings(
                anonymized_telemetry=False,
                allow_reset=True,
            )
        )
    return _client


def _reset_client() -> chromadb.PersistentClient:
    """Null and recreate the singleton — must be called after a directory wipe."""
    global _client
    _client = None
    return _get_client()


class VectorService:
    """Manage ChromaDB operations."""

    def __init__(self):
        # Always reuse the singleton — never construct a new PersistentClient here.
        self.client = _get_client()

    # ── Collection lifecycle ──────────────────────────────────────────────────

    async def create_collection(self, session_id: str) -> None:
        """
        Create a fresh collection for a session.

        IMPORTANT: always delete through the live client, not via shutil.
        client.delete_collection() tells ChromaDB to deregister the segment UUID
        from chroma.sqlite3 AND remove the UUID directory itself.
        Skipping this step (or using rmtree directly) is what leaves orphaned dirs.
        """
        collection_name = f"session_{session_id}"
        try:
            try:
                self.client.delete_collection(name=collection_name)
                logger.info(f"Dropped previous collection: {collection_name}")
            except Exception:
                pass  # did not exist yet — fine

            self.client.create_collection(
                name=collection_name,
                metadata={"session_id": session_id}
            )
            logger.info(f"Created collection: {collection_name}")

        except Exception as e:
            logger.error(f"Error creating collection: {e}")
            raise VectorDBException(f"Failed to create collection: {str(e)}")

    async def delete_collection(self, session_id: str) -> None:
        """Delete a session's collection (called by session cleanup)."""
        collection_name = f"session_{session_id}"
        try:
            self.client.delete_collection(name=collection_name)
            logger.info(f"Deleted collection: {collection_name}")
        except Exception as e:
            logger.warning(f"Could not delete {collection_name}: {e}")

    # ── Nuclear reset (dev / factory-reset only) ──────────────────────────────

    @staticmethod
    def purge_all(retries: int = 3, delay: float = 0.5) -> None:
        """
        Wipe the entire chroma_db directory and reinitialise the client.

        Use only when the DB is corrupted or you need a total reset.
        For normal operation always use delete_collection() per session —
        that is safe, atomic, and leaves other sessions untouched.
        """
        global _client
        db_path = Path(settings.chroma_persist_directory)

        # Null BEFORE rmtree so no concurrent coroutine reuses the dead client.
        _client = None

        if db_path.exists():
            for attempt in range(1, retries + 1):
                try:
                    shutil.rmtree(db_path)
                    logger.info("chroma_db purged (attempt %d).", attempt)
                    break
                except PermissionError as exc:
                    logger.warning("rmtree attempt %d/%d failed: %s", attempt, retries, exc)
                    if attempt == retries:
                        raise RuntimeError(
                            f"Could not remove {db_path} after {retries} attempts."
                        ) from exc
                    time.sleep(delay)

        _reset_client()
        logger.info("ChromaDB client re-initialised after purge.")

    # ── Data operations ───────────────────────────────────────────────────────

    async def insert_embeddings(
        self,
        session_id: str,
        chunks: List[CodeChunk],
        embeddings: List[np.ndarray]
    ) -> None:
        """Insert embeddings into collection."""
        try:
            collection = self.client.get_collection(name=f"session_{session_id}")

            ids            = [chunk.id for chunk in chunks]
            documents      = [chunk.code for chunk in chunks]
            metadatas      = [
                {
                    "file_path": chunk.file_path,
                    "type":      chunk.type,
                    "name":      chunk.name,
                    "language":  chunk.language,
                    "lines":     f"{chunk.start_line}-{chunk.end_line}",
                    "docstring": chunk.docstring,
                }
                for chunk in chunks
            ]
            embeddings_list = [emb.tolist() for emb in embeddings]

            batch_size = 1000
            for i in range(0, len(ids), batch_size):
                collection.add(
                    ids=ids[i:i + batch_size],
                    documents=documents[i:i + batch_size],
                    metadatas=metadatas[i:i + batch_size],
                    embeddings=embeddings_list[i:i + batch_size],
                )

            logger.info(f"Inserted {len(ids)} embeddings into session_{session_id}")

        except Exception as e:
            logger.error(f"Error inserting embeddings: {e}")
            raise VectorDBException(f"Failed to insert embeddings: {str(e)}")

    async def search_similar(
        self,
        session_id: str,
        query_embedding: np.ndarray,
        top_k: int = 5
    ) -> List[Dict[str, Any]]:
        """Search for similar code chunks."""
        try:
            collection = self.client.get_collection(name=f"session_{session_id}")

            # Cap to actual count — Chroma raises if n_results > collection size.
            n_results = min(top_k, collection.count() or 1)

            results = collection.query(
                query_embeddings=[query_embedding.tolist()],
                n_results=n_results,
                include=["documents", "metadatas", "distances"],
            )

            chunks = [
                {
                    "id":       results["ids"][0][i],
                    "code":     results["documents"][0][i],
                    "metadata": results["metadatas"][0][i],
                    "distance": results["distances"][0][i],
                }
                for i in range(len(results["ids"][0]))
            ]

            logger.debug(f"Found {len(chunks)} similar chunks")
            return chunks

        except Exception as e:
            logger.error(f"Error searching: {e}")
            raise VectorDBException(f"Failed to search: {str(e)}")

    def get_collection_count(self, session_id: str) -> int:
        """Return document count, 0 if collection does not exist."""
        try:
            return self.client.get_collection(name=f"session_{session_id}").count()
        except Exception:
            return 0