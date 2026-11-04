# -*- coding: utf-8 -*-
"""伴侣小生命后端服务

职责：
1. 代理大模型对话（密钥只存在于服务端环境变量，绝不暴露给前端）
2. 对用户输入做情绪判断，返回 {reply, emotion}
3. 生产模式下托管前端构建产物（frontend/dist），一条命令跑通全栈

启动：python backend/main.py
"""
import asyncio
import json
import os
import random
import re
import time
import urllib.error
import urllib.request
import uuid
from collections import defaultdict, deque
from pathlib import Path
from typing import List, Optional

import edge_tts
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent


def load_env() -> None:
    """极简 .env 加载器（避免引入 python-dotenv 依赖），已存在的环境变量不覆盖。"""
    env_file = BASE_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())


load_env()

ZHIPU_API_KEY = os.environ.get("ZHIPU_API_KEY", "").strip()
ZHIPU_CHAT_MODEL = os.environ.get("ZHIPU_CHAT_MODEL", "glm-4-flash").strip()
ZHIPU_API_BASE = os.environ.get("ZHIPU_API_BASE", "https://open.bigmodel.cn/api/paas/v4").strip()
# 萌妹语音（Edge 在线 TTS，免费无 Key）；默认晓伊，年轻活泼女声
TTS_VOICE = os.environ.get("TTS_VOICE", "zh-CN-XiaoyiNeural").strip()
# TTS 引擎：genie=本地菲比音色，edge=原晓伊在线音色；genie 失败时自动回退 edge
TTS_ENGINE = os.environ.get("TTS_ENGINE", "edge").strip().lower()

# 服务端语音识别：优先复用硅基流动（SenseVoiceSmall），密钥只从环境变量读取
SILICONFLOW_API_KEY = os.environ.get("SILICONFLOW_API_KEY", "").strip()
SILICONFLOW_API_BASE = os.environ.get("SILICONFLOW_API_BASE", "https://api.siliconflow.cn/v1").strip()
SILICONFLOW_ASR_MODEL = os.environ.get("SILICONFLOW_ASR_MODEL", "FunAudioLLM/SenseVoiceSmall").strip()

# 录音上限：20MB（前端另有限制：单次最长 60 秒）；限流：每 IP 每分钟 12 次
ASR_MAX_BYTES = 20 * 1024 * 1024
ASR_RATE_LIMIT = 12
ASR_RATE_WINDOW = 60
_asr_hits = defaultdict(deque)

# 统一音色：情绪只影响表情与文案，不改音调/语速（按情绪改 pitch 会让声线听起来像换人）
_TTS_RATE = "+0%"
_TTS_PITCH = "+0Hz"

app = FastAPI(title="companion-api")


@app.middleware("http")
async def _no_cache_shell(request, call_next):
    """页面外壳不缓存，保证改完前端后普通刷新就能拿到新构建。"""
    response = await call_next(request)
    if request.url.path in ("/", "/index.html"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


@app.on_event("startup")
async def _warmup_tts() -> None:
    """后台预热本地音色模型，避免第一条回复卡十几秒。"""
    if TTS_ENGINE != "genie":
        return
    try:
        import feibi_tts
    except ImportError:
        from backend import feibi_tts
    await asyncio.to_thread(feibi_tts.warmup)


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

VALID_EMOTIONS = {"idle", "happy", "shy", "sleepy"}
# 模型偶尔会把情绪词和正文写在同一行，统一在流式阶段剥离
_EMOTION_PREFIX_RE = re.compile(r"^\s*(idle|happy|shy|sleepy)\b", re.IGNORECASE)

SYSTEM_PROMPT = (
    "你是桌宠「小汐」，一条圆滚滚、软萌粘人的电子小肥鱼，住在主人的屏幕里。"
    "用户会对你说各种话、和你互动。请严格按以下格式回复，总共只有两行：\n"
    "第一行：情绪标记，只能取 idle、happy、shy、sleepy 四个英文单词之一，单独成行，"
    "这一行只能有这一个单词，绝对不能和中文回复写在同一行；"
    "含义：idle=平静待机，happy=被夸/被喜欢/开心雀跃，shy=害羞脸红/不好意思，sleepy=犯困想睡/被哄睡觉。\n"
    "第二行：给主人的中文回复，语气可爱自然，带一点点小情绪，不超过30个字，不要使用表情符号。\n"
    "人称视角：回复里的「我」永远指你自己（小汐），「你」永远指主人。"
    "当主人描述对你做过的事（摸你的头、夸你、哄你睡觉）时，要用第一人称说自己身上的感受，"
    "例如说「我的头好舒服」，绝不能反过来说成「你的头」或把感受安到主人身上。\n"
    "不要输出 JSON，不要输出 markdown，除了这两行外不要有任何其他内容。"
)

# 快捷互动的额外提示：让大模型明确谁在被摸/被夸，避免主客体说反
QUICK_ACTION_HINTS = {
    "摸摸头": "主人刚刚轻轻摸了你的头，你要用第一人称说自己的头很舒服、很喜欢被摸。",
    "夸夸她": "主人刚刚在夸你，你要用第一人称表现害羞又开心。",
    "哄她睡觉": "主人刚刚在哄你睡觉，你要用第一人称表现困倦、准备乖乖睡觉。",
    "打个招呼": "主人刚刚在跟你打招呼，你要用第一人称轻快地回应，像挥手打招呼那样。",
}


class ChatMessage(BaseModel):
    role: str = "user"
    content: str


class ChatRequest(BaseModel):
    message: str
    history: List[ChatMessage] = Field(default_factory=list)
    quick_action: Optional[str] = None


class ChatResponse(BaseModel):
    reply: str
    emotion: str
    source: str  # llm=大模型生成，local=本地降级路由


# ---------------- 本地情绪路由（大模型不可用时的降级兜底） ----------------

_LOCAL_RULES = [
    ("sleepy", ["睡", "困", "晚安", "累", "休息", "哄", "夜深", "打盹", "哈欠"]),
    ("shy", ["害羞", "脸红", "抱歉", "对不起", "讨厌", "呜", "别这样", "偷偷"]),
    ("happy", ["夸", "棒", "厉害", "可爱", "喜欢", "爱你", "开心", "摸摸", "真乖", "好棒", "聪明", "666"]),
]

_LOCAL_REPLIES = {
    "happy": ["嘿嘿，被你夸得尾巴都翘起来啦～", "开心！要转圈圈给你看吗？", "嘿嘿～最喜欢你啦！"],
    "shy": ["呜……突然这样说，人家会不好意思的啦。", "脸、脸都红了啦……", "你、你别一直盯着我看嘛……"],
    "sleepy": ["呼啊……眼皮好重……晚安……", "那就……再睡五分钟……Zzz……", "困了……你要轻轻哄我睡哦……"],
    "idle": ["我在呢～今天想聊点什么？", "咕噜咕噜～吐了个泡泡。", "嗯嗯，我在认真听～"],
}

# 快捷互动的本地兜底回复：用第一人称讲自己的感受，避免主客体说反
_LOCAL_QUICK_REPLIES = {
    "摸摸头": ("happy", ["唔…我的头被摸得好舒服呀，再摸一下嘛～", "被主人摸头，我整条鱼都软乎乎啦～"]),
    "夸夸她": ("shy", ["呜…被你这么夸，我的脸都要红透了啦。", "别、别这么说，我会害羞到冒泡泡的……"]),
    "哄她睡觉": ("sleepy", ["呼啊…那我乖乖闭上眼睛，你可别走哦…", "好困了…晚安，要在梦里也陪着我呀…"]),
    "打个招呼": ("idle", ["嗨呀～我在这里，向你挥挥小手！", "你好呀主人，今天也一起玩吧～"]),
}


def local_route(message: str, quick_action: Optional[str] = None) -> ChatResponse:
    quick = _LOCAL_QUICK_REPLIES.get(quick_action or "")
    if quick:
        emotion, replies = quick
        return ChatResponse(reply=random.choice(replies), emotion=emotion, source="local")
    text = message.lower()
    emotion = "idle"
    for emo, keywords in _LOCAL_RULES:
        if any(k in text for k in keywords):
            emotion = emo
            break
    return ChatResponse(reply=random.choice(_LOCAL_REPLIES[emotion]), emotion=emotion, source="local")


# ---------------- 大模型流式调用（SSE 事件生成器） ----------------

def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _llm_stream_events(req: ChatRequest):
    """调用智谱流式接口，解析「情绪标记行 + 回复正文行」协议，产出 SSE 事件。

    事件：emotion（情绪已确定，尽早推送）、delta（data.text 为本次新增的正文片段，前端需累加）、
    done（流结束，data.source=llm）。异常直接抛出，由调用方降级。
    """
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for m in req.history[-6:]:
        if m.role in ("user", "assistant") and m.content:
            messages.append({"role": m.role, "content": m.content})
    user_text = req.message
    if req.quick_action:
        user_text = f"[主人刚刚：{req.quick_action}] {user_text}"
        hint = QUICK_ACTION_HINTS.get(req.quick_action)
        if hint:
            user_text += f"\n（回复要求：{hint}）"
    messages.append({"role": "user", "content": user_text})

    payload = {
        "model": ZHIPU_CHAT_MODEL,
        "messages": messages,
        "temperature": 0.85,
        "max_tokens": 200,
        "stream": True,
    }
    request = urllib.request.Request(
        f"{ZHIPU_API_BASE}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {ZHIPU_API_KEY}",
        },
        method="POST",
    )

    full = ""          # 累积的模型输出全文
    emotion = None     # 已解析出的情绪
    emitted_len = 0    # 已作为正文发出的字符数（正文起点在 full 中的偏移）
    text_started = False  # 是否已经发出过正文，用于裁掉标记后的多余空白
    produced = False   # 是否产出过任何内容

    with urllib.request.urlopen(request, timeout=60) as resp:
        for raw in resp:
            line = raw.decode("utf-8").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                obj = json.loads(data)
            except Exception:
                continue
            choices = obj.get("choices") or []
            delta = (choices[0].get("delta") or {}).get("content") if choices else None
            if not delta:
                continue
            full += delta

            # 只要开头出现合法情绪词就立即剥离，兼容“happy 正文”这种同一行输出
            if emotion is None:
                match = _EMOTION_PREFIX_RE.match(full)
                if match:
                    emotion = match.group(1).lower()
                    emitted_len = match.end()
                    produced = True
                    yield _sse("emotion", {"emotion": emotion})

            if emotion is not None and len(full) > emitted_len:
                chunk = full[emitted_len:]
                if not text_started:
                    chunk = chunk.lstrip()
                if chunk:
                    text_started = True
                    produced = True
                    yield _sse("delta", {"text": chunk})
                emitted_len = len(full)

    if emotion is None:
        # 全程没有识别到情绪词：先尝试剥离行首标记，再整段作为正文
        full_text = full.strip()
        match = _EMOTION_PREFIX_RE.match(full_text)
        if match:
            emotion = match.group(1).lower()
            full_text = full_text[match.end():].strip()
        else:
            emotion = local_route(req.message, req.quick_action).emotion
        if full_text:
            produced = True
            yield _sse("emotion", {"emotion": emotion})
            yield _sse("delta", {"text": full_text[:120]})
    if not produced:
        raise RuntimeError("空回复")
    yield _sse("done", {"source": "llm", "emotion": emotion})


def collect_stream(req: ChatRequest) -> ChatResponse:
    """把流式事件聚合为完整响应（供旧版非流式端点复用）。"""
    emotion, text, source = "idle", "", "llm"
    try:
        for raw in _llm_stream_events(req):
            event, _, data_line = raw.partition("\n")
            data = json.loads(data_line[6:])
            if event == "event: emotion":
                emotion = data["emotion"]
            elif event == "event: delta":
                text += data["text"]
            elif event == "event: done":
                source = data.get("source", "llm")
    except Exception:
        return local_route(req.message, req.quick_action)
    if not text.strip():
        return local_route(req.message, req.quick_action)
    return ChatResponse(reply=text.strip(), emotion=emotion, source=source)


def local_stream_events(req: ChatRequest):
    """本地降级（模拟流式，按字符分片推送）。"""
    r = local_route(req.message, req.quick_action)
    yield _sse("emotion", {"emotion": r.emotion})
    text = r.reply
    step = max(1, len(text) // 6)
    for i in range(0, len(text), step):
        yield _sse("delta", {"text": text[: i + step]})
    yield _sse("done", {"source": "local", "emotion": r.emotion})


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    if not req.message.strip():
        return ChatResponse(reply="……嗯？你还没说话呢。", emotion="idle", source="local")
    return collect_stream(req)


@app.post("/api/chat/stream")
def chat_stream(req: ChatRequest):
    """SSE 流式对话：emotion → delta* → done，逐字推送到前端。"""
    if not req.message.strip():
        return local_stream_events(
            ChatRequest(message="……嗯？你还没说话呢。")
        )

    def gen():
        if ZHIPU_API_KEY:
            try:
                yield from _llm_stream_events(req)
                return
            except GeneratorExit:
                raise
            except Exception:
                pass  # 网络/额度失败 → 降级本地
        yield from local_stream_events(req)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class TTSRequest(BaseModel):
    text: str
    emotion: str = "idle"


@app.post("/api/tts")
async def tts(req: TTSRequest) -> Response:
    """把回复文本合成为萌妹语音：默认本地菲比，失败自动回退 Edge 晓伊。"""
    text = req.text.strip()[:200]
    if not text:
        raise HTTPException(status_code=400, detail="文本为空")

    if TTS_ENGINE == "genie":
        try:
            try:
                import feibi_tts
            except ImportError:
                from backend import feibi_tts
            audio = await asyncio.to_thread(feibi_tts.synthesize, text)
            if audio:
                return Response(content=audio, media_type="audio/wav")
        except Exception as err:
            import traceback
            traceback.print_exc()
            print(f"[tts] 菲比音色合成失败，回退 Edge: {err}", flush=True)

    try:
        communicate = edge_tts.Communicate(
            text, TTS_VOICE, rate=_TTS_RATE, pitch=_TTS_PITCH, boundary="WordBoundary"
        )
        buf = bytearray()
        speech_start = None
        speech_end = 0.0
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                buf.extend(chunk["data"])
            elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
                # Edge 的时间单位是 100ns；返回第一个字开始/最后一个字结束的位置，
                # 前端据此等真正出声后再做口型、前倾和手势，并在尾部空白前收口
                offset = chunk["offset"] / 10_000_000
                if speech_start is None:
                    speech_start = offset
                speech_end = max(
                    speech_end,
                    (chunk["offset"] + chunk["duration"]) / 10_000_000,
                )
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"语音合成失败: {err}")
    if not buf:
        raise HTTPException(status_code=502, detail="语音合成结果为空")
    headers = {}
    if speech_start is not None:
        headers["X-Speech-Start"] = f"{speech_start:.3f}"
    if speech_end > 0:
        headers["X-Speech-End"] = f"{speech_end:.3f}"
    return Response(content=bytes(buf), media_type="audio/mpeg", headers=headers)


# ---------------- 服务端语音识别（硅基流动 SenseVoiceSmall） ----------------

def _asr_rate_limited(client_ip: str) -> bool:
    now = time.monotonic()
    hits = _asr_hits[client_ip]
    while hits and now - hits[0] > ASR_RATE_WINDOW:
        hits.popleft()
    if len(hits) >= ASR_RATE_LIMIT:
        return True
    hits.append(now)
    return False


def _multipart_audio(audio: bytes, filename: str, content_type: str) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    head = []
    head.append(f"--{boundary}\r\n".encode())
    head.append(b'Content-Disposition: form-data; name="model"\r\n\r\n')
    head.append(SILICONFLOW_ASR_MODEL.encode("utf-8"))
    head.append(b"\r\n")
    head.append(f"--{boundary}\r\n".encode())
    head.append(f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode())
    head.append(f"Content-Type: {content_type}\r\n\r\n".encode())
    tail = [b"\r\n", f"--{boundary}--\r\n".encode()]
    return b"".join(head) + audio + b"".join(tail), boundary


def _siliconflow_transcribe(audio: bytes, filename: str, content_type: str) -> str:
    """同步调用硅基流动转写接口（在线程池中执行，避免阻塞事件循环）。"""
    if not SILICONFLOW_API_KEY:
        raise RuntimeError("SILICONFLOW_API_KEY 未配置")
    body, boundary = _multipart_audio(audio, filename, content_type)
    request = urllib.request.Request(
        f"{SILICONFLOW_API_BASE.rstrip('/')}/audio/transcriptions",
        data=body,
        headers={
            "Authorization": f"Bearer {SILICONFLOW_API_KEY}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=90) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    return str(payload.get("text", "")).strip()


@app.post("/api/asr")
async def asr(request: Request):
    """接收原始音频字节（audio/webm、audio/ogg、audio/wav、audio/mpeg 等），返回中文转写文本。

    音频只在内存中流转，不落盘；上游调用放到线程池，避免阻塞事件循环。
    """
    if not SILICONFLOW_API_KEY:
        raise HTTPException(status_code=503, detail="服务端未配置语音识别密钥（SILICONFLOW_API_KEY）")

    client_ip = request.client.host if request.client else "unknown"
    if _asr_rate_limited(client_ip):
        raise HTTPException(status_code=429, detail="请求太频繁，请稍后再试")

    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > ASR_MAX_BYTES:
        raise HTTPException(status_code=413, detail="音频超过 20MB，请缩短录音")

    content_type = (request.headers.get("content-type") or "audio/webm").split(";")[0].strip().lower()
    if not content_type.startswith("audio/"):
        raise HTTPException(status_code=415, detail="只接受音频数据")

    chunks = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > ASR_MAX_BYTES:
            raise HTTPException(status_code=413, detail="音频超过 20MB，请缩短录音")
        chunks.append(chunk)
    audio = b"".join(chunks)
    if not audio:
        raise HTTPException(status_code=400, detail="音频为空")

    if "webm" in content_type:
        ext = "webm"
    elif "ogg" in content_type:
        ext = "ogg"
    elif "wav" in content_type:
        ext = "wav"
    elif "mp4" in content_type or "m4a" in content_type:
        ext = "m4a"
    elif "mpeg" in content_type or "mp3" in content_type:
        ext = "mp3"
    else:
        ext = "bin"

    try:
        text = await asyncio.to_thread(_siliconflow_transcribe, audio, f"audio.{ext}", content_type)
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "ignore")[:200]
        raise HTTPException(status_code=502, detail=f"识别服务返回错误（{err.code}）：{detail}")
    except Exception as err:
        raise HTTPException(status_code=502, detail=f"识别服务不可达：{err}")

    if not text:
        raise HTTPException(status_code=422, detail="没有识别到内容，请靠近麦克风再说一次")
    return {"text": text}


@app.get("/api/health")
def health():
    # 不暴露任何密钥信息，仅提示服务端是否已配置模型
    info = {"status": "ok", "llm_ready": bool(ZHIPU_API_KEY), "tts_engine": TTS_ENGINE}
    if TTS_ENGINE == "genie":
        try:
            try:
                import feibi_tts
            except ImportError:
                from backend import feibi_tts
            info["genie_loaded"] = feibi_tts._loaded
        except Exception:
            info["genie_loaded"] = False
    return info


# 生产模式：托管前端构建产物（vite build 输出到 frontend/dist）
_DIST = BASE_DIR.parent / "frontend" / "dist"
if _DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(_DIST), html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8600)
