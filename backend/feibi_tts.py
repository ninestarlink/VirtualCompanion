"""本地「鸣潮·菲比」音色合成（Genie-TTS / GPT-SoVITS ONNX，CPU 推理）。"""
import json
import os
import sys
import tempfile
import threading
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
MODEL_ROOT = Path(os.environ.get("GENIE_MODEL_DIR", BASE_DIR / "models" / "genie"))
CHARACTER_ROOT = MODEL_ROOT / "CharacterModels" / "v2ProPlus" / "feibi"
DATA_DIR = MODEL_ROOT / "GenieData"

_load_lock = threading.Lock()
_tts_lock = threading.Lock()
_loaded = False
_genie = None


def _prompt_audio() -> tuple[Path, str]:
    meta = json.loads((CHARACTER_ROOT / "prompt_wav.json").read_text(encoding="utf-8"))
    entry = meta.get("Normal") or next(iter(meta.values()))
    wav = CHARACTER_ROOT / "prompt_wav" / entry["wav"]
    return wav, entry["text"]


def warmup() -> None:
    """预加载模型，避免第一条语音等待过久。"""
    try:
        _ensure_loaded()
    except Exception as err:  # 启动失败时保留 Edge 兜底
        import traceback
        traceback.print_exc()
        print(f"[genie] 模型预热失败，将回退 Edge TTS: {err}", flush=True)


def _ensure_loaded() -> None:
    global _loaded, _genie
    if _loaded:
        return
    with _load_lock:
        if _loaded:
            return

        os.environ.setdefault("GENIE_DATA_DIR", str(DATA_DIR))

        # genie-tts 依赖 jieba_fast（需要 C++ 编译），这里用纯 Python 的 jieba 兼容替代
        try:
            import jieba
            sys.modules.setdefault("jieba_fast", jieba)
        except ImportError:
            pass

        import genie_tts as genie

        genie.load_character("feibi", CHARACTER_ROOT / "tts_models", "zh")
        wav, text = _prompt_audio()
        genie.set_reference_audio("feibi", wav, text, "zh")

        _genie = genie
        _loaded = True


def synthesize(text: str) -> bytes:
    """把一段中文合成成 WAV 字节；调用方负责异常兜底。"""
    _ensure_loaded()
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        with _tts_lock:
            _genie.tts("feibi", text, play=False, save_path=path)
        return Path(path).read_bytes()
    finally:
        Path(path).unlink(missing_ok=True)
