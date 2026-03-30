import logging

from odoo import api, models

_logger = logging.getLogger(__name__)


class ResUsers(models.Model):
    _inherit = 'res.users'

    @api.model
    def _signup_create_user(self, values):
        """Reuse an existing bare res.partner (no portal account) when a user
        signs up with the same email, instead of creating a duplicate."""
        if 'partner_id' not in values:
            email = values.get('email') or values.get('login')
            if email:
                existing = self.env['res.partner'].sudo().search([
                    ('email', '=ilike', email),
                    ('user_ids', '=', False),
                ], limit=1)
                if existing:
                    _logger.info(
                        'Signup: reusing existing partner %s (id=%s) for %s',
                        existing.name, existing.id, email,
                    )
                    values['partner_id'] = existing.id
                    # Update the partner name if signup provides a real name
                    signup_name = values.get('name')
                    if signup_name and signup_name != existing.name:
                        existing.sudo().write({'name': signup_name})
        return super()._signup_create_user(values)
