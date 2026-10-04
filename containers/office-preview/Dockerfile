FROM gotenberg/gotenberg:8.37.0

# Only local Office uploads are accepted; document links cannot access the network.
ENV CHROMIUM_DISABLE_ROUTES=true \
    API_DISABLE_DOWNLOAD_FROM=true \
    WEBHOOK_DISABLE=true \
    LIBREOFFICE_DENY_LIST=.* \
    API_TIMEOUT=90s

EXPOSE 3000
