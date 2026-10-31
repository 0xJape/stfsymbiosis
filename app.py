import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

import os
import math
import uuid
import asyncio
import tempfile
from datetime import datetime, timezone

from flask import Flask, request, jsonify, render_template, Response, url_for
from dotenv import load_dotenv
from werkzeug.utils import secure_filename
import requests
try:
    import edge_tts
except ImportError:
    edge_tts = None
try:
    import pyttsx3
except ImportError:
    pyttsx3 = None
from langdetect import detect

load_dotenv()

# ---------------------------------------------------------------------------
# Config (all secrets come from environment variables - never hardcode keys)
# ---------------------------------------------------------------------------
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

VISUALCROSSING_API_KEY = os.getenv("VISUALCROSSING_API_KEY")
VISUALCROSSING_URL = (
    "https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/"
    "timeline"
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def resolve_configured_path(path: str, base_dir: str = BASE_DIR) -> str:
    if not os.path.isabs(path):
        return os.path.abspath(os.path.join(base_dir, path))
    return path


MODEL_PATH = resolve_configured_path(
    os.getenv("MODEL_PATH", os.path.join(BASE_DIR, "models", "best.pt"))
)
UPLOAD_DIR = resolve_configured_path(
    os.getenv("UPLOAD_DIR", os.path.join(BASE_DIR, "static", "uploads"))
)
ALLOWED_IMAGE_EXTENSIONS = {".bmp", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"}
CLASS_NAMES = ["healthy", "cordana", "pestalotiopsis", "sigatoka"]
CLASS_COLORS = {
    "healthy": "#4A7C59",
    "cordana": "#E8B94A",
    "pestalotiopsis": "#C46B2E",
    "sigatoka": "#B23A2E",
}

os.makedirs(UPLOAD_DIR, exist_ok=True)

app = Flask(__name__)

# ---------------------------------------------------------------------------
# YOLO26-seg model loading (auto-reloads weights if the file changes)
# ---------------------------------------------------------------------------
_model = None
_model_error = None
_model_mtime = None


def load_model():
    global _model, _model_error, _model_mtime
    try:
        from ultralytics import YOLO
    except Exception as e:
        _model = None
        _model_error = str(e)
        _model_mtime = None
        return

    if not os.path.exists(MODEL_PATH):
        _model = None
        _model_error = f"No weights found at {MODEL_PATH} - running in mock mode."
        _model_mtime = None
        return

    mtime = os.path.getmtime(MODEL_PATH)
    if _model is None or _model_mtime != mtime:
        try:
            _model = YOLO(MODEL_PATH)
            _model_mtime = mtime
            _model_error = None
        except Exception as e:
            _model = None
            _model_error = str(e)
            _model_mtime = None


load_model()


def run_inference(image_path: str):
    """Run the trained model on a single image. Supports both classification
    weights (r.probs - what prepare_dataset.py/train.py --mode classify
    currently produce) and segmentation weights (r.boxes/r.masks - what a
    YOLO26-seg model trained on mask-annotated data would produce). Falls
    back to a clearly-labeled mock result when no weights are loaded, so the
    rest of the pipeline (map, weather fusion, LLM advice) can still be
    developed/demoed."""
    load_model()
    if _model is not None:
        results = _model.predict(source=image_path, verbose=False)
        r = results[0]

        # --- Classification model output ---
        if getattr(r, "probs", None) is not None:
            top_idx = int(r.probs.top1)
            confidence = float(r.probs.top1conf)
            cls_name = r.names.get(top_idx, CLASS_NAMES[top_idx % len(CLASS_NAMES)])
            cls_name = map_class_name(cls_name)
            return {
                "class": cls_name,
                "confidence": round(confidence, 4),
                "severity_pct": None,
                "mock": False,
            }

        # --- Segmentation / detection model output ---
        if r.boxes is None or len(r.boxes) == 0:
            return {
                "class": "healthy",
                "confidence": 1.0,
                "severity_pct": 0.0,
                "mock": False,
            }
        top_idx = int(r.boxes.conf.argmax())
        cls_id = int(r.boxes.cls[top_idx])
        cls_name = r.names.get(cls_id, CLASS_NAMES[cls_id % len(CLASS_NAMES)])
        cls_name = map_class_name(cls_name)
        confidence = float(r.boxes.conf[top_idx])

        severity_pct = 0.0
        if r.masks is not None:
            import numpy as np

            mask = r.masks.data[top_idx].cpu().numpy()
            leaf_area = mask.shape[0] * mask.shape[1]
            lesion_area = float(np.sum(mask > 0.5))
            severity_pct = round((lesion_area / leaf_area) * 100, 2)

        return {
            "class": cls_name,
            "confidence": round(confidence, 4),
            "severity_pct": severity_pct,
            "mock": False,
        }

    # ---- Mock fallback (no trained weights loaded yet) ----
    import random

    cls_name = random.choice(CLASS_NAMES)
    return {
        "class": cls_name,
        "confidence": round(random.uniform(0.75, 0.97), 4),
        "severity_pct": 0.0 if cls_name == "healthy" else round(random.uniform(5, 40), 2),
        "mock": True,
    }


def map_class_name(cls_name: str) -> str:
    cls_lower = cls_name.lower()
    if cls_lower in CLASS_NAMES:
        return cls_lower
    for known in CLASS_NAMES:
        if known in cls_lower:
            return known
    return cls_name


def make_image_url(filename: str) -> str:
    return url_for("static", filename=f"uploads/{filename}")


def parse_coordinates(lat_value, lon_value) -> tuple[float, float]:
    if lat_value is None or lon_value is None:
        raise ValueError("Coordinates are required before detection")

    try:
        lat = float(lat_value)
        lon = float(lon_value)
    except (TypeError, ValueError) as e:
        raise ValueError("Latitude and longitude must be valid numbers") from e

    if not math.isfinite(lat) or not math.isfinite(lon):
        raise ValueError("Latitude and longitude must be finite numbers")
    if not -90 <= lat <= 90:
        raise ValueError("Latitude must be between -90 and 90")
    if not -180 <= lon <= 180:
        raise ValueError("Longitude must be between -180 and 180")
    return lat, lon


def get_safe_image_extension(filename: str | None) -> str | None:
    safe_filename = secure_filename(filename or "")
    extension = os.path.splitext(safe_filename)[1].lower()
    return extension if extension in ALLOWED_IMAGE_EXTENSIONS else None


def estimate_weather_risk(weather: dict) -> dict:
    humidity = weather.get("humidity") or 0
    precip = weather.get("precipprob") or 0
    temp = weather.get("temp")
    risk_score = 0

    if humidity >= 80:
        risk_score += 2
    elif humidity >= 65:
        risk_score += 1

    if precip >= 60:
        risk_score += 2
    elif precip >= 30:
        risk_score += 1

    if temp is not None and 20 <= temp <= 32:
        risk_score += 1

    if risk_score >= 4:
        level = "high"
        note = "Weather conditions strongly favor disease spread."
    elif risk_score >= 2:
        level = "moderate"
        note = "Weather conditions moderately favor disease spread."
    else:
        level = "low"
        note = "Weather conditions are less favorable for disease spread."

    return {"risk_level": level, "risk_note": note, "risk_score": risk_score}


def fetch_weather(lat: float, lon: float) -> dict | None:
    if not VISUALCROSSING_API_KEY:
        return None

    url = f"{VISUALCROSSING_URL}/{lat},{lon}/today"
    params = {
        "unitGroup": "metric",
        "key": VISUALCROSSING_API_KEY,
        "include": "current",
        "contentType": "json",
    }
    try:
        res = requests.get(url, params=params, timeout=10)
        res.raise_for_status()
        data = res.json()
        current = data.get("currentConditions", {})
        weather = {
            "temp": current.get("temp"),
            "humidity": current.get("humidity"),
            "precipprob": current.get("precipprob"),
            "windspeed": current.get("windspeed"),
            "cloudcover": current.get("cloudcover"),
            "conditions": current.get("conditions"),
        }
        weather.update(estimate_weather_risk(weather))
        return weather
    except requests.exceptions.RequestException:
        return None


def format_context_for_chat(context: dict) -> str:
    if not isinstance(context, dict) or not context:
        return ""

    parts = []
    if context.get("batch"):
        summary = context.get("summary", {})
        if not isinstance(summary, dict):
            summary = {}
        parts.append("Batch detection summary:")
        for cls_name, count in summary.items():
            parts.append(f"- {count} image(s) classified as {cls_name}")

        weather = context.get("weather")
        results = context.get("results")
        if not isinstance(weather, dict) and isinstance(results, list) and results and isinstance(results[0], dict):
            weather = results[0].get("weather")
        if isinstance(weather, dict):
            parts.append(
                f"Weather at the location: {weather.get('conditions', 'unknown')} with {weather.get('temp', 'N/A')}°C, humidity {weather.get('humidity', 'N/A')}%, risk level {weather.get('risk_level', 'N/A')}.")
            if weather.get("risk_note"):
                parts.append(f"Note: {weather.get('risk_note')}")
        else:
            parts.append("Weather data was not available for the batch detection.")

        return "\n".join(parts)

    cls_name = context.get("class")
    confidence = context.get("confidence")
    if isinstance(cls_name, str) and isinstance(confidence, (int, float)) and math.isfinite(confidence):
        parts.append(
            f"Latest detection: {cls_name} with {(confidence * 100):.1f}% confidence."
        )

    weather = context.get("weather")
    if isinstance(weather, dict):
        parts.append(
            f"Weather at the location: {weather.get('conditions', 'unknown')} with {weather.get('temp', 'N/A')}°C, humidity {weather.get('humidity', 'N/A')}%, risk level {weather.get('risk_level', 'N/A')}.")
        if weather.get("risk_note"):
            parts.append(f"Note: {weather.get('risk_note')}")

    if parts:
        return "\n".join(parts)

    return ""


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/diagnose")
@app.route("/detect")
def diagnose():
    return render_template("index.html", diagnose_page=True, workspace_tab="detect")

@app.route("/map")
def map_page():
    return render_template("index.html", diagnose_page=True, workspace_tab="map")

@app.route("/api/health")
def health():
    groq_ok = bool(GROQ_API_KEY)
    weather_ok = bool(VISUALCROSSING_API_KEY)
    label_count = 0
    label_sample = None
    if _model is not None:
        try:
            label_count = len(_model.names)
            label_sample = list(_model.names.values())[:min(10, len(_model.names))]
        except Exception:
            label_sample = None
    return jsonify(
        {
            "model_loaded": _model is not None,
            "model_note": _model_error,
            "model_label_count": label_count,
            "model_label_sample": label_sample,
            "assistant_configured": groq_ok,
            "weather_configured": weather_ok,
        }
    )


# ---------------------------------------------------------------------------
# Detection - single image
# ---------------------------------------------------------------------------
@app.route("/api/detect", methods=["POST"])
def detect_single():
    if "image" not in request.files:
        return jsonify({"error": "No image uploaded"}), 400
    try:
        lat, lon = parse_coordinates(request.form.get("lat"), request.form.get("lon"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    file = request.files["image"]
    ext = get_safe_image_extension(file.filename)
    if not ext:
        return jsonify({"error": "Upload a supported image file (BMP, JPEG, PNG, TIFF, or WebP)"}), 400
    filename = f"{uuid.uuid4().hex}{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    file.save(filepath)

    result = run_inference(filepath)
    weather_data = fetch_weather(float(lat), float(lon))
    if weather_data is not None:
        result["weather"] = weather_data

    result.update(
        {
            "id": uuid.uuid4().hex,
            "filename": filename,
            "image_url": make_image_url(filename),
            "lat": float(lat),
            "lon": float(lon),
            "color": CLASS_COLORS.get(result["class"], "#4A7C59"),
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
    )
    return jsonify(result)


# ---------------------------------------------------------------------------
# Detection - batch (one shared coordinate set per batch, per methodology)
# ---------------------------------------------------------------------------
@app.route("/api/detect_batch", methods=["POST"])
def detect_batch():
    files = request.files.getlist("images")
    if not files:
        return jsonify({"error": "No images uploaded"}), 400
    try:
        lat, lon = parse_coordinates(request.form.get("lat"), request.form.get("lon"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    extensions = [get_safe_image_extension(file.filename) for file in files]
    if any(extension is None for extension in extensions):
        return jsonify({"error": "Every upload must be a supported image file (BMP, JPEG, PNG, TIFF, or WebP)"}), 400

    results = []
    weather_data = fetch_weather(float(lat), float(lon))
    for file, ext in zip(files, extensions):
        filename = f"{uuid.uuid4().hex}{ext}"
        filepath = os.path.join(UPLOAD_DIR, filename)
        file.save(filepath)

        r = run_inference(filepath)
        if weather_data is not None:
            r["weather"] = weather_data
        r.update(
            {
                "id": uuid.uuid4().hex,
                "filename": filename,
                "image_url": make_image_url(filename),
                "lat": float(lat),
                "lon": float(lon),
                "color": CLASS_COLORS.get(r["class"], "#4A7C59"),
                "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            }
        )
        results.append(r)

    counts = {}
    for r in results:
        counts[r["class"]] = counts.get(r["class"], 0) + 1

    return jsonify({"results": results, "summary": counts})


# ---------------------------------------------------------------------------
# Weather risk fusion (Visual Crossing)
# ---------------------------------------------------------------------------
@app.route("/api/weather")
def weather():
    lat = request.args.get("lat")
    lon = request.args.get("lon")
    try:
        lat, lon = parse_coordinates(lat, lon)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if not VISUALCROSSING_API_KEY:
        return jsonify({"error": "Weather API key not configured"}), 503

    url = f"{VISUALCROSSING_URL}/{lat},{lon}/today"
    params = {
        "unitGroup": "metric",
        "key": VISUALCROSSING_API_KEY,
        "include": "current",
        "contentType": "json",
    }
    try:
        res = requests.get(url, params=params, timeout=10)
        res.raise_for_status()
        data = res.json()
        current = data.get("currentConditions", {})
        return jsonify(
            {
                "temp": current.get("temp"),
                "humidity": current.get("humidity"),
                "precipprob": current.get("precipprob"),
                "windspeed": current.get("windspeed"),
                "cloudcover": current.get("cloudcover"),
                "conditions": current.get("conditions"),
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 502


# ---------------------------------------------------------------------------
# Conversational assistant (LLM). Falls back to a local/offline notice if
# the API call fails, rather than crashing the chat widget.
# ---------------------------------------------------------------------------
@app.route("/api/chat", methods=["POST"])
def chat():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"error": "A JSON request body is required"}), 400
    user_message = body.get("message", "")
    if not isinstance(user_message, str) or not user_message.strip():
        return jsonify({"error": "A non-empty message is required"}), 400
    context = body.get("context", {})
    if not isinstance(context, dict):
        return jsonify({"error": "Context must be a JSON object"}), 400
    user_message = user_message.strip()

    if not GROQ_API_KEY:
        return jsonify(
            {
                "reply": (
                    "The assistant is running in offline mode because no API key "
                    "is configured on the server."
                ),
                "offline": True,
            }
        )

    context_text = format_context_for_chat(context)
    system_prompt = (
        "You are the SYMBIOSIS agricultural assistant, helping banana farmers and "
        "technicians interpret banana leaf disease detections and weather risk. "
        "Reply in the same language the user writes in. "
        "Never use markdown formatting like asterisks, bold, italics, bullet points, "
        "or headers. Respond in plain conversational sentences only, concise and practical."
    )
    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json",
    }
    messages = [
        {"role": "system", "content": system_prompt},
    ]
    if context_text:
        messages.append({"role": "assistant", "content": context_text})
    messages.append({"role": "user", "content": user_message})

    payload = {
        "model": GROQ_MODEL,
        "messages": messages,
    }

    try:
        res = requests.post(GROQ_URL, headers=headers, json=payload, timeout=15)
        if res.status_code != 200:
            return jsonify(
                {
                    "reply": "The assistant is temporarily unavailable, switching to offline mode.",
                    "offline": True,
                }
            )
        reply = res.json()["choices"][0]["message"]["content"]
        response_payload = {"reply": reply, "offline": False}
        if context_text:
            response_payload["context_summary"] = context_text
        return jsonify(response_payload)
    except requests.exceptions.RequestException:
        return jsonify(
            {
                "reply": (
                    "No connection to the assistant service right now. "
                    "You're seeing this in offline / local mode."
                ),
                "offline": True,
            }
        )


# ---------------------------------------------------------------------------
# Text-to-speech (Microsoft edge-tts, multilingual voice map)
# ---------------------------------------------------------------------------
VOICE_MAP = {
    # English
    "en": "en-US-AriaNeural",

    # Europe
    "ru": "ru-RU-SvetlanaNeural",
    "es": "es-ES-ElviraNeural",
    "fr": "fr-FR-DeniseNeural",
    "de": "de-DE-KatjaNeural",
    "it": "it-IT-ElsaNeural",
    "pt": "pt-BR-FranciscaNeural",
    "nl": "nl-NL-ColetteNeural",
    "pl": "pl-PL-ZofiaNeural",
    "sv": "sv-SE-SofieNeural",
    "da": "da-DK-ChristelNeural",
    "fi": "fi-FI-SelmaNeural",
    "el": "el-GR-AthinaNeural",
    "cs": "cs-CZ-VlastaNeural",
    "ro": "ro-RO-AlinaNeural",
    "hu": "hu-HU-NoemiNeural",
    "uk": "uk-UA-PolinaNeural",
    "bg": "bg-BG-KalinaNeural",
    "sk": "sk-SK-ViktoriaNeural",
    "hr": "hr-HR-GabrijelaNeural",
    "sr": "sr-RS-SophieNeural",
    "tr": "tr-TR-EmelNeural",
    "nb": "nb-NO-PernilleNeural",

    # Asia
    "ja": "ja-JP-NanamiNeural",
    "ko": "ko-KR-SunHiNeural",
    "zh-cn": "zh-CN-XiaoxiaoNeural",
    "zh-tw": "zh-TW-HsiaoChenNeural",
    "th": "th-TH-PremwadeeNeural",
    "vi": "vi-VN-HoaiMyNeural",
    "id": "id-ID-GadisNeural",
    "ms": "ms-MY-YasminNeural",
    "hi": "hi-IN-SwaraNeural",
    "bn": "bn-IN-TanishaaNeural",
    "ta": "ta-IN-PallaviNeural",
    "te": "te-IN-ShrutiNeural",
    "ur": "ur-PK-UzmaNeural",
    "he": "he-IL-HilaNeural",
    "fa": "fa-IR-DilaraNeural",

    # Philippines
    "tl": "fil-PH-BlessicaNeural",

    # Middle East
    "ar": "ar-SA-ZariyahNeural",

    # Africa
    "sw": "sw-KE-ZuriNeural",
    "af": "af-ZA-AdriNeural",
    "am": "am-ET-MekdesNeural",
    "zu": "zu-ZA-ThandoNeural",
}
DEFAULT_VOICE = "en-US-AriaNeural"


def normalize_language_code(lang: str) -> str:
    if not lang:
        return ""
    lang = lang.lower()
    if lang in VOICE_MAP:
        return lang
    primary = lang.split("-")[0]
    if primary in VOICE_MAP:
        return primary
    if primary == "zh":
        return "zh-cn"
    return ""


def pick_voice(text: str) -> str:
    try:
        lang = detect(text)
    except Exception:
        return DEFAULT_VOICE
    normalized = normalize_language_code(lang)
    return VOICE_MAP.get(normalized, DEFAULT_VOICE)


def run_async(coro):
    try:
        return asyncio.run(coro)
    except RuntimeError as e:
        if "asyncio.run() cannot be called from a running event loop" in str(e):
            loop = asyncio.new_event_loop()
            try:
                return loop.run_until_complete(coro)
            finally:
                loop.close()
        raise


async def generate_edge_audio(text: str, voice: str) -> bytes:
    """Calls Microsoft's edge-tts service. Retries once before giving up,
    since transient handshake failures happen occasionally. Raises the real
    exception on failure instead of swallowing it, so generate_audio() can
    log what actually went wrong."""
    if edge_tts is None:
        raise RuntimeError("edge_tts is not installed")

    last_error = None
    for attempt in range(2):
        try:
            communicate = edge_tts.Communicate(text, voice)
            audio_chunks = []
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio_chunks.append(chunk["data"])
            audio = b"".join(audio_chunks)
            if audio:
                return audio
            raise RuntimeError("edge_tts returned empty audio")
        except Exception as e:
            last_error = e
            print(f"edge_tts attempt {attempt + 1} failed: {e}")
    raise last_error


def generate_offline_audio(text: str) -> bytes:
    if pyttsx3 is None:
        raise RuntimeError("No offline TTS engine is available. Install pyttsx3 to enable local speech synthesis.")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmpfile:
        tmp_path = tmpfile.name

    try:
        engine = pyttsx3.init()
        engine.save_to_file(text, tmp_path)
        engine.runAndWait()
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def generate_audio(text: str, voice: str) -> tuple[bytes, str]:
    if text == "":
        raise ValueError("No text provided for TTS")

    try:
        audio_bytes = run_async(generate_edge_audio(text, voice))
        return audio_bytes, "audio/mpeg"
    except Exception as e:
        print(f"edge_tts fully failed, falling back to offline TTS: {e}")

    audio_bytes = generate_offline_audio(text)
    return audio_bytes, "audio/wav"


@app.route("/api/speak", methods=["POST"])
def speak():
    try:
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return jsonify({"error": "A JSON request body is required"}), 400
        text = body.get("text", "")
        if not isinstance(text, str):
            return jsonify({"error": "Text must be a string"}), 400
        text = text.strip()
        if not text:
            return jsonify({"error": "No text provided"}), 400

        voice = pick_voice(text)
        print(f"TEXT: {text!r}")
        print(f"SPEAKING WITH VOICE: {voice}")

        audio_bytes, mimetype = generate_audio(text, voice)
        if not audio_bytes:
            return jsonify({"error": "No audio generated"}), 500
        return Response(audio_bytes, mimetype=mimetype)
    except Exception as e:
        print(f"SPEAK ERROR: {e}")
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(debug=os.getenv("FLASK_DEBUG", "false").lower() == "true", host="0.0.0.0", port=port)