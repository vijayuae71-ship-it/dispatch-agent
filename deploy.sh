#!/usr/bin/env bash
# Deploy Dispatch Agent to Google Cloud Run. Run it in Google Cloud Shell from
# the repo folder:   bash deploy.sh
#
# Two modes:
#   demo  Only needs an Anthropic API key. Messages and calls stay inside the
#         console; perfect for showing transporters. Data resets on restart.
#   live  Real WhatsApp messages and calls through Twilio, data in Firestore,
#         optional Google Sheet as the order feed.
#
# Safe to run again: keeps existing secrets unless you choose to replace them.
set -euo pipefail

SERVICE=dispatch-agent
SA_NAME=dispatch-agent
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask() { local __v="$1" __q="$2" __d="${3:-}" __a
  if [ -n "$__d" ]; then read -r -p "$__q [$__d]: " __a; else read -r -p "$__q: " __a; fi
  printf -v "$__v" '%s' "${__a:-$__d}"; }
e164() { [[ "$1" =~ ^\+[1-9][0-9]{7,14}$ ]]; }

[ -f package.json ] && grep -q '"name": "dispatch-agent"' package.json || { echo "Run this from the dispatch-agent repo folder." >&2; exit 1; }

say "1/6  Project, region and mode"
ask PROJECT_ID "Google Cloud project ID" "$(gcloud config get-value project 2>/dev/null || true)"
[ -n "$PROJECT_ID" ] || { echo "A project ID is required." >&2; exit 1; }
echo "Region: us-east4 (next to Twilio and Claude, shortest pauses on calls) or asia-south1 (Mumbai, data in India)."
ask REGION "Region" "us-east4"
ask MODE "Mode: demo or live" "demo"
[[ "$MODE" == demo || "$MODE" == live ]] || { echo "Mode must be demo or live." >&2; exit 1; }
ask COMPANY "Company name shown to clients and drivers" "Demo Logistics"
gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

ENVS=("NODE_ENV=production" "MODE=$MODE" "COMPANY_NAME=$COMPANY")
SECRETS="ANTHROPIC_API_KEY=dispatch-anthropic-key:latest,ADMIN_KEY=dispatch-admin-key:latest"
SECRET_NAMES=(dispatch-anthropic-key dispatch-admin-key)
APIS=(run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com iam.googleapis.com)

if [ "$MODE" = live ]; then
  say "2/6  Twilio and dispatch settings (not secret)"
  ask TWILIO_ACCOUNT_SID "Twilio Account SID (starts with AC)"
  ask TWILIO_WHATSAPP_FROM "WhatsApp Business sender number, e.g. +919xxxxxxxxx"
  ask WHATSAPP_CALLS "Escalation calls via WhatsApp calling? (true/false)" "false"
  TWILIO_VOICE_FROM=""
  [ "$WHATSAPP_CALLS" = true ] || ask TWILIO_VOICE_FROM "Phone number for escalation calls (Enter to disable calls)" ""
  ask DISPATCHERS "Dispatcher WhatsApp numbers for alerts, comma-separated" ""
  ask SHEET_ID "Google Sheet ID for orders (Enter to skip)" ""
  [[ "$TWILIO_ACCOUNT_SID" == AC* ]] || { echo "The Account SID should start with AC." >&2; exit 1; }
  e164 "$TWILIO_WHATSAPP_FROM" || { echo "The WhatsApp sender must look like +919812345678." >&2; exit 1; }
  CALLS=true; [ "$WHATSAPP_CALLS" = true ] || [ -n "$TWILIO_VOICE_FROM" ] || CALLS=false
  ENVS+=("STORE=firestore" "GOOGLE_CLOUD_PROJECT=$PROJECT_ID" "TWILIO_ACCOUNT_SID=$TWILIO_ACCOUNT_SID")
  ENVS+=("TWILIO_WHATSAPP_FROM=$TWILIO_WHATSAPP_FROM" "WHATSAPP_CALLS=$WHATSAPP_CALLS" "CALLS_ENABLED=$CALLS")
  if [ -n "$TWILIO_VOICE_FROM" ]; then ENVS+=("TWILIO_VOICE_FROM=$TWILIO_VOICE_FROM"); fi
  if [ -n "$DISPATCHERS" ]; then ENVS+=("DISPATCHER_NUMBERS=${DISPATCHERS// /}"); fi
  if [ -n "$SHEET_ID" ]; then ENVS+=("SHEET_ID=$SHEET_ID"); fi
  SECRETS+=",TWILIO_AUTH_TOKEN=dispatch-twilio-token:latest"
  SECRET_NAMES+=(dispatch-twilio-token)
  APIS+=(firestore.googleapis.com sheets.googleapis.com)
  MIN_INSTANCES=1
else
  say "2/6  Demo mode: no Twilio needed"
  ENVS+=("STORE=memory")
  MIN_INSTANCES=0
fi

say "3/6  Enabling APIs (first run can take a minute or two)"
gcloud services enable "${APIS[@]}"
if [ "$MODE" = live ]; then
  if gcloud firestore databases describe --database='(default)' >/dev/null 2>&1; then
    echo "Using the project's existing Firestore database."
  else
    echo "Creating a Firestore database in $REGION (its location can't be changed later)."
    gcloud firestore databases create --database='(default)' --location="$REGION" --type=firestore-native
  fi
fi

say "4/6  Secrets (what you type is hidden and goes straight to Secret Manager)"
put_secret() { local name="$1" prompt="$2" gen="${3:-}" value="" keep
  if gcloud secrets describe "$name" >/dev/null 2>&1; then
    read -r -p "$name already exists. Replace it? [y/N]: " keep
    [[ "$keep" =~ ^[Yy] ]] || return 0
  fi
  if [ -n "$gen" ]; then
    read -r -s -p "$prompt (Enter to generate one): " value; echo
    if [ -z "$value" ]; then value=$(openssl rand -hex 24); echo "Generated console key: $value"; echo "Save it now; you need it to open the console."; fi
  else
    while [ -z "$value" ]; do read -r -s -p "$prompt: " value; echo; done
  fi
  if gcloud secrets describe "$name" >/dev/null 2>&1; then printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- >/dev/null
  else printf '%s' "$value" | gcloud secrets create "$name" --replication-policy=automatic --data-file=- >/dev/null; fi
  echo "Saved $name."; }
put_secret dispatch-anthropic-key "Anthropic API key (sk-ant-...)"
put_secret dispatch-admin-key "Console admin key" generate
[ "$MODE" = live ] && put_secret dispatch-twilio-token "Twilio Auth Token"

say "5/6  Service account and permissions"
SA_EMAIL="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1 || gcloud iam service-accounts create "$SA_NAME" --display-name="Dispatch Agent Cloud Run"
[ "$MODE" = live ] && gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA_EMAIL" --role=roles/datastore.user --condition=None >/dev/null
for s in "${SECRET_NAMES[@]}"; do
  gcloud secrets add-iam-policy-binding "$s" --member="serviceAccount:$SA_EMAIL" --role=roles/secretmanager.secretAccessor >/dev/null
done
BUILD_SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"
for role in roles/cloudbuild.builds.builder roles/run.builder; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$BUILD_SA" --role="$role" --condition=None >/dev/null 2>&1 || true
done
echo "Done."

say "6/6  Building and deploying (about 3-5 minutes)"
OLD_URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)' 2>/dev/null || true)
if [ -n "$OLD_URL" ]; then ENVS+=("PUBLIC_URL=$OLD_URL"); fi
# "@" separates the variables, so values may contain commas (company names, number lists).
ENV_ARG="^@^$(IFS=@; echo "${ENVS[*]}")"
# One instance: the rules run inside the service, and demo data lives in memory.
gcloud run deploy "$SERVICE" --source . --region "$REGION" --service-account "$SA_EMAIL" \
  --allow-unauthenticated --timeout=3600 --session-affinity --no-cpu-throttling \
  --min-instances="$MIN_INSTANCES" --max-instances=1 --memory=512Mi \
  --set-env-vars "$ENV_ARG" --set-secrets "$SECRETS"

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
if [ "$URL" != "$OLD_URL" ]; then
  gcloud run services update "$SERVICE" --region "$REGION" --update-env-vars "PUBLIC_URL=$URL" >/dev/null
fi
if curl -fsS "$URL/healthz" >/dev/null; then HEALTH="healthy"; else HEALTH="NOT responding yet; check: gcloud run services logs read $SERVICE --region $REGION"; fi

cat <<EOF

==================================================================
 Dispatch Agent is deployed ($MODE mode): $HEALTH

 Console:  $URL
           (sign in with the console admin key)
EOF
if [ "$MODE" = demo ]; then cat <<EOF

 Press "Start demo day", move the clock, and reply as clients and
 drivers. Demo data resets when the service restarts.
EOF
else cat <<EOF

 In Twilio, set your WhatsApp sender's webhooks:
   When a message comes in:  POST  $URL/twilio/whatsapp
   Status callback URL:      POST  $URL/twilio/message-status
 Then create and approve the WhatsApp templates listed in the README
 and add their Content SIDs (see README, "Going live").
EOF
fi
echo "=================================================================="
