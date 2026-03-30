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


def _run_async(coro, timeout=60):
    loop = _get_or_create_event_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    try:                                                                                                     
        return future.result(timeout=timeout)                                                                
    except TimeoutError:                                                                                     
        future.cancel()          # kill the orphaned coroutine                                               
        raise 


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
    """
    Returns (reply_text, verified_partner_id_or_None).
    verified_partner_id is non-None when verify_email_otp succeeded during this call —
    the controller uses it to persist the session upgrade.
    """
    global _mcp_client, _tool_schemas

    conversation = [{"role": "system", "content": system_prompt}]
    conversation.extend(history)
    conversation.append({"role": "user", "content": user_message})

    client = OpenAI(
        api_key=api_key,
        base_url=base_url,                                                                                  
        max_retries=2,          # default is 2 but be explicit                                              
        timeout=30.0,
    )

    verified_partner_id = None  # Set when verify_email_otp succeeds in this call

    # Agentic loop — run until the model stops calling tools or we hit the cap.
    for round_number in range(max_tool_rounds):
        # Check if this coroutine was cancelled (e.g. timeout in _run_async)                                
        if asyncio.current_task() and asyncio.current_task().cancelled():                                   
            _logger.info("MCP: coroutine cancelled, stopping agentic loop")                                 
            return "Sorry, the request timed out. Please try again.", verified_partner_id

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
            return message.content or "", verified_partner_id

        # Append the assistant turn with its tool call requests
        conversation.append(message)

        # Execute every tool the model requested in this round
        for tool_call in message.tool_calls:
            tool_name = tool_call.function.name
            args = json.loads(tool_call.function.arguments)

            if tool_name in AUTH_REQUIRED_TOOLS:
                if not isinstance(args, dict):
                    args = {}
                if not authenticated_partner_id:
                    result_text = json.dumps({
                        "error": "Authentication required",
                        "suggestion": (
                            "This action requires a verified identity. "
                            "The user can either sign in to their account, "
                            "or verify via email using these steps:\n"
                            "Step 1: Ask the user for their email address. "
                            "Send ONLY this question and STOP. Do not call any tool.\n"
                            "Step 2: Once the user replies with their email, "
                            "call send_verification_email with that email. "
                            "Tell them a code was sent and STOP. "
                            "Do not repeat yourself. One short sentence is enough.\n"
                            "Step 3: Once the user replies with the 6-digit code, "
                            "call verify_email_otp with their email and code.\n"
                            "Step 4: Once verified, retry the original action.\n"
                            "IMPORTANT: Each step requires a separate user reply. "
                            "Do NOT combine steps. Send one short message per step and wait."
                        ),
                    })
                    _logger.info(
                        "MCP: round %d — tool '%s' blocked (no partner_id), "
                        "returning auth suggestion",
                        round_number + 1, tool_name,
                    )
                    conversation.append({
                        "role":         "tool",
                        "tool_call_id": tool_call.id,
                        "name":         tool_name,
                        "content":      result_text,
                    })
                    continue
                args['partner_id'] = authenticated_partner_id

            _logger.info(
                "MCP: round %d — calling tool '%s' with args %s",
                round_number + 1, tool_name, args,
            )

            result_content = (
                await _mcp_client.session.call_tool(tool_name, arguments=args or {})
            ).content

            result_text = str(result_content)

            # When verify_email_otp succeeds, upgrade authenticated_partner_id
            # in-flight so that any auth-required tool the LLM calls in subsequent
            # rounds of THIS same turn uses the verified partner.
            if tool_name == 'verify_email_otp':
                try:
                    raw = result_content[0].text if result_content else '{}'
                    data = json.loads(raw)
                    if data.get('success') and data.get('partner_id'):
                        authenticated_partner_id = data['partner_id']
                        verified_partner_id = data['partner_id']
                except Exception as exc:
                    _logger.debug("MCP: failed to parse verify_email_otp result: %s", exc)

            conversation.append({
                "role":         "tool",
                "tool_call_id": tool_call.id,
                "name":         tool_name,
                "content":      result_text,
            })

    # Safety fallback — cap reached, force a plain text reply.
    # Omit tools entirely so the model cannot attempt another tool call
    # (Groq returns 400 if the model generates a call with tool_choice="none").
    _logger.warning("MCP: tool round cap (%d) reached, forcing final reply", max_tool_rounds)
    # Tell the model it has no more tools so it doesn't hallucinate a call                                  
    # (Groq returns 400 when the model generates a tool call with tool_choice="none").                      
    conversation.append({                                                                                   
        "role": "user",                                                                                     
        "content": (                                                                                        
            "You have no tools available. Summarise what you have done so far "                             
            "and respond to the user in plain text only."                                                   
        ),                                                                                                  
    })                                                                                                      
  
    try:                                                                                                    
        final_response = client.chat.completions.create(                                                    
            model=model_name,                                                                               
            messages=conversation,                                                                          
            temperature=0.7,                                                                                
        )                                                                                                   
        return final_response.choices[0].message.content or "", verified_partner_id                         
    except Exception as exc:                                                                                
        _logger.warning("MCP: fallback completion also failed: %s", exc)                                    
        return (                                                                                            
            "I've looked into your request but wasn't able to finish processing. "                          
            "Could you please try rephrasing or simplifying your question?"                                 
        ), verified_partner_id


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
            reply, verified_partner_id = _run_async(
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
            return reply, verified_partner_id
        except TimeoutError:
            _logger.error("MCP: process_message timed out")
            return "Sorry, the request timed out. Please try again.", None
        except Exception as exc:
            _logger.error("MCP: process_message error: %s", exc)
            return f"Sorry, I encountered an error: {exc}", None

    @api.model
    def summarize_history(self, history):
        if not history:
            return ""

        settings = self._get_llm_settings()

        client = OpenAI(
            api_key=settings['api_key'],
            base_url=settings['base_url'],
            max_retries=2,                                                                                  
            timeout=30.0,
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