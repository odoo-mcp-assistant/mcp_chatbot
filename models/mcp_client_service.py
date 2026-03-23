# mcp_chatbot/models/mcp_client_service.py
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

_event_loop: asyncio.AbstractEventLoop = None
_thread: threading.Thread = None
_mcp_client: BaseHTTPMCPClient = None
_tool_schemas: list = []
_init_lock = threading.Lock()
_initialized = False

AUTH_REQUIRED_TOOLS = {
    'get_orders',
    'create_order',
    'confirm_order',
    'cancel_order',
    'get_order_details',
    'get_my_profile',
    'get_invoices',
    'get_invoice_details',
    'get_unpaid_invoices',
}

# ---------------------------------------------------------------------------
# Background event loop helpers
# ---------------------------------------------------------------------------

def _set_background_event_loop(loop):
    asyncio.set_event_loop(loop)
    loop.run_forever()


def _get_or_create_event_loop():
    global _event_loop, _thread

    if _event_loop is not None and _event_loop.is_running():
        return _event_loop

    _event_loop = asyncio.new_event_loop()
    _thread = threading.Thread(
        target=_set_background_event_loop,
        args=(_event_loop,),
        daemon=True,
        name="mcp-event-loop",
    )
    _thread.start()
    _logger.info("MCP: background event loop started")
    return _event_loop


def _run_async(coro):
    loop = _get_or_create_event_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    return future.result(timeout=60)


# ---------------------------------------------------------------------------
# Async initialisation
# ---------------------------------------------------------------------------

async def _async_connect_to_client(server_url):
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
# Async LLM + tool-call loop
# ---------------------------------------------------------------------------

async def _async_process_message(user_message, history, authenticated_partner_id=None,
                                  api_key=None, base_url=None, model_name=None,
                                  system_prompt=None, max_tool_rounds=5):
    global _mcp_client, _tool_schemas

    conversation = [{"role": "system", "content": system_prompt}]
    conversation.extend(history)
    conversation.append({"role": "user", "content": user_message})

    client = OpenAI(
        api_key=api_key,
        base_url=base_url
    )

    # Agentic loop — run until the model stops calling tools or we hit the cap.
    for round_number in range(max_tool_rounds):
        response = client.chat.completions.create(
            model=model_name,
            messages=conversation,
            tools=_tool_schemas,
            tool_choice="auto",
            temperature=0.7,
        )

        message = response.choices[0].message

        # No tool calls — model is done, return its text reply
        if not message.tool_calls:
            return message.content or ""

        # Append the assistant turn with its tool call requests
        conversation.append(message)

        # Execute every tool the model requested in this round
        for tool_call in message.tool_calls:
            tool_name = tool_call.function.name
            args = json.loads(tool_call.function.arguments)

            if tool_name in AUTH_REQUIRED_TOOLS:
                if not isinstance(args, dict):
                    args = {}
                args['partner_id'] = authenticated_partner_id

            _logger.info(
                "MCP: round %d — calling tool '%s' with args %s",
                round_number + 1, tool_name, args,
            )

            result = (
                await _mcp_client.session.call_tool(tool_name, arguments=args or {})
            ).content

            conversation.append({
                "role":         "tool",
                "tool_call_id": tool_call.id,
                "name":         tool_name,
                "content":      str(result),
            })

    # Safety fallback — cap reached, ask the model to wrap up with what it has
    _logger.warning("MCP: tool round cap (%d) reached, forcing final reply", max_tool_rounds)
    final_response = client.chat.completions.create(
        model=model_name,
        messages=conversation,
        tools=_tool_schemas,
        tool_choice="none",
        temperature=0.7,
    )
    return final_response.choices[0].message.content or ""


# ---------------------------------------------------------------------------
# Odoo Model
# ---------------------------------------------------------------------------

class MCPClientService(models.AbstractModel):
    _name = "mcp.client.service"
    _description = "MCP Client Service"

    def _get_param(self, key, default=None):
        return self.env['ir.config_parameter'].sudo().get_param(key, default)

    @api.model
    def ensure_initialized(self):
        global _initialized

        if _initialized:
            return

        with _init_lock:
            if _initialized:
                return

            server_url = self._get_param('mcp_chatbot.mcp_server_url')
            _logger.info("MCP: initialising client → %s", server_url)

            try:
                _run_async(_async_connect_to_client(server_url))
                _initialized = True
                _logger.info("MCP: initialisation complete")
            except Exception as exc:
                _logger.error("MCP: initialisation failed: %s", exc)
                raise

    @api.model
    def _get_llm_settings(self):
        """Read all LLM-related settings from ir.config_parameter."""
        param = self.env['ir.config_parameter'].sudo()
        LlmModel = self.env['mcp.llm.model']

        api_key      = param.get_param('mcp_chatbot.api_key', '')
        base_url     = param.get_param('mcp_chatbot.base_url', '')
        system_prompt = param.get_param('mcp_chatbot.system_prompt', '')
        max_tool_rounds = int(param.get_param('mcp_chatbot.max_tool_rounds', 5))

        # Resolve LLM model name from Many2one
        model_name = ''
        llm_model_id = param.get_param('mcp_chatbot.llm_model_id')
        if llm_model_id:
            record = LlmModel.browse(int(llm_model_id))
            if record.exists():
                model_name = record.name

        return {
            'api_key':        api_key,
            'base_url':       base_url,
            'model_name':     model_name,
            'system_prompt':  system_prompt,
            'max_tool_rounds': max_tool_rounds,
        }

    @api.model
    def process_message(self, user_message, history, authenticated_partner_id=None):
        self.ensure_initialized()
        settings = self._get_llm_settings()

        try:
            reply = _run_async(
                _async_process_message(
                    user_message,
                    history,
                    authenticated_partner_id,
                    api_key=settings['api_key'],
                    base_url=settings['base_url'],
                    model_name=settings['model_name'],
                    system_prompt=settings['system_prompt'],
                    max_tool_rounds=settings['max_tool_rounds'],
                )
            )
            return reply
        except TimeoutError:
            _logger.error("MCP: process_message timed out")
            return "Sorry, the request timed out. Please try again."
        except Exception as exc:
            _logger.error("MCP: process_message error: %s", exc)
            return f"Sorry, I encountered an error: {exc}"

    @api.model
    def summarize_history(self, history):
        if not history:
            return ""

        settings = self._get_llm_settings()

        client = OpenAI(
            api_key=settings['api_key'],
            base_url=settings['base_url'],
        )

        messages = [
            {
                "role": "system",
                "content": (
                    "You are a conversation summarizer. "
                    "Given a chat history, produce a concise summary that preserves "
                    "all important context: key questions asked, decisions made, "
                    "products or data mentioned, and the current state of the conversation. "
                    "Be brief but complete."
                ),
            },
            {
                "role": "user",
                "content": f"Please summarize this conversation history:\n\n{history}",
            },
        ]

        response = client.chat.completions.create(
            model=settings['model_name'],
            messages=messages,
            temperature=0.3,
        )

        return response.choices[0].message.content or ""