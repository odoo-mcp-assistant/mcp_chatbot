import logging

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


class MCPChatbotController(http.Controller):
    """
    JSON endpoints consumed by the website chatbot widget.

    All routes live under /mcp_chatbot/ to avoid collisions with
    built-in livechat routes.
    """

    # ------------------------------------------------------------------ #
    # POST /mcp_chatbot/message                                            #
    # ------------------------------------------------------------------ #

    @http.route(
        '/mcp_chatbot/message',
        type='json',
        auth='public',          # Accessible to unauthenticated website visitors
        methods=['POST'],
        website=True,
        csrf=False,
    )
    def receive_message(self, session_token: str, message: str, **kwargs):
        """
        Receive a user message from the website widget, run it through the
        MCP pipeline, persist both turns, and return the assistant reply.

        Request body (JSON):
            {
                "session_token": "<uuid>",
                "message":       "<plain text from visitor>"
            }

        Response body (JSON):
            {
                "reply":         "<assistant plain text>",
                "session_token": "<uuid>"
            }
        """

        # ── Validate input ──────────────────────────────────────────────
        if not session_token or not message or not message.strip():
            return {'error': 'session_token and message are required'}

        user_message = message.strip()

        # ── Resolve partner if logged in ────────────────────────────────
        partner_id = None
        if not request.env.user._is_public():
            partner_id = request.env.user.partner_id.id

        # ── Get or create session ────────────────────────────────────────
        Session = request.env['mcp.chatbot.session'].sudo()
        session = Session.get_or_create_session(session_token, partner_id=partner_id)

        # ── Touch activity — resets the idle timeout clock ───────────────
        session.touch_activity()

        # ── Persist user message ─────────────────────────────────────────
        Message = request.env['mcp.chatbot.message'].sudo()
        Message.create({
            'session_id': session.id,
            'role':       'user',
            'content':    user_message,
        })

        # ── Build conversation history for the LLM ───────────────────────
        # We mirror the summarisation logic from odoo_mcp_addon:
        # every 10 unsummarised messages we compress the history first.
        mcp_service = request.env['mcp.client.service'].sudo()

        messages_count = len(session.message_ids)
        unsummarized_count = messages_count - session.last_summarized_count

        if unsummarized_count >= 10:

            # Get the messages to summarize
            messages_to_summarize = session.get_conversation_history()[-unsummarized_count:]

            #Get the content of the existing summary
            summary_prefix = [{
                'role':    'system',
                'content': (
                    f'Summary of the conversation so far, keep it as it is: '
                    f'{session.history_summary or ""}'
                ),
            }]

            # Generate a new summary — summarize_history lives on mcp.client.service
            new_summary = mcp_service.summarize_history(summary_prefix + messages_to_summarize)

            #Update the session summary and reset the unsummarized counter
            session.sudo().write({
                'history_summary':       new_summary,
                'last_summarized_count': messages_count,
            })

            #Recalculate after summarizing so the fetch below uses the updated value
            unsummarized_count = 0

            """
                messages_count = 8  → unsummarized = 8  → no summary → fetch 8 unsummarized
                messages_count = 10 → unsummarized = 10 → summarize  → recalculate = 0 → fetch 0 unsummarized
                messages_count = 14 → unsummarized = 4  → no summary → fetch 4 unsummarized
                messages_count = 20 → unsummarized = 10 → summarize  → recalculate = 0 → fetch 0 unsummarized
            """

        #Get the unsummarized messages (tail only)
        unsummarized_messages = (
            session.get_conversation_history()[-unsummarized_count:]
            if unsummarized_count > 0 else []
        )

        #Get the content of the summary
        summary_content = [{
            'role':    'system',
            'content': (
                f'Summary of the conversation so far, keep it as it is: '
                f'{session.history_summary or ""}'
            ),
        }]

        #Add the summary to the unsummarized messages
        conversation_history = summary_content + unsummarized_messages

        # ── ADD USER GENERAL INFO TO CONVERSATION HISTORY ───────────────
        # Insert a system message with the visitor identity so the LLM
        # can personalise its reply (mirrors user_info injection in mail_message.py)
        user_info = {
            'id':   partner_id,
            'name': request.env.user.partner_id.name if partner_id else 'Anonymous Visitor',
        }
        conversation_history = [
            {
                'role':    'system',
                'content': (
                    f'You are talking to: {user_info}. '
                    'Use this information to personalise your responses.'
                ),
            }
        ] + conversation_history

        # ── Call MCP pipeline ────────────────────────────────────────────
        try:
            ai_reply = mcp_service.process_message(user_message, conversation_history)
        except Exception as exc:
            _logger.error('mcp_chatbot: MCP pipeline error: %s', exc)
            ai_reply = 'Sorry, I encountered an error. Please try again.'

        # ── Persist assistant message ────────────────────────────────────
        Message.create({
            'session_id': session.id,
            'role':       'assistant',
            'content':    ai_reply,
        })

        return {
            'reply':         ai_reply,
            'session_token': session_token,
        }


    # ------------------------------------------------------------------ #
    # POST /mcp_chatbot/session_status                                     #
    # ------------------------------------------------------------------ #

    @http.route(
        '/mcp_chatbot/session_status',
        type='json',
        auth='public',
        methods=['POST'],
        website=True,
        csrf=False,
    )
    def session_status(self, session_token: str, **kwargs):
        """
        Returns whether the session for the given token is still open.
        Used by the frontend on page load to detect if the idle-timeout
        cron has closed the session, so localStorage can be wiped.

        Response: { "status": "open" | "closed" | "not_found" }
        """
        if not session_token:
            return {'status': 'not_found'}

        session = request.env['mcp.chatbot.session'].sudo().search([
            ('session_token', '=', session_token),
        ], limit=1)

        if not session:
            return {'status': 'not_found'}

        return {'status': session.state}