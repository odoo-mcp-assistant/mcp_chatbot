# mcp_chatbot/controllers/chatbot_controller.py
import logging

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


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

        # ── Guard: if token belongs to a different user, reject it ───────
        # This prevents anonymous users from hijacking a logged-in session
        # when sessionStorage is not cleared on logout.
        existing = request.env['mcp.chatbot.session'].sudo().search([
            ('session_token', '=', session_token),
            ('state', '=', 'open'),
        ], limit=1)

        if existing:
            existing_partner = existing.partner_id.id or None
            if existing_partner != partner_id:
                # Token belongs to a different user — refuse to add messages
                _logger.warning(
                    'mcp_chatbot: token %s belongs to partner %s but current user is partner %s — rejecting',
                    session_token, existing_partner, partner_id
                )
                return {'error': 'session_mismatch', 'session_token': session_token}

        # ── Get or create session (lazy — created on first real message) ─
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
            f"Introduce yourself as an AI assistant integrated with Odoo ERP. "
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

        Returns:
            { "status": "open", "messages": [...] }
            { "status": "closed" }
            { "status": "not_found" }
        """
        if not session_token:
            return {'status': 'not_found', 'messages': []}

        session = request.env['mcp.chatbot.session'].sudo().search([
            ('session_token', '=', session_token),
        ], limit=1)

        if not session:
            return {'status': 'not_found', 'messages': []}

        if session.state == 'closed':
            return {'status': 'closed', 'messages': []}

        # ── Guard: session belongs to a different user ───────────────────
        partner_id = None
        if not request.env.user._is_public():
            partner_id = request.env.user.partner_id.id

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

        return {'status': 'open', 'messages': messages}