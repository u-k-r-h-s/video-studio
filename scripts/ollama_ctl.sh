#!/usr/bin/env bash
# Tiny Ollama helpers for the feasibility test (fixed endpoints, no user input).
#   ollama_ctl.sh load     -> load llama3.2 (keep_alive 5m) with a tiny prompt
#   ollama_ctl.sh unload   -> evict the model immediately (keep_alive 0)
#   ollama_ctl.sh status   -> what /api/ps reports + any 'ollama runner' processes and their RSS
URL=http://127.0.0.1:11434
case "$1" in
  load)   curl -s $URL/api/generate -d '{"model":"llama3.2","prompt":"Say hi.","stream":false,"keep_alive":"5m","options":{"num_predict":8}}' >/dev/null ;;
  unload) curl -s $URL/api/generate -d '{"model":"llama3.2","keep_alive":0}' >/dev/null ;;
  status)
    echo "api/ps: $(curl -s $URL/api/ps | python3 -c 'import json,sys; m=json.load(sys.stdin)["models"]; print([(x["name"], round(x["size"]/1e6), "MB") for x in m] or "no models loaded")')"
    ps -axo pid=,rss=,command= | grep -E "ollama" | grep -v grep | awk '{printf "  pid %s  rss %.0f MB  %s %s %s\n",$1,$2/1024,$3,$4,$5}' ;;
esac
