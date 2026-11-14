"""OpenRouter fallback for the /api/gemini relay in serve.py.

Used when GEMINI_API_KEY is missing, or when Gemini answers 429 / 5xx or can't be reached. The browser keeps speaking
Gemini: the request is translated here to OpenRouter's OpenAI-style chat format and the reply is translated back, so
agent.js does not change. The key comes from .env (OPENROUTER_API_KEY) and never reaches the browser.

Models: the same Gemini model through OpenRouter ("gemini-3.6-flash" -> "google/gemini-3.6-flash"), overridable with
OPENROUTER_MODEL (text and tool calls) and OPENROUTER_IMAGE_MODEL (any model with "image" in its name).
"""
import json
import os

URL = os.environ.get("OPENROUTER_URL") or "https://openrouter.ai/api/v1/chat/completions"  # override only for tests


def key():
    return os.environ.get("OPENROUTER_API_KEY") or ""


def model_for(gemini_model):
    """Gemini model name -> OpenRouter model slug."""
    image = "image" in gemini_model.lower()
    override = os.environ.get("OPENROUTER_IMAGE_MODEL" if image else "OPENROUTER_MODEL")
    if override:
        return override
    return gemini_model if "/" in gemini_model else "google/" + gemini_model


def headers():
    return {"Content-Type": "application/json", "Authorization": "Bearer " + key(), "X-Title": "Walk-In"}


def _schema(s):
    """Gemini function schemas may use OpenAPI upper-case types ("OBJECT"); JSON Schema wants lower case."""
    if isinstance(s, dict):
        return {k: (v.lower() if k == "type" and isinstance(v, str) else _schema(v))
                for k, v in s.items() if k != "nullable"}
    if isinstance(s, list):
        return [_schema(v) for v in s]
    return s


def to_openai(req, model):
    """Gemini generateContent request -> OpenAI chat.completions request."""
    msgs = []
    sys_text = "\n".join(p["text"] for p in (req.get("systemInstruction") or {}).get("parts") or [] if p.get("text"))
    if sys_text:
        msgs.append({"role": "system", "content": sys_text})
    pending, n = [], 0  # tool calls of the last model turn, to match functionResponses that carry no id
    for c in req.get("contents") or []:
        parts = c.get("parts") or []
        if c.get("role") == "model":
            text = "".join(p["text"] for p in parts if "text" in p and not p.get("thought"))
            calls = []
            for p in parts:
                fc = p.get("functionCall")
                if fc:
                    n += 1
                    calls.append({"id": fc.get("id") or f"call_{n}", "type": "function",
                                  "function": {"name": fc.get("name"), "arguments": json.dumps(fc.get("args") or {})}})
            m = {"role": "assistant", "content": text or None}
            if calls:
                m["tool_calls"] = calls
            pending = [(tc["id"], tc["function"]["name"]) for tc in calls]
            msgs.append(m)
            continue
        content = []
        for p in parts:
            fr = p.get("functionResponse")
            if fr:
                cid = fr.get("id")
                if not cid:
                    i = next((i for i, (_, name) in enumerate(pending) if name == fr.get("name")), 0 if pending else None)
                    cid = pending.pop(i)[0] if i is not None else f"call_{fr.get('name')}"
                msgs.append({"role": "tool", "tool_call_id": cid, "content": json.dumps(fr.get("response"))})
            elif "text" in p:
                content.append({"type": "text", "text": p["text"]})
            elif p.get("inlineData"):
                d = p["inlineData"]
                url = f"data:{d.get('mimeType') or 'image/jpeg'};base64,{d.get('data', '')}"
                content.append({"type": "image_url", "image_url": {"url": url}})
        if content:
            msgs.append({"role": "user", "content": content})

    out = {"model": model, "messages": msgs}
    decls = [d for t in req.get("tools") or [] for d in t.get("functionDeclarations") or []]
    if decls:
        out["tools"] = [{"type": "function", "function": {
            "name": d["name"], "description": d.get("description", ""),
            "parameters": _schema(d.get("parameters") or {"type": "object", "properties": {}})}} for d in decls]
    g = req.get("generationConfig") or {}
    if "temperature" in g:
        out["temperature"] = g["temperature"]
    if "maxOutputTokens" in g:
        out["max_tokens"] = g["maxOutputTokens"]
    if "IMAGE" in [str(m).upper() for m in g.get("responseModalities") or []]:
        out["modalities"] = ["image", "text"]
    else:
        out["reasoning"] = {"effort": "low", "exclude": True}  # short spoken answers: keep thinking brief and hidden
    return out


def to_gemini(resp):
    """OpenAI chat.completions response -> Gemini generateContent response (what agent.js parses)."""
    ch = (resp.get("choices") or [{}])[0]
    m = ch.get("message") or {}
    parts = []
    text = m.get("content")
    if isinstance(text, list):
        text = "".join(x.get("text", "") for x in text if isinstance(x, dict))
    if text:
        parts.append({"text": text})
    for img in m.get("images") or []:
        url = (img.get("image_url") or {}).get("url", "")
        if url.startswith("data:") and ";base64," in url:
            mime, data = url[5:].split(";base64,", 1)
            parts.append({"inlineData": {"mimeType": mime, "data": data}})
    for tc in m.get("tool_calls") or []:
        f = tc.get("function") or {}
        try:
            args = json.loads(f.get("arguments") or "{}")
        except ValueError:
            args = {}
        parts.append({"functionCall": {"id": tc.get("id"), "name": f.get("name"), "args": args}})
    finish = {"length": "MAX_TOKENS", "content_filter": "SAFETY"}.get(ch.get("finish_reason") or "stop", "STOP")
    u = resp.get("usage") or {}
    return {"candidates": [{"content": {"role": "model", "parts": parts or [{"text": ""}]}, "finishReason": finish}],
            "usageMetadata": {"promptTokenCount": u.get("prompt_tokens"), "candidatesTokenCount": u.get("completion_tokens")},
            "modelVersion": resp.get("model"), "provider": "openrouter"}
