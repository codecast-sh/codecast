#!/usr/bin/env bash
# check-domains.sh domain1.com domain2.app ...
# Checks availability via registry RDAP / registry whois with per-route controls.
# Output: <domain>: AVAILABLE | taken | rate-limited | unknown(<detail>)
set -u

rdap() { curl -s -m 20 -o /dev/null -w "%{http_code}" "$1"; }

CONTROLS_PASSED=" "  # space-separated route keys whose control passed (bash 3.2: no associative arrays)

check_control() {  # $1=route-key $2=control-url-or-whois  $3=mode(rdap|whois:server)
  case "$CONTROLS_PASSED" in *" $1 "*) return 0;; esac
  if [ "$3" = rdap ]; then
    [ "$(rdap "$2")" = 200 ] && CONTROLS_PASSED="$CONTROLS_PASSED$1 " && return 0
  else
    local server="${3#whois:}"
    whois -h "$server" "$2" 2>/dev/null | grep -qi "domain name:" && CONTROLS_PASSED="$CONTROLS_PASSED$1 " && return 0
  fi
  return 1
}

for domain in "$@"; do
  tld="${domain##*.}"
  case "$tld" in
    com|net)
      url="https://rdap.verisign.com/$tld/v1/domain/$domain"
      check_control "verisign-$tld" "https://rdap.verisign.com/$tld/v1/domain/google.$tld" rdap \
        || { echo "$domain: unknown(control failed)"; continue; }
      code=$(rdap "$url") ;;
    app|dev|page|new)
      url="https://pubapi.registry.google/rdap/domain/$domain"
      check_control google "https://pubapi.registry.google/rdap/domain/web.dev" rdap \
        || { echo "$domain: unknown(control failed)"; continue; }
      code=$(rdap "$url"); sleep 5 ;;
    io|sh|so)
      server="whois.nic.$tld"
      case "$tld" in io) ctl=greenhouse.io;; sh) ctl=stat.sh;; so) ctl=notion.so;; esac
      check_control "$server" "$ctl" "whois:$server" \
        || { echo "$domain: unknown(control failed)"; continue; }
      out=$(whois -h "$server" "$domain" 2>/dev/null)
      if echo "$out" | grep -qi "domain name:"; then echo "$domain: taken"
      elif echo "$out" | grep -qiE "not found|no object"; then echo "$domain: AVAILABLE"
      else echo "$domain: unknown(unparsed whois)"; fi
      sleep 1; continue ;;
    co)
      server="whois.registry.co"
      check_control "$server" "vine.co" "whois:$server" \
        || { echo "$domain: unknown(control failed)"; continue; }
      out=$(whois -h "$server" "$domain" 2>/dev/null)
      if echo "$out" | grep -qi "domain name:"; then echo "$domain: taken"
      elif echo "$out" | grep -qiE "not found|no object"; then echo "$domain: AVAILABLE"
      else echo "$domain: unknown(unparsed whois)"; fi
      sleep 1; continue ;;
    *)
      # Generic: resolve endpoint via IANA bootstrap, control via a registered probe is not known.
      base=$(curl -s -m 20 https://data.iana.org/rdap/dns.json | python3 -c "
import json,sys
tld='$tld'
for tlds,urls in json.load(sys.stdin)['services']:
    if tld in tlds: print(urls[0].rstrip('/')); break")
      if [ -z "$base" ]; then echo "$domain: unknown(no RDAP for .$tld; find whois via: whois -h whois.iana.org $tld)"; continue; fi
      code=$(rdap "$base/domain/$domain")
      # No control for arbitrary TLDs: report 404 as likely, not verified.
      case "$code" in
        200) echo "$domain: taken"; continue ;;
        404) echo "$domain: AVAILABLE (unverified route — confirm with a known registered .$tld)"; continue ;;
        429) echo "$domain: rate-limited"; continue ;;
        *)   echo "$domain: unknown(http $code)"; continue ;;
      esac ;;
  esac
  case "$code" in
    200) echo "$domain: taken" ;;
    404) echo "$domain: AVAILABLE" ;;
    429) echo "$domain: rate-limited" ;;
    *)   echo "$domain: unknown(http $code)" ;;
  esac
  sleep 1
done
