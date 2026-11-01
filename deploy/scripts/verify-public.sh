#!/usr/bin/env bash
# Checks the PUBLIC site end to end through Nginx and TLS. Sends no transactions.
#   bash deploy/scripts/verify-public.sh [https://changebounty.ogsnap.online]
set -uo pipefail

BASE="${1:-https://changebounty.ogsnap.online}"
HOST="${BASE#https://}"
fail=0
pass() { echo "PASS  $1"; }
bad()  { echo "FAIL  $1"; fail=$((fail + 1)); }

code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@"; }

[ "$(code "$BASE/")" = "200" ] && pass "Web app loads over HTTPS" || bad "Web app loads over HTTPS"
loc="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 "http://$HOST/")"
case "$loc" in 301*https://*|308*https://*) pass "HTTP redirects to HTTPS" ;; *) bad "HTTP redirects to HTTPS ($loc)" ;; esac

health="$(curl -s --max-time 15 "$BASE/api/health")"
echo "$health" | grep -q '"ok":true' && pass "API health: $health" || bad "API health ($health)"

cfg="$(curl -s --max-time 15 "$BASE/api/config")"
echo "$cfg" | grep -q "\"demoUrl\":\"$BASE/api/demo-site/announcements\"" && pass "Config advertises the public demo URL" || bad "Config demoUrl does not match $BASE"
echo "$cfg" | grep -qiE 'private|secret|token' && bad "Config response contains a secret-looking word" || pass "Config response has no secret fields"

page="$(curl -s --max-time 15 "$BASE/api/demo-site/announcements")"
echo "$page" | grep -q "Announcements" && pass "Public demo page is served" || bad "Public demo page is served"

v="$(curl -s --max-time 15 -X POST "$BASE/api/validate-url" -H 'content-type: application/json' -d '{"url":"http://169.254.169.254/latest/meta-data/"}')"
echo "$v" | grep -q '"ok":false' && pass "SSRF guard blocks cloud metadata address" || bad "SSRF guard ($v)"

[ "$(code -X POST "$BASE/api/demo/publish" -H 'content-type: application/json' -H 'authorization: Bearer wrong' -d '{}')" = "401" ] \
  && pass "Publish rejects a wrong token" || bad "Publish rejects a wrong token"

dot="$(curl -s --max-time 15 "$BASE/.env")"
echo "$dot" | grep -qE 'PRIVATE_KEY|ADMIN_TOKEN' && bad "/.env leaks secrets" || pass "/.env is not served"
[ "$(code "$BASE/.git/config")" = "404" ] && pass "/.git is blocked" || bad "/.git is blocked"

hdrs="$(curl -sI --max-time 15 "$BASE/")"
echo "$hdrs" | grep -qi 'strict-transport-security' && pass "HSTS header present" || bad "HSTS header present"
echo "$hdrs" | grep -qi 'x-content-type-options: nosniff' && pass "nosniff header present" || bad "nosniff header present"

if command -v openssl >/dev/null 2>&1; then
  end="$(echo | openssl s_client -servername "$HOST" -connect "$HOST:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  [ -n "$end" ] && pass "TLS certificate valid until $end" || bad "TLS certificate readable"
fi

if [ "$fail" -eq 0 ]; then echo; echo "All public checks passed."; else echo; echo "$fail check(s) failed."; fi
exit "$fail"
