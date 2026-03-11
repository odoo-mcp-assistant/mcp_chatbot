# Copied from odoo_mcp_addon/models/mcp_client_service.py
# Only change: import BaseHTTPMCPClient from local base_client (same package)
import os
import asyncio
import logging
import threading

from odoo import models, api
from openai import OpenAI
import json

from .base_client import BaseHTTPMCPClient

_logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level singletons
# ---------------------------------------------------------------------------
# These are intentionally at module level (not on the Odoo model record) so
# they survive across ORM calls and across multiple Odoo worker threads.
# A single background thread runs a dedicated asyncio event loop; all async
# MCP work is submitted to that loop from synchronous Odoo code via
# run_coroutine_threadsafe().

_event_loop: asyncio.AbstractEventLoop = None          # The dedicated async event loop
_thread: threading.Thread = None            # Thread that runs the loop
_mcp_client: BaseHTTPMCPClient = None         # Persistent MCP session
_tool_schemas: list = []                         # Cached tool list from MCP server
_init_lock = threading.Lock()                    # Guards one-time initialisation
_initialized = False                             # Flag to avoid double init


SYSTEM_PROMPT = (
    "You are an AI assistant integrated with an Odoo ERP system. "
    "You have access to tools that allow you to retrieve and create product data from the Odoo database. "

    "When a user asks about specific product information, availability, pricing, or wants to add a product, "
    "you MUST use the appropriate tool to retrieve or modify data. "
    "Never invent or guess product information — always rely on tools for Odoo-related data. "

    "If a request is general knowledge and not related to the Odoo system, respond normally using your own knowledge. "

    "If a request appears to be related to the Odoo system but you do not have a suitable tool to fulfill it, "
    "respond politely and explain that the requested action is not currently supported, without mentioning tools or technical limitations. "

    "FORMATTING RULES - follow these strictly for every response: "
    "- Write in plain text only. No markdown of any kind. "
    "- No headers, no bullet points, no numbered lists, no bold, no italics, no tables. "
    "- Do not use any special characters for formatting such as *, **, #, |, -, or _. "
    "- Use only standard punctuation: periods, commas, colons, question marks, and exclamation marks. "
    "- When presenting multiple items or data, use plain sentences or separate lines with no symbols. "
    "- Keep responses clear and readable using natural language structure only."
)

# ---------------------------------------------------------------------------
# Background event loop helpers
# ---------------------------------------------------------------------------

def _set_background_event_loop(loop: asyncio.AbstractEventLoop):
    """Thread target: run the event loop forever."""
    asyncio.set_event_loop(loop)
    loop.run_forever()


def _get_or_create_event_loop() -> asyncio.AbstractEventLoop:
    """Return the module-level background loop, creating it if necessary."""
    global _event_loop, _thread

    if _event_loop is not None and _event_loop.is_running():
        return _event_loop

    _event_loop = asyncio.new_event_loop()
    _thread = threading.Thread(
        target=_set_background_event_loop,
        args=(_event_loop,),
        daemon=True,          # Dies automatically when Odoo process exits
        name="mcp-event-loop",
    )
    _thread.start()
    _logger.info("MCP: background event loop started")
    return _event_loop


def _run_async(coro):
    """
    Submit a coroutine to the background loop and block until it completes.
    This is the bridge between synchronous Odoo ORM code and async MCP calls.
    """
    loop = _get_or_create_event_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    return future.result(timeout=60)   # 60 s hard timeout per MCP call


# ---------------------------------------------------------------------------
# Async initialisation (runs once on background loop)
# ---------------------------------------------------------------------------

async def _async_connect_to_client(server_url: str):
    """Connect the MCP client and fetch tool schemas. Called once at startup."""
    global _mcp_client, _tool_schemas

    _mcp_client = BaseHTTPMCPClient(server_url)
    await _mcp_client.connect()

    tools = (await _mcp_client.session.list_tools()).tools
    _tool_schemas = [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.inputSchema,
            },
        }
        for t in tools
    ]

    _logger.info(
        "MCP: connected to %s — %d tools loaded: %s",
        server_url,
        len(_tool_schemas),
        [s["function"]["name"] for s in _tool_schemas],
    )


# ---------------------------------------------------------------------------
# Async LLM + tool-call loop (uses OpenAI / Groq)
# ---------------------------------------------------------------------------

async def _async_process_message(user_message: str, history: list, model: str) -> str:
    """
    Full MCP host logic: build conversation → call LLM (OpenAI/Groq) → handle tool calls
    → return final reply string.
    This runs on the background event loop.
    """
    global _mcp_client, _tool_schemas

    # Build conversation: system prompt + history + new user message
    conversation = [{"role": "system", "content": SYSTEM_PROMPT}]
    conversation.extend(history)
    conversation.append({"role": "user", "content": user_message})

    # --- OpenAI client setup ---
    API_KEY = os.getenv("OPENAI_API_KEY", "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")
    client = OpenAI(
        api_key=API_KEY,
        base_url="https://api.groq.com/openai/v1"
    )
    # Use the provided model or fallback to a default
    model_name = model or "llama-3.3-70b-versatile"

    # First LLM call (with tools)
    response = client.chat.completions.create(
        model=model_name,
        messages=conversation,
        tools=_tool_schemas,
        tool_choice="auto",
        temperature=0.7
    )

    message = response.choices[0].message

    # ------------------------------------------------------------------
    # Tool call branch
    # ------------------------------------------------------------------
    if message.tool_calls:

        for tool_call in message.tool_calls:
            tool_name = tool_call.function.name
            # Arguments are a JSON string; parse them
            args = json.loads(tool_call.function.arguments)

            _logger.info("MCP: calling tool '%s' with args %s", tool_name, args)

            result = (await _mcp_client.session.call_tool(tool_name, arguments=args or {})).content

            # Append tool response using OpenAI's tool message format
            conversation.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "name": tool_name,
                "content": str(result),
            })

        # Second LLM call — produce a natural language reply from tool results
        final_response = client.chat.completions.create(
            model=model_name,
            messages=conversation,
            temperature=0.7
        )
        return final_response.choices[0].message.content

    # ------------------------------------------------------------------
    # Direct reply branch
    # ------------------------------------------------------------------
    return message.content or ""


# ---------------------------------------------------------------------------
# Odoo Model
# ---------------------------------------------------------------------------

class MCPClientService(models.AbstractModel):
    """
    Singleton Odoo service that owns the MCP client connection.

    Usage from other models:
        service = self.env['mcp.client.service']
        reply = service.process_message(user_message, history)
    """

    _name = "mcp.client.service"
    _description = "MCP Client Service"

    # ------------------------------------------------------------------
    # Public synchronous API
    # ------------------------------------------------------------------

    @api.model
    def ensure_initialized(self):
        """
        Lazily initialise the background loop and MCP connection on the
        first call. Thread-safe — subsequent calls are no-ops.
        """
        global _initialized

        if _initialized:
            return

        with _init_lock:
            if _initialized:   # Double-checked locking
                return

            server_url = os.getenv("MCP_SERVER_URL", "http://localhost:8010/mcp")
            _logger.info("MCP: initialising client → %s", server_url)

            try:
                _run_async(_async_connect_to_client(server_url))
                _initialized = True
                _logger.info("MCP: initialisation complete")
            except Exception as exc:
                _logger.error("MCP: initialisation failed: %s", exc)
                raise

    @api.model
    def process_message(self, user_message: str, history: list) -> str:
        """
        Process a user message through the MCP host pipeline.

        Args:
            user_message: Plain text from the user.
            history:      List of {"role": ..., "content": ...} dicts.

        Returns:
            Plain text reply from the LLM (after any tool calls are resolved).
        """
        self.ensure_initialized()

        model = os.getenv("OPENAI_MODEL", "llama-3.3-70b-versatile")

        try:
            reply = _run_async(
                _async_process_message(user_message, history, model)
            )
            return reply
        except TimeoutError:
            _logger.error("MCP: process_message timed out")
            return "Sorry, the request timed out. Please try again."
        except Exception as exc:
            _logger.error("MCP: process_message error: %s", exc)
            return f"Sorry, I encountered an error: {exc}"

    @api.model
    def summarize_history(self, history: list) -> str:
        """
        Summarize a conversation history using the LLM directly,
        without going through the MCP tool call pipeline.
        Used to compress long histories before sending them to the main LLM call.

        Moved here from mail_message.py so it is reusable by any model
        (including the website chatbot controller) without depending on
        mail.message being in scope.
        """
        if not history:
            return ""

        # --- OpenAI client setup ---
        API_KEY = os.getenv("OPENAI_API_KEY", "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")
        client = OpenAI(
            api_key=API_KEY,
            base_url="https://api.groq.com/openai/v1"
        )
        # Use the provided model or fallback to a default
        model_name = os.getenv("OPENAI_MODEL", "llama-3.3-70b-versatile")

        # Build a single prompt asking the LLM to summarize the conversation
        # No tools needed — this is a pure summarization task
        messages = [
            {
                "role": "system",
                "content": (
                    "You are a conversation summarizer. "
                    "Given a chat history, produce a concise summary that preserves "
                    "all important context: key questions asked, decisions made, "
                    "products or data mentioned, and the current state of the conversation. "
                    "Be brief but complete."
                )
            },
            {
                "role": "user",
                "content": (
                    f"Please summarize this conversation history:\n\n"
                    f"{history}"
                )
            }
        ]

        response = client.chat.completions.create(
            model=model_name,
            messages=messages,
            temperature=0.3   # Lower temperature for more consistent summaries
        )

        return response.choices[0].message.content or ""
