# mcp_chatbot/controllers/chatbot_controller.py
import logging

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


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
    def receive_message(self, message: str, session_token: str = None, **kwargs):
        """
        Receive a user message. Creates the session on the first real
        user message (lazy creation).
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

        Message = request.env['mcp.chatbot.message'].sudo()

        # ── Persist user message ─────────────────────────────────────────
        Message.create({
            'session_id': session.id,
            'role':       'user',
            'content':    user_message,
        })

        # ── Read summary token threshold from settings ────────────────────
        summary_token_threshold = int(self._get_param('mcp_chatbot.summary_interval', 2000))

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
        unsummarized_messages = (
            prior_history[-unsummarized_count:]
            if unsummarized_count > 0 else []
        )

        # Estimate tokens for unsummarized messages (~4 chars per token)
        estimated_tokens = sum(
            len(m.get('content', '')) // 4 for m in unsummarized_messages
        )

        did_summarize = False
        if estimated_tokens >= summary_token_threshold:
            summary_prefix = []
            if session.history_summary:
                summary_prefix = [{
                    'role':    'system',
                    'content': (
                        'Here is the previous summary for context — produce a NEW '
                        'standalone summary that incorporates both this and the new '
                        'messages below. Do NOT just append to it:\n\n'
                        f'{session.history_summary}'
                    ),
                }]
            new_summary = mcp_service.summarize_history(summary_prefix + unsummarized_messages)
            session.sudo().write({
                'history_summary':       new_summary,
                'last_summarized_count': prior_count,
            })
            # Flush before the MCP loop: the MCP server writes partner_id to
            # this same session row via JSON-RPC in its own transaction, and
            # holding our write open for the ~60–90 s tool loop causes a
            # serialization conflict on final commit → Odoo retries the
            # whole request → duplicate tool calls.
            request.env.cr.commit()
            unsummarized_messages = []
            did_summarize = True

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

        # ── Inject stored user facts ─────────────────────────────────────
        # All facts for the authenticated partner are read from the Odoo
        # model and injected verbatim. No vector search — the per-user fact
        # set is small enough to send whole; the LLM filters by relevance.
        if effective_partner_id:
            try:
                UserFact = request.env['mcp.chatbot.user.fact'].sudo()
                facts = UserFact.search(
                    [('partner_id', '=', effective_partner_id)],
                    order='create_date desc',
                )
                if facts:
                    fact_lines = [
                        f"- [{(f.category or 'general')}] {f.fact_text}"
                        for f in facts
                    ]
                    fact_context = (
                        "KNOWN FACTS ABOUT THIS USER (personal preferences / history — "
                        "NOT current inventory or product data; use only to personalise "
                        "recommendations and responses):\n" + "\n".join(fact_lines)
                    )
                    conversation_history = [
                        {'role': 'system', 'content': fact_context}
                    ] + conversation_history
                    _logger.info(
                        'mcp_chatbot: injected %d stored facts for partner %s',
                        len(facts), effective_partner_id,
                    )
            except Exception as exc:
                _logger.error('mcp_chatbot: fact injection failed: %s', exc)

        print(f"\n{'*'*80}\n[CONVERSATION HISTORY] {len(conversation_history)} messages:\n" + "\n".join(f"  [{m['role'].upper()}] {m['content'][:150]}{'...' if len(m['content'])>150 else ''}" for m in conversation_history) + f"\n[USER MSG] {user_message}\n{'*'*80}\n")

        # ── Call MCP pipeline ────────────────────────────────────────────
        try:
            ai_reply, new_verified_partner_id = mcp_service.process_message(
                user_message, conversation_history,
                authenticated_partner_id=effective_partner_id,
                session_id = session.id
            )
        except Exception as exc:
            _logger.error('mcp_chatbot: MCP pipeline error: %s', exc)
            ai_reply, new_verified_partner_id = 'Sorry, I encountered an error. Please try again.', None

        # Session ↔ partner linkage is handled inside the MCP server's
        # verify_email_otp tool (same transaction as the partner create).
        # We only update the in-memory variable so the rest of this
        # request knows the caller is now verified.
        if new_verified_partner_id:
            effective_partner_id = effective_partner_id or new_verified_partner_id

        # ── Persist assistant reply ──────────────────────────────────────
        Message.create({
            'session_id': session.id,
            'role':       'assistant',
            'content':    ai_reply,
        })

        # ── Touch activity — resets the idle timeout clock ───────────────
        # Skip when verify_email_otp just wrote partner_id to this session
        # row via JSON-RPC (already committed).  Writing last_activity here
        # would hit a PostgreSQL serialization conflict on the same row,
        # trigger an Odoo retry of the entire request, and re-process the
        # message (duplicate tool calls, consumed OTP, etc.).
        if not new_verified_partner_id:
            session.touch_activity()

        # Facts are no longer extracted here — the LLM saves them itself via
        # the `remember_fact` tool inside the agentic loop when it decides a
        # statement is durable enough to keep.

        return {'reply': ai_reply, 'summarized': did_summarize}

    # ------------------------------------------------------------------ #
    # POST /mcp_chatbot/info                                               #
    # ------------------------------------------------------------------ #

    @http.route(
        '/mcp_chatbot/info',
        type='json',
        auth='public',
        methods=['POST'],
        website=True,
        csrf=False,
    )
    def info(self):
        """Return chatbot metadata + current user identity for the
        frontend hero greeting."""
        is_authenticated = not request.env.user._is_public()
        first_name = ''
        if is_authenticated:
            full_name = (request.env.user.partner_id.name or '').strip()
            first_name = full_name.split(' ')[0] if full_name else ''
        return {
            'bot_name':         self._get_param('mcp_chatbot.bot_name', 'AI Assistant'),
            'status':           self._get_param('mcp_chatbot.status', 'online'),
            'is_authenticated': is_authenticated,
            'first_name':       first_name,
        }

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
            { "status": "open",      "messages": [...] }
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
    def close_session(self, session_token: str = None, rating: str = None, feedback: str = None, **kwargs):
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
            _logger.info('mcp_chatbot close: rating=%r, feedback=%r', rating, feedback)
            if rating and rating in ('bad', 'neutral', 'good'):
                try:
                    vals = {
                        'session_id': session.id,
                        'rating_text': rating,
                        'feedback': feedback or '',
                    }
                    if session.partner_id:
                        vals['partner_id'] = session.partner_id.id
                    request.env['mcp.chatbot.rating'].sudo().create(vals)
                except Exception as exc:
                    _logger.error('mcp_chatbot: failed to save rating: %s', exc)

            session.action_close()

        return {'status': 'closed'}