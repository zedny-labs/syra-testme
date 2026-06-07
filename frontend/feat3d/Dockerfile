# ── Var Exam — static site served by nginx ──────────────────────────
FROM nginx:1.27-alpine

# Serve the site from nginx's default web root
COPY . /usr/share/nginx/html

# The entry page has spaces in its name; expose it as index.html
RUN cp "/usr/share/nginx/html/VAR EXAM Experience.html" /usr/share/nginx/html/index.html

# Custom server config (gzip, caching, SPA-style fallback)
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# nginx:alpine already runs the daemon in the foreground via its entrypoint
