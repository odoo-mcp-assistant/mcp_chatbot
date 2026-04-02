from odoo import models, fields



class ChatbotRating(models.Model):
    _name = 'mcp.chatbot.rating'
    _description = 'Chatbot Session Rating'



    partner_id = fields.Many2one('res.partner', string="User")
    session_id = fields.Many2one('mcp.chatbot.session', string="Session")
    rating_text = fields.Selection([
        ('none', 'No Rating Yet'),
        ('bad', 'Bad'),
        ('neutral', 'Neutral'),
        ('good', 'Good'),
    ], default='none', string="Rating")

    feedback = fields.Text(string="Comment")
    create_date = fields.Datetime(string="Submitted On")