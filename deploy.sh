#!/usr/bin/env bash
# Deploy alexrussell.io to production, then ping IndexNow so Bing and
# DuckDuckGo recrawl without waiting on their schedule.
set -euo pipefail
cd "$(dirname "$0")"

vercel deploy --prod

curl -s -X POST "https://api.indexnow.org/indexnow" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"host":"alexrussell.io","key":"3b19a7197fcb98afbc4cebc261492e91","keyLocation":"https://alexrussell.io/3b19a7197fcb98afbc4cebc261492e91.txt","urlList":["https://alexrussell.io/"]}' \
  -o /dev/null -w "indexnow ping: HTTP %{http_code}\n"
