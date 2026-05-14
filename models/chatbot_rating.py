from odoo import models, fields



class ChatbotRating(models.Model):
    _name = 'mcp.chatbot.rating'
    _description = 'Chatbot Session Rating'

    _sql_constraints = [
        ('unique_session', 'UNIQUE(session_id)', 'Only one rating per session is allowed.'),
    ]

    partner_id = fields.Many2one('res.partner', string="User")
    session_id = fields.Many2one(
        'mcp.chatbot.session',
        string="Session",
        required=True,
        ondelete='cascade',
        domain="[('rating_ids', '=', False)]"
    )
    rating_text = fields.Selection([
        ('none', 'No Rating'),
        ('bad', 'Bad'),
        ('neutral', 'Neutral'),
        ('good', 'Good'),
    ], default='none', string="Rating")

    feedback = fields.Text(string="Comment")
    create_date = fields.Datetime(string="Submitted On")