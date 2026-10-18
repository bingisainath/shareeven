# backend/app/services/receipt_ai/claude.py

import logging

import anthropic

from app.config.settings import settings
from app.services.receipt_ai.base import ExtractionError, ExtractionResult, ReceiptExtractor
from app.services.receipt_ai.prompt import OCR_NOTES, SYSTEM_PROMPT, ocr_user_text, user_text
from app.services.receipt_ai.schema import ReceiptExtraction

logger = logging.getLogger(__name__)

# Models without adaptive thinking / effort (older generations) get a plain request
_NO_THINKING_PREFIXES = ("claude-haiku-4", "claude-3")
# Server-side fallback when Opus 5's safety classifier declines (rare for receipts)
_FALLBACK_MODELS = {"claude-opus-5"}
_FALLBACK_BETA = "server-side-fallback-2026-07-01"

WORKSPACE_HINT = (
    "This Claude API key isn't tied to a workspace. Create a key inside a workspace in the "
    "Anthropic Console, or set ANTHROPIC_WORKSPACE_ID on the server"
)


def is_workspace_error(error: anthropic.APIStatusError) -> bool:
    return error.status_code == 400 and "workspace" in str(getattr(error, "message", "")).lower()


def make_client(api_key: str, **options) -> anthropic.AsyncAnthropic:
    """The workspace header goes only with the server's own key, never with someone's personal key."""
    headers = {}
    if settings.ANTHROPIC_WORKSPACE_ID and api_key == settings.ANTHROPIC_API_KEY:
        headers["anthropic-workspace-id"] = settings.ANTHROPIC_WORKSPACE_ID
    return anthropic.AsyncAnthropic(api_key=api_key, default_headers=headers or None, **options)


class ClaudeExtractor(ReceiptExtractor):
    provider = "anthropic"

    async def extract(self, images, note, model, api_key) -> ExtractionResult:
        content = [
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}}
            for media_type, data in images
        ]
        content.append({"type": "text", "text": user_text(note, len(images))})
        return await self._read(content, SYSTEM_PROMPT, model, api_key, settings.RECEIPT_AI_EFFORT)

    async def extract_text(self, pages: list[str], note: str | None, model: str, api_key: str) -> ExtractionResult:
        """The cheap path: the receipt as OCR text (app/services/receipt_ai/ocr.py), no photos."""
        content = [{"type": "text", "text": ocr_user_text(pages, note)}]
        # Capped: a failed cheap read is followed by the photo model, so it must stay cheap
        return await self._read(content, SYSTEM_PROMPT + OCR_NOTES, model, api_key, settings.RECEIPT_OCR_EFFORT,
                                max_tokens=settings.RECEIPT_OCR_MAX_TOKENS)

    async def _read(self, content: list[dict], system: str, model: str, api_key: str, effort: str,
                    max_tokens: int = 16000) -> ExtractionResult:
        client = make_client(api_key, timeout=settings.RECEIPT_AI_TIMEOUT_SECONDS, max_retries=2)
        kwargs: dict = {}
        if effort == "none" and not model.startswith(_NO_THINKING_PREFIXES):
            # Sonnet 5 / Opus 5 accept this; Opus 5.5 and Fable reject it (use an effort level there)
            kwargs["thinking"] = {"type": "disabled"}
        elif not model.startswith(_NO_THINKING_PREFIXES):
            kwargs["thinking"] = {"type": "adaptive"}
            kwargs["output_config"] = {"effort": effort}
        if model in _FALLBACK_MODELS:
            kwargs["betas"] = [_FALLBACK_BETA]
            kwargs["fallbacks"] = "default"

        try:
            response = await client.beta.messages.parse(
                model=model,
                max_tokens=max_tokens,
                system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                messages=[{"role": "user", "content": content}],
                output_format=ReceiptExtraction,
                **kwargs,
            )
        except anthropic.AuthenticationError:
            raise ExtractionError("The Claude API key was rejected")
        except anthropic.PermissionDeniedError:
            raise ExtractionError("This Claude API key can't use that model")
        except anthropic.RateLimitError:
            raise ExtractionError("Claude is busy or the key is out of credit. Try again in a minute")
        except anthropic.APITimeoutError:
            raise ExtractionError("Reading the receipt took too long. Try again")
        except anthropic.APIStatusError as e:
            logger.warning("Claude receipt scan failed: %s %s", e.status_code, getattr(e, "message", ""))
            if is_workspace_error(e):
                raise ExtractionError(WORKSPACE_HINT)
            raise ExtractionError("Claude couldn't read this receipt right now")
        except anthropic.APIConnectionError:
            raise ExtractionError("Couldn't reach Claude. Try again")

        if response.stop_reason == "refusal":
            raise ExtractionError("Claude declined to read this image")
        if response.stop_reason == "max_tokens" or response.parsed_output is None:
            raise ExtractionError("The receipt was too long to read in one go")

        usage = response.usage
        return ExtractionResult(
            data=response.parsed_output,
            model=response.model,
            usage={
                "input_tokens": usage.input_tokens,
                "output_tokens": usage.output_tokens,
                "cache_read_input_tokens": getattr(usage, "cache_read_input_tokens", None),
            },
        )
