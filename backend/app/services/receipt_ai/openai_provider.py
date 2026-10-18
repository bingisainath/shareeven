# backend/app/services/receipt_ai/openai_provider.py

import logging

import openai

from app.config.settings import settings
from app.services.receipt_ai.base import ExtractionError, ExtractionResult, ReceiptExtractor
from app.services.receipt_ai.prompt import SYSTEM_PROMPT, user_text
from app.services.receipt_ai.schema import ReceiptExtraction

logger = logging.getLogger(__name__)


class OpenAIExtractor(ReceiptExtractor):
    provider = "openai"

    async def extract(self, images, note, model, api_key, hints: str | None = None) -> ExtractionResult:
        client = openai.AsyncOpenAI(api_key=api_key, timeout=settings.RECEIPT_AI_TIMEOUT_SECONDS, max_retries=2)
        content = [
            {"type": "input_image", "image_url": f"data:{media_type};base64,{data}", "detail": "high"}
            for media_type, data in images
        ]
        content.append({"type": "input_text", "text": user_text(note, len(images), hints)})
        try:
            response = await client.responses.parse(
                model=model,
                instructions=SYSTEM_PROMPT,
                input=[{"role": "user", "content": content}],
                text_format=ReceiptExtraction,
                store=False,
            )
        except openai.AuthenticationError:
            raise ExtractionError("The OpenAI API key was rejected")
        except openai.RateLimitError:
            raise ExtractionError("OpenAI is busy or the key is out of credit. Try again in a minute")
        except openai.APITimeoutError:
            raise ExtractionError("Reading the receipt took too long. Try again")
        except openai.APIStatusError as e:
            logger.warning("OpenAI receipt scan failed: %s", e.status_code)
            raise ExtractionError("OpenAI couldn't read this receipt right now")
        except openai.APIConnectionError:
            raise ExtractionError("Couldn't reach OpenAI. Try again")

        if response.output_parsed is None:
            raise ExtractionError("OpenAI declined or couldn't read this image")
        usage = response.usage
        return ExtractionResult(
            data=response.output_parsed,
            model=response.model,
            usage={"input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens} if usage else {},
        )
