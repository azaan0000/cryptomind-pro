#!/data/data/com.termux/files/usr/bin/bash
# CryptoMind PRO — Relay script
# Runs on your phone (via Termux), using YOUR home/mobile internet IP
# to talk to Binance — bypassing the cloud-IP block that Cloudflare/
# Render/Fixie all run into.
#
# SETUP (one time):
#   pkg update -y
#   pkg install curl jq -y
#   chmod +x relay.sh
#
# RUN:
#   ./relay.sh
#
# Keep Termux running in the background: in Android Settings > Apps >
# Termux > Battery, set to "Unrestricted" so Android doesn't kill it.
# Also run `termux-wake-lock` once (needs termux-api package) to stop
# the phone from sleeping the script.

WORKER_URL="https://cryptomind-pro-backend.azaanbk30.workers.dev"
SECRET="e66f8d334e60c3550e0a7fd9799312b8d71b1789"

echo "=================================================="
echo " CryptoMind PRO relay — connecting via your network"
echo " Worker: $WORKER_URL"
echo "=================================================="

while true; do
  JOBS=$(curl -s --max-time 10 "$WORKER_URL/relay-poll?secret=$SECRET")
  COUNT=$(echo "$JOBS" | jq '.jobs | length' 2>/dev/null)

  if [ -n "$COUNT" ] && [ "$COUNT" != "0" ] && [ "$COUNT" != "null" ]; then
    echo "[$(date '+%H:%M:%S')] $COUNT job(s) received"
    echo "$JOBS" | jq -c '.jobs[]' | while read -r job; do
      JOB_ID=$(echo "$job" | jq -r '.jobId')
      METHOD=$(echo "$job" | jq -r '.method')
      URL=$(echo "$job" | jq -r '.url')
      APIKEY=$(echo "$job" | jq -r '.headers["X-MBX-APIKEY"] // empty')

      echo "  -> $METHOD ${URL:0:60}..."
      RESP=$(curl -s --max-time 15 -X "$METHOD" "$URL" -H "X-MBX-APIKEY: $APIKEY")

      if [ -z "$RESP" ]; then
        PAYLOAD=$(jq -n --arg secret "$SECRET" --arg jobId "$JOB_ID" '{secret:$secret, jobId:$jobId, error:"Empty response from Binance (network issue on phone?)"}')
      else
        PAYLOAD=$(jq -n --arg secret "$SECRET" --arg jobId "$JOB_ID" --arg body "$RESP" '{secret:$secret, jobId:$jobId, responseBody:$body}')
      fi

      curl -s --max-time 10 -X POST "$WORKER_URL/relay-result" \
        -H "Content-Type: application/json" \
        -d "$PAYLOAD" > /dev/null
      echo "  <- result posted for $JOB_ID"
    done
  fi

  sleep 3
done
