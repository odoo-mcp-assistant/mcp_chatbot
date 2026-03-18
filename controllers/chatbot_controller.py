# mcp_chatbot/controllers/chatbot_controller.py
import logging
import os
from dotenv import load_dotenv

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)

module_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
load_dotenv(os.path.join(module_root, '.env'))
GROQ_API_KEY = os.getenv('GROQ_API_KEY', '')


def _get_fact_extractor():
    """Lazily load fact_extractor from the services folder."""
    import sys, importlib.util
    services_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'services'))
    if 'mcp_chatbot_fact_extractor' not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            'mcp_chatbot_fact_extractor',
            os.path.join(services_dir, 'fact_extractor.py')
        )
        mod = importlib.util.module_from_spec(spec)
        sys.modules['mcp_chatbot_fact_extractor'] = mod
        spec.loader.exec_module(mod)
    return sys.modules['mcp_chatbot_fact_extractor']


def _get_memory_service():
    """Lazily load memory_service from the services folder."""
    import sys, importlib.util
    services_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'services'))

    if services_dir not in sys.path:
        sys.path.insert(0, services_dir)

    if 'embedding_service' not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            'embedding_service',
            os.path.join(services_dir, 'embedding_service.py')
        )
        mod = importlib.util.module_from_spec(spec)
        sys.modules['embedding_service'] = mod
        spec.loader.exec_module(mod)

    if 'mcp_chatbot_memory_service' not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            'mcp_chatbot_memory_service',
            os.path.join(services_dir, 'memory_service.py')
        )
        mod = importlib.util.module_from_spec(spec)
        sys.modules['mcp_chatbot_memory_service'] = mod
        spec.loader.exec_module(mod)

    return sys.modules['mcp_chatbot_memory_service']


class MCPChatbotController(http.Controller):

    # ------------------------------------------------------------------ #
    # POST /mcp_chatbot/message                                            #
    # ------------------------------------------------------------------ #

    @http.route(
        '/mcp_chatbot/message',
        type='json',
        auth='public',
        methods=['POST'],
        website=True,
        csrf=False,
    )
    def receive_message(self, session_token: str, message: str, welcome: str = None, **kwargs):
        """
        Receive a user message. Creates the session on the first real
        user message (lazy creation). If 'welcome' is provided it means
        this is the first message — persist the welcome text first so
        the LLM has full context.
        """

        if not session_token or not message or not message.strip():
            return {'error': 'session_token and message are required'}

        user_message = message.strip()

        # ── Resolve partner if logged in ────────────────────────────────
        partner_id = None
        if not request.env.user._is_public():
            partner_id = request.env.user.partner_id.id

        # ── Get or create session (lazy — created on first real message) ─
        # The history() endpoint already guarantees the browser holds the
        # correct token for the current user before any message is sent,
        # so no mismatch guard is needed here.
        Session = request.env['mcp.chatbot.session'].sudo()
        session = Session.get_or_create_session(session_token, partner_id=partner_id)

        # ── Touch activity — resets the idle timeout clock ───────────────
        session.touch_activity()

        Message = request.env['mcp.chatbot.message'].sudo()

        # ── Persist welcome as first record if this is the first message ─
        if welcome and len(session.message_ids) == 0:
            Message.create({
                'session_id': session.id,
                'role':       'assistant',
                'content':    welcome.strip(),
            })

        # ── Persist user message ─────────────────────────────────────────
        Message.create({
            'session_id': session.id,
            'role':       'user',
            'content':    user_message,
        })

        # ── Build conversation history ───────────────────────────────────
        mcp_service = request.env['mcp.client.service'].sudo()

        messages_count     = len(session.message_ids)
        unsummarized_count = messages_count - session.last_summarized_count

        if unsummarized_count >= 10:
            messages_to_summarize = session.get_conversation_history()[-unsummarized_count:]
            summary_prefix = [{
                'role':    'system',
                'content': f'Summary of the conversation so far, keep it as it is: {session.history_summary or ""}',
            }]
            new_summary = mcp_service.summarize_history(summary_prefix + messages_to_summarize)
            session.sudo().write({
                'history_summary':       new_summary,
                'last_summarized_count': messages_count,
            })
            unsummarized_count = 0

        unsummarized_messages = (
            session.get_conversation_history()[-unsummarized_count:]
            if unsummarized_count > 0 else []
        )

        conversation_history = [
            {
                'role':    'system',
                'content': f'Summary of the conversation so far, keep it as it is: {session.history_summary or ""}',
            }
        ] + unsummarized_messages

        if partner_id:
            identity_msg = (
                f"Current authenticated user: "
                f"name='{request.env.user.partner_id.name}', "
            )
        else:
            identity_msg = (
                "Current user: not logged in (anonymous visitor)."
            )

        conversation_history = [
            {
                'role':    'system',
                'content': identity_msg,
            }
        ] + conversation_history

        # ── RAG: user_id for long-term memory ────────────────────────────
        user_id = str(partner_id) if partner_id else f"anon_{session_token[:16]}"

        # ── RAG: retrieve and inject long-term memories ──────────────────
        if partner_id:
            try:
                memory_service = _get_memory_service()
                memories = memory_service.retrieve_memories(user_id, user_message, n_results=5)
                if memories:
                    memory_context = "LONG-TERM MEMORY — facts known about this user:\n"
                    memory_context += "\n".join(f"- {m}" for m in memories)
                    conversation_history = [
                        {'role': 'system', 'content': memory_context}
                    ] + conversation_history
                    _logger.info(
                        'mcp_chatbot: injected %d memories for user %s', len(memories), user_id
                    )
            except Exception as exc:
                _logger.error('mcp_chatbot: memory retrieval failed: %s', exc)

        # ── Call MCP pipeline ────────────────────────────────────────────
        try:
            ai_reply = mcp_service.process_message(user_message, conversation_history, partner_id)
        except Exception as exc:
            _logger.error('mcp_chatbot: MCP pipeline error: %s', exc)
            ai_reply = 'Sorry, I encountered an error. Please try again.'

        # ── Persist assistant reply ──────────────────────────────────────
        Message.create({
            'session_id': session.id,
            'role':       'assistant',
            'content':    ai_reply,
        })

        # ── Extract and store facts in background thread ─────────────────
        if partner_id:
            try:
                fact_extractor = _get_fact_extractor()
                memory_service = _get_memory_service()
                fact_extractor.extract_facts_async(
                    api_key=GROQ_API_KEY,
                    user_id=user_id,
                    user_message=user_message,
                    bot_response=ai_reply,
                    memory_service_module=memory_service,
                )
                _logger.info('mcp_chatbot: fact extraction triggered for user %s', user_id)
            except Exception as exc:
                _logger.error('mcp_chatbot: fact extraction trigger failed: %s', exc)

        return {'reply': ai_reply, 'session_token': session_token}

    # ------------------------------------------------------------------ #
    # POST /mcp_chatbot/welcome                                            #
    # ------------------------------------------------------------------ #

    @http.route(
        '/mcp_chatbot/welcome',
        type='json',
        auth='public',
        methods=['POST'],
        website=True,
        csrf=False,
    )
    def welcome(self, session_token: str, **kwargs):
        """
        Generate a personalised welcome message WITHOUT creating a session.
        Session is created lazily on the first real user message.
        """
        partner_name = 'there'
        if not request.env.user._is_public():
            partner_name = request.env.user.partner_id.name

        welcome_prompt = (
            f"Generate a short, friendly, and professional welcome message "
            f"for a user named {partner_name}. "
            f"Introduce yourself as an AI assistant for an e commerce platform that sells home appliances and electronics in Tunisia. "
            f"Ask how you can help them today. Keep it to 2 sentences maximum."
        )

        mcp_service = request.env['mcp.client.service'].sudo()

        try:
            welcome_msg = mcp_service.process_message(welcome_prompt, [])
        except Exception as exc:
            _logger.error('mcp_chatbot: welcome generation error: %s', exc)
            welcome_msg = f'Hello {partner_name}! How can I help you today?'

        # No session created here — browser only
        return {'welcome': welcome_msg}

    # ------------------------------------------------------------------ #
    # POST /mcp_chatbot/history                                            #
    # ------------------------------------------------------------------ #

    @http.route(
        '/mcp_chatbot/history',
        type='json',
        auth='public',
        methods=['POST'],
        website=True,
        csrf=False,
    )
    def history(self, session_token: str, **kwargs):
        """
        Return the full message history for a session token.
        Called by the frontend every time the widget is opened.
        This is the single source of truth — no history in localStorage.

        For logged-in users, the backend first looks up their most recent open
        session by partner_id. This ensures history is restored even when the
        browser token is stale (e.g. after an anonymous session was created in
        between, or the cron closed the old session and the token was wiped).
        The real session_token is returned so the browser can adopt it.

        Returns:
            { "status": "open",      "messages": [...], "session_token": "..." }
            { "status": "closed",    "messages": [] }
            { "status": "not_found", "messages": [] }
            { "status": "mismatch",  "messages": [] }
        """
        if not session_token:
            return {'status': 'not_found', 'messages': []}

        # ── Resolve partner if logged in ────────────────────────────────────
        partner_id = None
        if not request.env.user._is_public():
            partner_id = request.env.user.partner_id.id

        # ── Authenticated users: recover session by partner_id first ────────
        # This is the key fix: the DB is the source of truth for logged-in
        # users, not the browser token. If Mitchell logs out, has an anonymous
        # chat, then logs back in — his token in sessionStorage may be stale or
        # gone, but his session still exists in the DB tied to his partner_id.
        # We find it here and hand the correct token back to the browser.
        if partner_id:
            partner_session = request.env['mcp.chatbot.session'].sudo().search([
                ('partner_id', '=', partner_id),
                ('state',      '=', 'open'),
            ], order='create_date desc', limit=1)

            if partner_session:
                messages = []
                for msg in partner_session.message_ids.sorted('create_date'):
                    messages.append({
                        'role':    msg.role,
                        'content': msg.content,
                    })
                # Return the real token so the browser adopts it if it differs
                return {
                    'status':        'open',
                    'messages':      messages,
                    'session_token': partner_session.session_token,
                }

        # ── Anonymous users (or no open partner session found): fall back to
        # token-based lookup ─────────────────────────────────────────────────
        session = request.env['mcp.chatbot.session'].sudo().search([
            ('session_token', '=', session_token),
        ], limit=1)

        if not session:
            return {'status': 'not_found', 'messages': []}

        if session.state == 'closed':
            return {'status': 'closed', 'messages': []}

        # ── Guard: session belongs to a different user ───────────────────────
        existing_partner = session.partner_id.id or None
        if existing_partner != partner_id:
            # Return mismatch so the frontend resets the token
            return {'status': 'mismatch', 'messages': []}

        messages = []
        for msg in session.message_ids.sorted('create_date'):
            messages.append({
                'role':    msg.role,
                'content': msg.content,
            })

        return {'status': 'open', 'messages': messages, 'session_token': session_token}

    # ------------------------------------------------------------------ #
    # POST /mcp_chatbot/close                                              #
    # ------------------------------------------------------------------ #

    @http.route(
        '/mcp_chatbot/close',
        type='json',
        auth='public',
        methods=['POST'],
        website=True,
        csrf=False,
    )
    def close_session(self, session_token: str = None, **kwargs):
        if session_token:
            session = request.env['mcp.chatbot.session'].sudo().search([
                ('session_token', '=', session_token),
                ('state', '=', 'open'),
            ], limit=1)
            if session:
                session.action_close()

        return {'status': 'closed'}