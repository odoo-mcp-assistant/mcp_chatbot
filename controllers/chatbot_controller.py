# mcp_chatbot/controllers/chatbot_controller.py
import logging
import os

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Service loaders — load services/ files by absolute path so they work
# inside Odoo without package context issues.
# ---------------------------------------------------------------------------

def _get_fact_extractor():
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
    import sys, importlib.util
    services_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'services'))

    # Add services dir to sys.path so 'import embedding_service' inside
    # memory_service.py resolves correctly
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

    def _get_param(self, key, default=None):
        return request.env['ir.config_parameter'].sudo().get_param(key, default)

    # ------------------------------------------------------------------ #
    # POST /mcp_chatbot/get_uid                                           #
    # ------------------------------------------------------------------ #

    @http.route(
        '/mcp_chatbot/get_uid',
        type='json',
        auth='public',
        methods=['POST'],
        website=True,
        csrf=False,
    )
    def get_uid(self, **kwargs):
        """
        Return the current user's partner ID (UID) for frontend usage.
        This ensures the frontend gets the correct UID directly from the backend.
        
        Returns:
            {'uid': '2'} for logged-in users
            {'uid': '0'} for anonymous/public users
        """
        if not request.env.user._is_public():
            uid = str(request.env.user.partner_id.id)
        else:
            uid = '0'
        
        return {'uid': uid}

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
    def receive_message(self, message: str, session_token: str = None, welcome: str = None, **kwargs):
        """
        Receive a user message. Creates the session on the first real
        user message (lazy creation). If 'welcome' is provided it means
        this is the first message — persist the welcome text first so
        the LLM has full context.
        """

        if not message or not message.strip():
            return {'error': 'message is required'}

        user_message = message.strip()

        # ── Resolve partner if logged in ────────────────────────────────
        partner_id = None
        if not request.env.user._is_public():
            partner_id = request.env.user.partner_id.id

        # ── Get or create session ──────────────────────────────────────
        Session = request.env['mcp.chatbot.session'].sudo()
        if partner_id:
            # Logged‑in user: session identified by partner_id
            session = Session.get_or_create_session(partner_id=partner_id)
        else:
            # Anonymous user: session identified by token (must be provided)
            if not session_token:
                return {'error': 'session_token is required for anonymous users'}
            session = Session.get_or_create_session(session_token=session_token)

        # Anonymous users that already completed OTP verification in a prior
        # message get their verified partner treated as authenticated.
        effective_partner_id = partner_id or (session.partner_id.id if session.partner_id else None)

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

        # ── Read summary interval from settings ──────────────────────────
        summary_interval = int(self._get_param('mcp_chatbot.summary_interval', 10))

        # ── Build conversation history ───────────────────────────────────
        # IMPORTANT: _async_process_message() already appends the current
        # user message as the final {"role": "user"} turn, so we must
        # exclude it here to avoid:
        #   (a) the message being buried inside the summary when the
        #       summarisation threshold is hit on this very turn, leaving
        #       the LLM with no direct user turn to respond to;
        #   (b) the message appearing twice (once in unsummarized history,
        #       once appended by process_message) on normal turns.
        # We work only with "prior history" — everything before the
        # message we just persisted above.
        mcp_service = request.env['mcp.client.service'].sudo()

        all_history   = session.get_conversation_history()
        prior_history = all_history[:-1] if all_history else []   # exclude current user msg
        prior_count   = len(prior_history)

        unsummarized_count = prior_count - session.last_summarized_count

        if unsummarized_count >= summary_interval:
            messages_to_summarize = prior_history[-unsummarized_count:]
            summary_prefix = []
            if session.history_summary:
                summary_prefix = [{
                    'role':    'system',
                    'content': f'Previous summary to extend: {session.history_summary}',
                }]
            new_summary = mcp_service.summarize_history(summary_prefix + messages_to_summarize)
            session.sudo().write({
                'history_summary':       new_summary,
                'last_summarized_count': prior_count,
            })
            unsummarized_count = 0

        unsummarized_messages = (
            prior_history[-unsummarized_count:]
            if unsummarized_count > 0 else []
        )

        # Only inject the summary block when a summary actually exists,
        # otherwise the LLM misreads the raw messages after it as summarised content.
        summary_block = []
        if session.history_summary:
            summary_block = [{
                'role':    'system',
                'content': f'Summary of the conversation so far: {session.history_summary}',
            }]

        conversation_history = summary_block + unsummarized_messages

        # ── Identity context injection ───────────────────────────────────
        if partner_id:
            # Type 3 — full portal / internal login via Odoo session
            identity_msg = (
                f"Current authenticated user (portal account): "
                f"name='{request.env.user.partner_id.name}'."
            )
        elif session.partner_id:
            vp = session.partner_id
            if vp.user_ids:
                # Type 3 edge-case — OTP email matched an existing portal account
                identity_msg = (
                    f"Current user: verified via email OTP and has a portal account. "
                    f"name='{vp.name}', email='{vp.email}'. "
                    f"They can use all authentication-required actions."
                )
            else:
                # Type 2 — OTP-verified contact (no Odoo account, just a partner record)
                identity_msg = (
                    f"Current user: verified via email OTP (contact only, no portal account). "
                    f"name='{vp.name}', email='{vp.email}'. "
                    f"They can use authentication-required actions."
                )
        else:
            # Type 1 — fully anonymous
            identity_msg = (
                "Current user: not logged in (anonymous visitor)."
            )

        conversation_history = [
            {
                'role':    'system',
                'content': identity_msg,
            }
        ] + conversation_history

        # ── RAG: retrieve and inject long-term memories ──────────────────
        user_id = str(effective_partner_id) if effective_partner_id else None

        # Only for authenticated/verified users — pure anonymous sessions have no stored facts
        if user_id:
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
            ai_reply, new_verified_partner_id = mcp_service.process_message(
                user_message, conversation_history,
                authenticated_partner_id=effective_partner_id,
            )
        except Exception as exc:
            _logger.error('mcp_chatbot: MCP pipeline error: %s', exc)
            ai_reply, new_verified_partner_id = 'Sorry, I encountered an error. Please try again.', None

        # If the OTP flow completed in this turn, persist partner_id on the session
        if new_verified_partner_id and not session.partner_id:
            try:
                # Validate that the partner actually exists before writing
                partner = request.env['res.partner'].sudo().browse(new_verified_partner_id)
                if partner.exists():
                    session.sudo().write({'partner_id': new_verified_partner_id})
                    effective_partner_id = new_verified_partner_id
                    user_id = str(new_verified_partner_id)
                else:
                    _logger.warning(
                        'mcp_chatbot: OTP returned partner_id=%s but record does not exist',
                        new_verified_partner_id,
                    )
            except Exception as exc:
                _logger.error('mcp_chatbot: failed to persist verified partner: %s', exc)

        # ── Persist assistant reply ──────────────────────────────────────
        Message.create({
            'session_id': session.id,
            'role':       'assistant',
            'content':    ai_reply,
        })

        # ── RAG: extract and store facts in background thread ────────────
        # Only for authenticated users — anonymous sessions are not persisted
        if user_id:
            try:
                # Read API key and fact extraction model from settings
                param = request.env['ir.config_parameter'].sudo()
                api_key = param.get_param('mcp_chatbot.api_key', '')
                base_url = param.get_param('mcp_chatbot.base_url', '')
                fact_model_name = ''
                fact_model_id = param.get_param('mcp_chatbot.fact_extraction_model_id')
                if fact_model_id:
                    record = request.env['mcp.llm.model'].sudo().browse(int(fact_model_id))
                    if record.exists():
                        fact_model_name = record.name
                
                rag_system_prompt = param.get_param('mcp_chatbot.rag_system_prompt', '')

                fact_extractor = _get_fact_extractor()
                memory_service = _get_memory_service()
                fact_extractor.extract_facts_async(
                    api_key=api_key,
                    base_url=base_url,
                    extraction_model=fact_model_name,
                    rag_system_prompt=rag_system_prompt,
                    user_id=user_id,
                    user_message=user_message,
                    bot_response=ai_reply,
                    memory_service_module=memory_service,
                    odoo_registry=request.env.registry,
                    odoo_db=request.env.cr.dbname,
                )
                _logger.info('mcp_chatbot: fact extraction triggered for user %s', user_id)
            except Exception as exc:
                _logger.error('mcp_chatbot: fact extraction trigger failed: %s', exc)

        return {'reply': ai_reply}

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
    def welcome(self):
        bot_name = self._get_param('mcp_chatbot.bot_name', 'AI Assistant')

        if not request.env.user._is_public():
            partner_name = request.env.user.partner_id.name
            welcome_msg = (
                f"Hello {partner_name}! Welcome back. "
                f"I'm {bot_name}, your AI assistant for home appliances and electronics. "
                f"How can I help you today?"
            )
        else:
            welcome_msg = (
                f"Hello! I'm {bot_name}, your AI assistant for home appliances and electronics in Tunisia. "
                f"How can I help you today?"
            )

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
    def history(self, session_token: str = None, **kwargs):
        """
        Return the full message history for a session.
        For logged‑in users, the session is identified by partner_id.
        For anonymous users, the session is identified by the provided token.

        Returns:
            { "status": "open",      "messages": [...], "summary_interval": N }
            { "status": "closed",    "messages": [] }
            { "status": "not_found", "messages": [] }
        """
        # ── Resolve partner if logged in ────────────────────────────────────
        partner_id = None
        if not request.env.user._is_public():
            partner_id = request.env.user.partner_id.id

        Session = request.env['mcp.chatbot.session'].sudo()

        # ── Logged‑in user: lookup by partner_id ─────────────────────────────
        if partner_id:
            session = Session.search([
                ('partner_id', '=', partner_id),
                ('state', '=', 'open'),
            ], order='create_date desc', limit=1)
            if not session:
                return {'status': 'not_found', 'messages': []}
            messages = []
            for msg in session.message_ids.sorted('create_date'):
                messages.append({
                    'role':    msg.role,
                    'content': msg.content,
                })
            return {
                'status': 'open',
                'messages': messages,
                'summary_interval': int(self._get_param('mcp_chatbot.summary_interval', 10)),
            }

        # ── Anonymous user: lookup by token ──────────────────────────────────
        if not session_token:
            return {'status': 'not_found', 'messages': []}

        session = Session.search([
            ('session_token', '=', session_token),
        ], limit=1)
        if not session:
            return {'status': 'not_found', 'messages': []}

        if session.state == 'closed':
            return {'status': 'closed', 'messages': []}

        messages = []
        for msg in session.message_ids.sorted('create_date'):
            messages.append({
                'role':    msg.role,
                'content': msg.content,
            })

        return {
            'status': 'open',
            'messages': messages,
            'summary_interval': int(self._get_param('mcp_chatbot.summary_interval', 10)),
        }

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
        """Close a session when the visitor closes the widget."""
        partner_id = None
        if not request.env.user._is_public():
            partner_id = request.env.user.partner_id.id

        Session = request.env['mcp.chatbot.session'].sudo()

        if partner_id:
            session = Session.search([
                ('partner_id', '=', partner_id),
                ('state', '=', 'open'),
            ], limit=1)
        elif session_token:
            session = Session.search([
                ('session_token', '=', session_token),
                ('state', '=', 'open'),
            ], limit=1)
        else:
            session = None

        if session:
            session.action_close()

        return {'status': 'closed'}