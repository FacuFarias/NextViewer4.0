FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.d/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod 755 /docker-entrypoint.d/40-runtime-config.sh

ENV DICOMWEB_ROOT=/dcm4chee-arc/aets/DCM4CHEE/rs \
    WADO_URI_ROOT=/dcm4chee-arc/aets/DCM4CHEE/wado \
    KEYCLOAK_AUTHORITY=https://clinicacp.ddns.net:8090/realms/dcm4che \
    KEYCLOAK_CLIENT_ID=ohif-viewer \
    TOKEN_HANDOFF_CLIENT_IDS=dcm4chee-arc-ui,ohif-viewer \
    OIDC_REDIRECT_URI=https://clinicacp.ddns.net:3000/callback \
    OIDC_POST_LOGOUT_REDIRECT_URI=https://clinicacp.ddns.net:3000/ \
    SHARE_GATEWAY_ROOT=https://clinicacp.ddns.net:3001/api/general/share-dicom

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
