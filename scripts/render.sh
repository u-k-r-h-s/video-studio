#!/usr/bin/env bash
# usage: render.sh <vt|x264> <output.mp4>   (run from the feasibility folder)
set -e
cd "$(dirname "$0")/.."
P=test-project
case "$1" in
  vt)   VENC=(-c:v h264_videotoolbox -b:v 10M -maxrate 12M -profile:v high -allow_sw 0) ;;
  x264) VENC=(-c:v libx264 -preset medium -crf 20 -profile:v high) ;;
  *) echo "usage: render.sh <vt|x264> <out.mp4>"; exit 2 ;;
esac
ffmpeg -hide_banner -loglevel error -stats -y \
  -i $P/bg.png \
  -loop 1 -framerate 30 -t 10 -i $P/char.png \
  -loop 1 -framerate 30 -t 10 -i $P/prop.png \
  -loop 1 -framerate 30 -t 10 -i $P/sub1.png \
  -loop 1 -framerate 30 -t 10 -i $P/sub2.png \
  -loop 1 -framerate 30 -t 10 -i $P/sub3.png \
  -i $P/voice_timeline.wav \
  -/filter_complex $P/graph.txt \
  -map "[vout]" -map 6:a "${VENC[@]}" -pix_fmt yuv420p -r 30 \
  -c:a aac -b:a 160k -ar 44100 -t 10 -movflags +faststart "$2"
