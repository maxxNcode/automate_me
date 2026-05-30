import sys, json, os, re

# Suppress C-level stderr noise during import
sys.stderr = open(os.devnull, 'w')
try:
    from gpt4all import GPT4All as GPT4AllCls
    GPT4ALL_AVAILABLE = True
except Exception:
    GPT4ALL_AVAILABLE = False
sys.stderr = sys.__stderr__

MODEL_NAME = "mistral-7b-instruct-v0.1.Q4_0.gguf"
MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "models")

# Try CUDA first, fall back to CPU if CUDA unavailable
def _load_model():
    try:
        model_path = os.path.join(MODEL_DIR, MODEL_NAME)
        if os.path.exists(model_path):
            return GPT4AllCls(model_path, model_path=MODEL_DIR)
        return GPT4AllCls(MODEL_NAME, model_path=MODEL_DIR)
    except Exception as gpu_err:
        err_str = str(gpu_err).lower()
        if 'cuda' in err_str or 'gpu' in err_str or 'cublas' in err_str:
            os.environ['GGML_CUDA_ENABLE'] = '0'
            os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
            model_path = os.path.join(MODEL_DIR, MODEL_NAME)
            if os.path.exists(model_path):
                return GPT4AllCls(model_path, model_path=MODEL_DIR)
            return GPT4AllCls(MODEL_NAME, model_path=MODEL_DIR)
        raise


def build_prompt(topic: str, tone: str, scene_count: int) -> str:
    tone_guide = {
        "educational": "Give specific examples, statistics, or analogies. Teach one clear lesson.",
        "entertaining": "Use surprising hooks and unexpected twists. Make each reveal feel fresh.",
        "professional": "Give actionable steps and frameworks. Sound authoritative but approachable.",
        "casual": "Use conversational language. Sound like a friend explaining something cool.",
    }
    guide = tone_guide.get(tone, "Keep it engaging and specific.")

    return f"""Generate {scene_count} scenes for a short video about "{topic}".

Style: {tone} — {guide}

Format your response as a JSON array. Each scene has "text" (spoken line, 15-30 words) and "searchTerms" (3 relevant keywords for stock footage).

Example format:
[{{"text": "spoken line here", "searchTerms": ["keyword1", "keyword2", "keyword3"]}}]

Rules:
- Scene 1 = hook (grab attention with a question, surprising claim, or bold statement)
- Middle scenes = body (each covers ONE different angle, example, or insight about {topic})
- Last scene = call to action (ask viewers to comment, save, or follow)
- Make each scene's text sound natural when spoken aloud
- Use concrete details, not generic advice

Return ONLY the JSON array."""


def extract_scenes(text: str) -> list[dict]:
    results = []
    text = text.strip()

    # Strip markdown code block wrapper
    text = re.sub(r'^```(?:json)?\s*\n?', '', text)
    text = re.sub(r'\n?```\s*$', '', text)

    # Try full JSON array parse
    try:
        data = json.loads(text)
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict) and 'text' in item:
                    item['searchTerms'] = item.get('searchTerms', [])
                    results.append(item)
            if results:
                return results
    except (json.JSONDecodeError, TypeError):
        pass

    # Extract JSON array anywhere in text  
    m = re.search(r'\[[\s\S]*\]', text)
    if m:
        try:
            data = json.loads(m.group())
            if isinstance(data, list):
                for item in data:
                    if isinstance(item, dict) and 'text' in item:
                        item['searchTerms'] = item.get('searchTerms', [])
                        results.append(item)
                if results:
                    return results
        except (json.JSONDecodeError, TypeError):
            pass

    # Extract individual {"text":..., "searchTerms":[...]} objects
    # Handles newlines between keys/values
    pat = re.compile(
        r'\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"searchTerms"\s*:\s*\[([^\]]*)\]\s*\}',
        re.DOTALL
    )
    for m in pat.finditer(text):
        text_val = m.group(1)
        terms_raw = m.group(2)
        terms = [t.strip().strip('"').strip("'") for t in terms_raw.split(',') if t.strip()]
        terms = [t for t in terms if len(t) > 1]
        if text_val and len(text_val) > 3:
            results.append({"text": text_val, "searchTerms": terms[:5]})

    if results:
        return results

    return results


def generate_scenes(topic: str, tone: str = "educational", duration_seconds: int = 30) -> dict:
    if not GPT4ALL_AVAILABLE:
        return {"success": False, "error": "GPT4All not installed", "scenes": [], "fallback": True}

    try:
        model = _load_model()
        print(f"DBG_MODEL_LOADED type={type(model).__name__}", file=sys.__stderr__, flush=True)
        scene_count = max(2, min(5, duration_seconds // 12))
        prompt = build_prompt(topic, tone, scene_count)

        response = model.generate(prompt, max_tokens=4096, temp=0.95, top_k=60, top_p=0.97, repeat_penalty=1.15)

        print(f"DBG_RAW_RESPONSE: {response}", file=sys.__stderr__, flush=True)

        scenes = extract_scenes(response)

        if not scenes:
            print(f"DBG_NO_SCENES last_500: {response[-500:]}", file=sys.__stderr__, flush=True)
            return {"success": False, "error": "No scenes extracted", "scenes": [], "fallback": True}

        return {
            "success": True,
            "scenes": scenes[:5],
            "model": MODEL_NAME,
            "topic": topic,
            "tone": tone,
            "scene_count": min(len(scenes), 5),
            "fallback": False,
        }

    except Exception as e:
        print(f"GPT4All error: {e}", file=sys.__stderr__)
        return {"success": False, "error": str(e), "scenes": [], "fallback": True}


if __name__ == "__main__":
    if len(sys.argv) > 1:
        data = json.loads(sys.argv[1])
    else:
        data = json.loads(sys.stdin.read())
    result = generate_scenes(
        topic=data.get("topic", "Technology"),
        tone=data.get("tone", "educational"),
        duration_seconds=data.get("duration_seconds", 30),
    )
    print(json.dumps(result))
