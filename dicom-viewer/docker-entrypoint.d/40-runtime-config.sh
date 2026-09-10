#!/bin/sh
set -eu

envsubst '${DICOMWEB_ROOT} ${WADO_URI_ROOT} ${KEYCLOAK_AUTHORITY} ${KEYCLOAK_CLIENT_ID} ${TOKEN_HANDOFF_CLIENT_IDS} ${OIDC_REDIRECT_URI} ${OIDC_POST_LOGOUT_REDIRECT_URI} ${SHARE_GATEWAY_ROOT} ${DOWNLOAD_ENABLED}' \
  < /usr/share/nginx/html/runtime-config.template.js \
  > /usr/share/nginx/html/runtime-config.js
