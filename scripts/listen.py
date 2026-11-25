import base64, io, json, os, sys, time, urllib.error, urllib.request, uuid, wave
import numpy as np
import sherpa_onnx

d, n = sys.argv[1], sys.argv[2]
silence = float(sys.argv[3]) if len(sys.argv) > 3 else 0.6
rate = 16000

cfg = {
    "stt_mode": "local",
    "stt_url": "",
    "stt_model": "whisper-1",
    "stt_key": "",
    "whisper": n,
    "silence": silence,
}


def out(**msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


recognizer = None
loaded_whisper = None


def ensure_recognizer():
    global recognizer, loaded_whisper
    name = cfg["whisper"] or "small.en"
    if recognizer is not None and loaded_whisper == name:
        return recognizer
    w = os.path.join(d, f"sherpa-onnx-whisper-{name}", name)
    recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
        encoder=f"{w}-encoder.int8.onnx",
        decoder=f"{w}-decoder.int8.onnx",
        tokens=f"{w}-tokens.txt",
        language="en",
        task="transcribe",
        num_threads=4,
    )
    loaded_whisper = name
    return recognizer


def make_vad(min_silence):
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = os.path.join(d, "silero_vad.onnx")
    config.silero_vad.threshold = 0.5
    config.silero_vad.min_silence_duration = max(0.15, min(2.0, float(min_silence)))
    config.silero_vad.min_speech_duration = 0.2
    config.silero_vad.max_speech_duration = 30
    config.sample_rate = rate
    return sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=120), config.silero_vad.window_size


def wav_bytes(samples):
    clipped = np.clip(samples, -1.0, 1.0)
    pcm16 = (clipped * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(pcm16)
    return buf.getvalue()


def decode_openai(samples):
    base = cfg["stt_url"].rstrip("/")
    url = base if base.endswith("/audio/transcriptions") else f"{base}/audio/transcriptions"
    boundary = f"----BuzzVoice{uuid.uuid4().hex}"
    audio = wav_bytes(samples)
    parts = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{cfg['stt_model'] or 'whisper-1'}\r\n".encode("utf-8"),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n".encode("utf-8"),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\nContent-Type: audio/wav\r\n\r\n".encode("utf-8") + audio + b"\r\n",
        f"--{boundary}--\r\n".encode("utf-8"),
    ]
    body = b"".join(parts)
    headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    if cfg["stt_key"]:
        headers["Authorization"] = f"Bearer {cfg['stt_key']}"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="replace").strip()
    try:
        parsed = json.loads(raw)
        return str(parsed.get("text", "")).strip()
    except Exception:
        return raw


def decode(samples):
    t = time.time()
    if cfg["stt_mode"] == "openai" and cfg["stt_url"]:
        text = decode_openai(samples)
    else:
        rec = ensure_recognizer()
        stream = rec.create_stream()
        stream.accept_waveform(rate, samples)
        rec.decode_stream(stream)
        text = stream.result.text.strip()
    return text, int((time.time() - t) * 1000)


def pcm(data):
    return np.frombuffer(base64.b64decode(data), dtype="<i2").astype(np.float32) / 32768


started = time.time()
vad, window = make_vad(silence)
# Preload local whisper only when local model files exist; openai mode skips preload via c command
w_default = os.path.join(d, f"sherpa-onnx-whisper-{n}", f"{n}-tokens.txt")
if n != "__none__" and os.path.isfile(w_default):
    ensure_recognizer()

pending = np.zeros(0, dtype=np.float32)
speaking = False
parts = {}

out(ready=True, ms=int((time.time() - started) * 1000))
for line in sys.stdin:
    op, _, rest = line.strip().partition(" ")
    try:
        if op == "a":
            pending = np.concatenate([pending, pcm(rest)])
            while len(pending) >= window:
                vad.accept_waveform(pending[:window])
                pending = pending[window:]
                if vad.is_speech_detected() != speaking:
                    speaking = not speaking
                    out(speech=speaking)
                while not vad.empty():
                    samples = np.array(vad.front.samples, dtype=np.float32)
                    vad.pop()
                    text, ms = decode(samples)
                    out(text=text, ms=ms, seconds=round(len(samples) / rate, 2))
        elif op == "p":
            ref, _, data = rest.partition(" ")
            parts.setdefault(ref, []).append(pcm(data))
        elif op == "d":
            ref = rest
            chunks = parts.pop(ref, [])
            samples = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
            text, ms = decode(samples)
            out(id=ref, text=text, ms=ms)
        elif op == "r":
            vad.reset()
            pending = np.zeros(0, dtype=np.float32)
            if speaking:
                speaking = False
                out(speech=False)
        elif op == "c":
            patch = json.loads(rest)
            prev_silence = cfg["silence"]
            for key in ("stt_mode", "stt_url", "stt_model", "stt_key", "whisper", "silence"):
                if key in patch and patch[key] is not None:
                    cfg[key] = patch[key]
            if abs(float(cfg["silence"]) - float(prev_silence)) > 0.01:
                vad, window = make_vad(cfg["silence"])
                pending = np.zeros(0, dtype=np.float32)
                if speaking:
                    speaking = False
                    out(speech=False)
            if cfg["stt_mode"] == "local":
                ensure_recognizer()
            out(configured=True)
        elif op == "s":
            cfg["silence"] = float(rest)
            vad, window = make_vad(cfg["silence"])
            pending = np.zeros(0, dtype=np.float32)
            if speaking:
                speaking = False
                out(speech=False)
    except Exception as error:
        if op == "d":
            out(id=rest, error=str(error))
        else:
            out(error=str(error))
