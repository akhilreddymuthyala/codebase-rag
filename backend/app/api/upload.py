"""Upload endpoints for ZIP and GitHub."""

from fastapi import APIRouter, UploadFile, File, HTTPException
import time
import logging

from app.models.requests import UploadGitHubRequest
from app.models.responses import UploadResponse, UploadMetadata
from app.services.session_service import SessionService
from app.services.file_service import FileService
from app.services.parser_service import ParserService
from app.services.rag_service import RAGService
from app.services.vector_service import VectorService
from app.config import settings

logger = logging.getLogger(__name__)
router = APIRouter()


async def cleanup_all_previous(session_service: SessionService) -> None:
    """
    Called at the START of every new upload.
    Deletes ALL existing Redis sessions and ALL ChromaDB collections.
    Guarantees only 1 active session + 1 chroma collection at any time.
    """
    vector_service = VectorService()
    file_service = FileService()
    all_sessions = session_service.get_all_sessions()

    if not all_sessions:
        logger.info("No previous sessions to clean up.")
        return

    logger.info(f"Cleaning up {len(all_sessions)} previous session(s) before new upload...")
    for session_id in all_sessions:
        try:
            await vector_service.delete_collection(session_id)
        except Exception as e:
            logger.warning(f"Could not delete ChromaDB collection {session_id}: {e}")
        try:
            await file_service.cleanup_temp_files(session_id)
        except Exception as e:
            logger.warning(f"Could not cleanup temp files {session_id}: {e}")
        try:
            session_service.delete_session(session_id)
        except Exception as e:
            logger.warning(f"Could not delete Redis session {session_id}: {e}")

    logger.info("All previous sessions and ChromaDB collections cleared.")


@router.post("/zip", response_model=UploadResponse)
async def upload_zip(file: UploadFile = File(...)):
    """Upload ZIP — wipes all previous data first, then indexes fresh."""
    start_time = time.time()

    if not file.filename.endswith('.zip'):
        raise HTTPException(status_code=400, detail="Only ZIP files are accepted")
    if file.size and file.size > settings.max_file_size:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum size: {settings.max_file_size / (1024*1024):.0f}MB"
        )

    session_service = SessionService()
    file_service = FileService()
    parser_service = ParserService()
    rag_service = RAGService()

    # WIPE everything old before creating new session
    await cleanup_all_previous(session_service)

    try:
        session_id = session_service.create_session()
        logger.info(f"Created session {session_id} for ZIP upload")

        file_content = await file.read()
        temp_folder, code_files = await file_service.handle_zip_upload(file_content, session_id)

        session_service.update_session(session_id, {
            "status": "parsing",
            "metadata": {"upload_type": "zip", "filename": file.filename, "file_count": len(code_files)}
        })

        chunks = await parser_service.parse_codebase(code_files, temp_folder)
        lang_stats = file_service.get_language_stats(code_files)

        session_service.update_session(session_id, {
            "status": "indexing",
            "metadata": {"chunk_count": len(chunks), **lang_stats}
        })

        await rag_service.index_codebase(session_id, chunks)
        session_service.update_session(session_id, {"status": "ready"})

        return UploadResponse(
            session_id=session_id,
            message="Codebase uploaded and indexed successfully",
            metadata=UploadMetadata(
                file_count=len(code_files),
                primary_language=lang_stats['primary_language'],
                chunk_count=len(chunks),
                processing_time=round(time.time() - start_time, 2),
                languages=lang_stats['languages']
            )
        )

    except Exception as e:
        logger.error(f"Error uploading ZIP: {e}", exc_info=True)
        try:
            await file_service.cleanup_temp_files(session_id)
            session_service.delete_session(session_id)
        except:
            pass
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/github", response_model=UploadResponse)
async def upload_github(request: UploadGitHubRequest):
    """Clone GitHub repo — wipes all previous data first, then indexes fresh."""
    start_time = time.time()

    session_service = SessionService()
    file_service = FileService()
    parser_service = ParserService()
    rag_service = RAGService()

    # WIPE everything old before creating new session
    await cleanup_all_previous(session_service)

    try:
        session_id = session_service.create_session()
        logger.info(f"Created session {session_id} for GitHub repo: {request.repo_url}")

        temp_folder, code_files = await file_service.clone_github_repo(
            request.repo_url, session_id, request.branch
        )

        repo_name = request.repo_url.rstrip('/').split('/')[-1].replace('.git', '')

        session_service.update_session(session_id, {
            "status": "parsing",
            "metadata": {
                "upload_type": "github",
                "repo_url": request.repo_url,
                "repo_name": repo_name,
                "branch": request.branch,
                "file_count": len(code_files)
            }
        })

        chunks = await parser_service.parse_codebase(code_files, temp_folder)
        lang_stats = file_service.get_language_stats(code_files)

        session_service.update_session(session_id, {
            "status": "indexing",
            "metadata": {"chunk_count": len(chunks), **lang_stats}
        })

        await rag_service.index_codebase(session_id, chunks)
        session_service.update_session(session_id, {"status": "ready"})

        return UploadResponse(
            session_id=session_id,
            message="Repository cloned and indexed successfully",
            metadata=UploadMetadata(
                file_count=len(code_files),
                primary_language=lang_stats['primary_language'],
                chunk_count=len(chunks),
                processing_time=round(time.time() - start_time, 2),
                languages=lang_stats['languages']
            )
        )

    except Exception as e:
        logger.error(f"Error cloning GitHub repo: {e}", exc_info=True)
        try:
            await file_service.cleanup_temp_files(session_id)
            session_service.delete_session(session_id)
        except:
            pass
        raise HTTPException(status_code=500, detail=str(e))