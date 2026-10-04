#!/usr/bin/env bash
# Read-only environment check. Installs nothing and runs no model. Usage: npm run doctor
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"; OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2}"
COMFYUI_DIR="${COMFYUI_DIR:-./comfyui}"; COMFYUI_PYTHON="${COMFYUI_PYTHON:-./venv-comfy/bin/python}"
CKPT="${COMFYUI_CHECKPOINT:-v1-5-pruned-emaonly-fp16.safetensors}"; LORA="${COMFYUI_LORA:-lcm-lora-sdv1-5.safetensors}"
PIPER_PYTHON="${PIPER_PYTHON:-./venv-piper/bin/python}"; VOICES="${PIPER_VOICES_DIR:-./piper-voices}"
ok(){ printf "  \033[32m✓\033[0m %s\n" "$1"; }; miss(){ printf "  \033[31m✗\033[0m %s\n      -> %s\n" "$1" "$2"; }

echo "Runtime"
major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
[ "$major" -ge 20 ] && ok "node $(node -v)" || miss "node 20.12+ required" "https://nodejs.org"
[ "$(uname -s)" = Darwin ] && ok "macOS $(sw_vers -productVersion) ($(uname -m)); VideoToolbox + CoreText subtitles need macOS" || miss "not macOS" "the CoreText subtitle renderer and VideoToolbox encoder are macOS-only"
command -v uv >/dev/null && ok "uv $(uv --version | cut -d' ' -f2) (creates the Python 3.12 venvs)" || miss "uv" "brew install uv  (or: curl -LsSf https://astral.sh/uv/install.sh | sh)"

echo "Ollama (scene planning)"
if tags=$(curl -fsS -m 3 "$OLLAMA_URL/api/tags" 2>/dev/null); then
  ok "Ollama reachable at $OLLAMA_URL"
  echo "$tags" | grep -q "\"name\":\"$OLLAMA_MODEL" && ok "model '$OLLAMA_MODEL' pulled" || miss "model '$OLLAMA_MODEL' not pulled" "ollama pull $OLLAMA_MODEL"
  res=$(curl -fsS -m 3 "$OLLAMA_URL/api/ps" | grep -c '"name"'); [ "$res" = 0 ] && ok "no Ollama model resident (good before image generation)" || echo "  ! an Ollama model is resident; the studio unloads it before ComfyUI starts"
else miss "Ollama not reachable at $OLLAMA_URL" "install https://ollama.com and start it, then: ollama pull $OLLAMA_MODEL"; fi

echo "ComfyUI (images; started on demand by the studio)"
[ -x "$COMFYUI_PYTHON" ] && ok "python venv: $COMFYUI_PYTHON" || miss "ComfyUI venv missing" "uv venv --python 3.12 venv-comfy && uv pip install --python venv-comfy/bin/python -r comfyui/requirements.txt"
[ -f "$COMFYUI_DIR/main.py" ] && ok "ComfyUI at $COMFYUI_DIR" || miss "ComfyUI not found at $COMFYUI_DIR" "git clone https://github.com/comfyanonymous/ComfyUI $COMFYUI_DIR"
[ -f "$COMFYUI_DIR/models/checkpoints/$CKPT" ] && ok "checkpoint $CKPT" || miss "checkpoint $CKPT missing" "see README 'Model installation' (SD 1.5 fp16, ~2.1 GB)"
[ -f "$COMFYUI_DIR/models/loras/$LORA" ] && ok "LoRA $LORA" || miss "LoRA $LORA missing" "see README 'Model installation' (LCM-LoRA, ~135 MB)"
lsof -nP -iTCP:"${COMFYUI_PORT:-8188}" -sTCP:LISTEN >/dev/null 2>&1 && echo "  ! something is already listening on port ${COMFYUI_PORT:-8188}; the studio will refuse to start ComfyUI until it is stopped"

echo "Piper (voices)"
[ -x "$PIPER_PYTHON" ] && "$PIPER_PYTHON" -c "import piper" 2>/dev/null && ok "piper-tts importable" || miss "piper-tts not installed" "uv venv --python 3.12 venv-piper && uv pip install --python venv-piper/bin/python piper-tts"
for m in en_US-libritts_r-medium hi_IN-rohan-medium; do
  [ -f "$VOICES/$m.onnx" ] && ok "voice $m" || miss "voice $m missing" "see README 'Model installation' (check each voice's license first)"
done

echo "FFmpeg + subtitles"
if command -v ffmpeg >/dev/null; then
  ok "$(ffmpeg -version | head -1 | cut -c1-40)"
  ffmpeg -hide_banner -encoders 2>/dev/null | grep -q h264_videotoolbox && ok "h264_videotoolbox encoder" || echo "  ! no VideoToolbox: libx264 software fallback will be used"
else miss "ffmpeg" "brew install ffmpeg"; fi
[ -x bin/subpng ] && ok "CoreText subtitle helper (bin/subpng)" || miss "subtitle helper not built" "npm run build:native  (needs: xcode-select --install)"
