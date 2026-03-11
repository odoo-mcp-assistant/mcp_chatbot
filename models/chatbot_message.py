from odoo import models, fields, api


class ChatbotMessage(models.Model):
    """
    A single turn (user or assistant) within a chatbot session.

    Each HTTP request from the website widget produces two records:
      1. role='user'      — the visitor's plain-text message.
      2. role='assistant' — the LLM reply returned by the MCP pipeline.

    Keeping messages as first-class records makes it trivial to:
      - Display the full chat transcript in the backend.
      - Feed history back into the LLM on subsequent turns.
      - Audit what the bot said and when.
    """

    _name = 'mcp.chatbot.message'
    _description = 'MCP Chatbot Message'
    _order = 'create_date asc, id asc'

    # ------------------------------------------------------------------ #
    # Core fields                                                          #
    # ------------------------------------------------------------------ #

    session_id = fields.Many2one(
        'mcp.chatbot.session',
        string='Session',
        required=True,
        ondelete='cascade',
        index=True,
    )

    role = fields.Selection(
        selection=[
            ('user',      'User'),
            ('assistant', 'Assistant'),
        ],
        string='Role',
        required=True,
    )

    # Plain text only — no HTML markup stored here.
    content = fields.Text(
        string='Content',
        required=True,
    )

    # ------------------------------------------------------------------ #
    # Convenience display fields                                           #
    # ------------------------------------------------------------------ #

    partner_id = fields.Many2one(
        related='session_id.partner_id',
        string='Visitor',
        store=True,
    )

    session_token = fields.Char(
        related='session_id.session_token',
        string='Session Token',
        store=True,
    )
