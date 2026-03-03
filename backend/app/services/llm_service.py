"""LLM service using OpenRouter for multi-provider access."""

from openai import AsyncOpenAI
from typing import List, Dict, Optional
import logging
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
import httpx

from app.config import settings
from app.core.exceptions import LLMException

logger = logging.getLogger(__name__)


class OpenRouterLLMService:
    """Interact with LLMs through OpenRouter unified API."""

    SYSTEM_PROMPT = """You are an expert code analysis assistant. You adapt your response format based on what the user is asking.

## QUESTION TYPE DETECTION — choose ONE mode:

### MODE 1 — PROJECT OVERVIEW
Triggers: "what does this do", "explain the project", "what is this", "overview", "summarize", "architecture", "how does it work"
Response format:
- ## What This Project Does
  2-3 sentence summary based strictly on the code
- ## Key Features
  bullet list of actual implemented features (only what exists in the code)
- ## File Structure
  list each file seen in the snippets with one-line description of its role
- ## Tech Stack
  libraries/frameworks visible in imports only
DO NOT include raw code blocks in this mode. Clean prose and bullets only.

### MODE 2 — SPECIFIC EXPLANATION
Triggers: "explain this function", "how does X work", "what is Y", "why does Z"
Response format:
- Direct answer referencing specific function/variable names
- One focused code block if it helps illustrate the point
- Key points as bullets
Max 250 words.

### MODE 3 — CODE GENERATION
Triggers: "write", "generate", "create", "add", "show me how to", "give me a snippet"
Response format:
- Brief explanation of what you're writing
- Complete runnable code block consistent with visible patterns
- Note which existing files it relates to

## STRICT RULES (all modes):
1. Base answers only on provided code snippets — no invention
2. Reference actual file names and function names visible in the snippets
3. Do NOT dump all code snippets back at the user for overview questions
4. If information is genuinely absent, say so briefly and move on
"""

    def __init__(self):
        """Initialize OpenRouter client."""
        self.client = AsyncOpenAI(
            api_key=settings.openrouter_api_key,
            base_url=settings.openrouter_base_url,
            default_headers={
                "HTTP-Referer": settings.openrouter_app_url,
                "X-Title": settings.openrouter_app_name,
            }
        )

        self.default_model = settings.default_model
        self.fallback_models = settings.fallback_models_list
        self.enable_fallback = settings.enable_fallback

        logger.info(f"OpenRouter LLM Service initialized with model: {self.default_model}")
        if self.fallback_models:
            logger.info(f"Fallback models: {', '.join(self.fallback_models)}")

    async def generate_explanation(
        self,
        question: str,
        code_chunks: List[Dict],
        model: Optional[str] = None
    ) -> Dict[str, any]:
        """
        Generate explanation for code based on question and context.

        Args:
            question: User's question
            code_chunks: List of relevant code chunks with metadata
            model: Optional specific model to use

        Returns:
            Dictionary with answer and metadata
        """
        context = self._build_context(code_chunks)

        user_prompt = f"""Here are the relevant code snippets from the repository:

{context}

Question: {question}

Answer strictly based on the code above. Do not add information not present in the snippets."""

        models_to_try = [model or self.default_model]
        if self.enable_fallback and not model:
            models_to_try.extend(self.fallback_models)

        last_error = None

        for current_model in models_to_try:
            try:
                logger.info(f"Attempting generation with model: {current_model}")
                result = await self._call_model(current_model, user_prompt)
                return {
                    "answer": result["content"],
                    "model_used": current_model,
                    "tokens": result.get("tokens"),
                    "cost": result.get("cost")
                }

            except Exception as e:
                logger.warning(f"Model {current_model} failed: {e}")
                last_error = e
                continue

        raise LLMException(f"All models failed. Last error: {str(last_error)}")

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10),
        retry=retry_if_exception_type((httpx.TimeoutException, httpx.NetworkError))
    )
    async def _call_model(self, model: str, user_prompt: str) -> Dict[str, any]:
        """
        Call OpenRouter API with retry logic.

        Args:
            model: Model identifier
            user_prompt: User message

        Returns:
            Dictionary with response content and metadata
        """
        try:
            if settings.log_openrouter_requests:
                logger.debug(f"Calling model: {model}")
                logger.debug(f"Prompt length: {len(user_prompt)} chars")

            response = await self.client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": self.SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=settings.temperature,
                # Capped at 800 — previous default of 4096 caused 30s responses
                # and bloated answers. 800 tokens = ~600 words, enough for any
                # code explanation. User can always ask a follow-up question.
                max_tokens=800,
            )

            content = response.choices[0].message.content
            usage = response.usage
            result = {
                "content": content,
                "tokens": {
                    "prompt": usage.prompt_tokens if usage else None,
                    "completion": usage.completion_tokens if usage else None,
                    "total": usage.total_tokens if usage else None
                }
            }

            if hasattr(response, '_response'):
                headers = response._response.headers
                if 'x-ratelimit-cost' in headers:
                    result["cost"] = float(headers['x-ratelimit-cost'])

            logger.info(
                f"Model {model} responded successfully. "
                f"Tokens: {result['tokens']['total']}"
            )
            return result

        except Exception as e:
            error_msg = str(e)
            if "insufficient_quota" in error_msg.lower():
                raise LLMException("Insufficient quota on OpenRouter account")
            elif "rate_limit" in error_msg.lower():
                raise LLMException("Rate limit exceeded, please try again later")
            elif "model_not_found" in error_msg.lower():
                raise LLMException(f"Model not found: {model}")
            else:
                raise LLMException(f"LLM request failed: {error_msg}")

    def _build_context(self, code_chunks: List[Dict]) -> str:
        """
        Build context string from code chunks.
        Deduplicates chunks with identical file_path + lines to prevent
        the same code block being sent twice (seen with AppFooter.tsx).
        """
        context_parts = []
        seen: set[str] = set()

        for i, chunk in enumerate(code_chunks, 1):
            metadata = chunk['metadata']
            code = chunk['code']

            # Dedup key: same file + same line range = same chunk
            dedup_key = f"{metadata['file_path']}:{metadata['lines']}"
            if dedup_key in seen:
                logger.debug(f"Skipping duplicate chunk: {dedup_key}")
                continue
            seen.add(dedup_key)

            part = f"""### Code Snippet {i}
**File:** `{metadata['file_path']}`
**Type:** {metadata['type']} - {metadata['name']}
**Lines:** {metadata['lines']}
**Language:** {metadata['language']}
```{metadata['language']}
{code}
```
"""
            context_parts.append(part)

        return "\n".join(context_parts)

    async def generate_code_snippet(
        self,
        description: str,
        context: str = "",
        model: Optional[str] = None
    ) -> Dict[str, any]:
        """Generate new code snippet based on description and context."""
        prompt = f"""Generate code based on the following request:

{description}

{f'Context from existing codebase:{context}' if context else ''}

Provide only the code with proper formatting and comments."""

        models_to_try = [model or self.default_model]
        if self.enable_fallback and not model:
            models_to_try.extend(self.fallback_models)

        last_error = None

        for current_model in models_to_try:
            try:
                logger.info(f"Generating code with model: {current_model}")
                response = await self.client.chat.completions.create(
                    model=current_model,
                    messages=[
                        {
                            "role": "system",
                            "content": "You are an expert programmer. Generate clean, well-documented code."
                        },
                        {"role": "user", "content": prompt}
                    ],
                    temperature=0.5,
                    max_tokens=2000
                )
                return {
                    "code": response.choices[0].message.content,
                    "model_used": current_model
                }

            except Exception as e:
                logger.warning(f"Code generation with {current_model} failed: {e}")
                last_error = e
                continue

        raise LLMException(
            f"Code generation failed with all models. Last error: {str(last_error)}"
        )

    async def get_available_models(self) -> List[Dict[str, any]]:
        """Get list of available models from OpenRouter."""
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    "https://openrouter.ai/api/v1/models",
                    headers={"Authorization": f"Bearer {settings.openrouter_api_key}"}
                )
                response.raise_for_status()
                data = response.json()
                return data.get("data", [])
        except Exception as e:
            logger.error(f"Failed to fetch available models: {e}")
            return []

    async def get_model_info(self, model_id: str) -> Optional[Dict[str, any]]:
        """Get information about a specific model."""
        models = await self.get_available_models()
        for model in models:
            if model.get("id") == model_id:
                return model
        return None