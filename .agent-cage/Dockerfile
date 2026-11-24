FROM ghcr.io/jhowliu/agent-cage/base:0.1.2

# Playwright browsers for `npm run e2e`. Keep the version in sync with
# @playwright/test in package.json.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER root
RUN npx -y playwright@1.65.1 install --with-deps chromium webkit \
  && chmod -R a+rX /ms-playwright \
  && rm -rf /var/lib/apt/lists/* /root/.npm
USER agent
