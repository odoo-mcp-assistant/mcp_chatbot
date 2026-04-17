# mcp_chatbot/controllers/auth_controller.py
"""
JWT issuer for the FastAPI sidecar.

The widget calls POST /mcp_chatbot/auth/token on page load; we look at
the current Odoo HTTP session, mint a short-lived JWT describing the
caller (partner_id for logged-in users, session_token for anonymous),
and hand the widget both the token and the FastAPI base URL. The widget
then talks to FastAPI directly for the rest of the conversation.

The secret and audience live in ir.config_parameter and must match the
values in mcp_chatbot_api/.env (JWT_SECRET, JWT_AUDIENCE, JWT_ALGORITHM).
"""
import logging
import time

from odoo import http
from odoo.http import request

try:
    from jose import jwt
except ImportError:  # pragma: no cover
    jwt = None

_logger = logging.getLogger(__name__)


class AuthController(http.Controller):

    @http.route(
        '/mcp_chatbot/auth/token',
        type='json',
        auth='public',
        methods=['POST'],
        website=True,
        csrf=False,
    )
    def issue_token(self, session_token=None, **kwargs):
        """Return `{token, api_base_url, partner_id, expires_in}`."""
        if jwt is None:
            _logger.error("auth/token: python-jose is not installed")
            return {'error': 'python-jose not installed on Odoo server'}

        param = request.env['ir.config_parameter'].sudo()
        secret = param.get_param('mcp_chatbot.jwt_secret')
        algorithm = param.get_param('mcp_chatbot.jwt_algorithm') or 'HS256'
        audience = param.get_param('mcp_chatbot.jwt_audience') or 'mcp-chatbot-api'
        api_base_url = param.get_param('mcp_chatbot.api_base_url') or ''
        ttl_seconds = int(param.get_param('mcp_chatbot.jwt_ttl_seconds') or 3600)

        if not secret:
            _logger.error("auth/token: mcp_chatbot.jwt_secret is not set")
            return {'error': 'jwt_secret not configured in Odoo'}
        if not api_base_url:
            _logger.error("auth/token: mcp_chatbot.api_base_url is not set")
            return {'error': 'api_base_url not configured in Odoo'}

        user = request.env.user
        partner_id = None
        anonymous = True
        claim_session_token = None

        if user and not user._is_public():
            partner_id = user.partner_id.id
            anonymous = False
        else:
            if not session_token:
                return {'error': 'session_token is required for anonymous users'}
            claim_session_token = session_token

        now = int(time.time())
        claims = {
            'sub': str(partner_id) if partner_id else f'anon:{claim_session_token}',
            'partner_id': partner_id,
            'session_token': claim_session_token,
            'anonymous': anonymous,
            'iat': now,
            'exp': now + ttl_seconds,
            'aud': audience,
        }
        token = jwt.encode(claims, secret, algorithm=algorithm)

        return {
            'token': token,
            'api_base_url': api_base_url,
            'partner_id': partner_id,
            'expires_in': ttl_seconds,
        }
