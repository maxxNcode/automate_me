"""
GPT4All Script Generator
Generates YouTube video scripts using local LLM models.
No API costs - runs entirely on your machine.
"""

import sys
import json
import os

try:
    from gpt4all import GPT4All
    GPT4ALL_AVAILABLE = True
except ImportError:
    GPT4ALL_AVAILABLE = False

MODEL_NAME = "mistral-7b-instruct-v0.1.Q4_0.gguf"
MODEL_DIR = os.path.join(os.path.dirname(__file__), "..", "models")


def get_script_prompt(topic: str, tone: str = "educational", duration_minutes: int = 5) -> str:
    """Build a structured prompt for script generation."""
    word_count = duration_minutes * 150  # ~150 words per minute
    
    return f"""You are a professional YouTube scriptwriter. Write a detailed, engaging script for a YouTube video.

TOPIC: {topic}
TONE: {tone}
TARGET DURATION: ~{duration_minutes} minutes ({word_count} words)

STRUCTURE:
1. **Hook** (first 15 seconds) - Attention-grabbing opening
2. **Introduction** (30 seconds) - What the video will cover
3. **Main Content** (3-4 minutes) - Deep dive into the topic
4. **Summary** (30 seconds) - Key takeaways
5. **Call to Action** (15 seconds) - Like, subscribe, comment

FORMAT:
Write the script in a speaker-ready format with:
- [VISUAL: description] for thumbnail/visual cues
- [TIMESTAMP: 0:00] markers every 30 seconds
- Natural, conversational language
- Pauses and emphasis marks where appropriate

SCRIPT:
"""


def generate_script(topic: str, tone: str = "educational", duration_minutes: int = 5) -> dict:
    """Generate a YouTube script using GPT4All.
    
    Falls back to a template-based script if GPT4All is not available.
    """
    if not GPT4ALL_AVAILABLE:
        return _generate_fallback_script(topic, tone, duration_minutes)
    
    try:
        model_path = os.path.join(MODEL_DIR, MODEL_NAME)
        if not os.path.exists(model_path):
            print(f"Model not found at {model_path}, downloading...", file=sys.stderr)
            # Let GPT4All handle download
            model = GPT4All(MODEL_NAME, model_path=MODEL_DIR)
        else:
            model = GPT4All(model_path, model_path=MODEL_DIR)
        
        prompt = get_script_prompt(topic, tone, duration_minutes)
        
        with model.chat_session():
            response = model.generate(prompt, max_tokens=2048, temp=0.7, top_k=40, top_p=0.9)
        
        return {
            "success": True,
            "script": response.strip(),
            "model": MODEL_NAME,
            "topic": topic,
            "tone": tone,
            "duration_minutes": duration_minutes,
            "word_count": len(response.split()),
            "fallback": False
        }
    except Exception as e:
        print(f"GPT4All error: {e}, using fallback", file=sys.stderr)
        return _generate_fallback_script(topic, tone, duration_minutes)


def _generate_fallback_script(topic: str, tone: str = "educational", duration_minutes: int = 5) -> dict:
    """Generate a template-based script when GPT4All is unavailable."""
    script = f"""[TIMESTAMP: 0:00]
[VISUAL: Eye-catching intro animation with title: "{topic}"]

Hey everyone! Welcome back to the channel.

[TIMESTAMP: 0:15]
[VISUAL: Host on screen, friendly demeanor]

Today we're diving deep into {topic}. By the end of this video, you'll have a complete understanding of this topic and know exactly how to apply it.

[TIMESTAMP: 0:45]
[VISUAL: Key points displayed on screen with graphics]

Let's break this down into simple, actionable steps.

[MAIN CONTENT - PART 1]
[TIMESTAMP: 1:00]
[VISUAL: Screen recording or demonstration]

First, let's understand what {topic} is all about. The key concept here is understanding the fundamentals before we get into the advanced stuff.

[TIMESTAMP: 2:00]
[VISUAL: Comparison diagrams or examples]

Here's where things get interesting. When we look at the practical applications, we can see how {topic} transforms the way we work.

[TIMESTAMP: 3:00]
[VISUAL: Real-world example or case study]

Let me show you a real example of this in action. This is where the theory meets practice.

[TIMESTAMP: 4:00]
[VISUAL: Step-by-step tutorial overlay]

Now let's walk through the implementation step by step. Follow along and try this yourself.

[TIMESTAMP: 5:00]
[VISUAL: Summary cards with key takeaways]

So to summarize everything we've covered today about {topic}:
1. Start with the fundamentals
2. Practice with real examples
3. Apply what you've learned

[TIMESTAMP: 5:30]
[VISUAL: End screen with subscribe button, related videos]

If you found this video helpful, please hit that like button and subscribe for more content like this. Drop a comment below telling me what you'd like to see next!

Thanks for watching, and I'll see you in the next one! 🚀"""

    return {
        "success": True,
        "script": script.strip(),
        "model": "fallback-template",
        "topic": topic,
        "tone": tone,
        "duration_minutes": duration_minutes,
        "word_count": len(script.split()),
        "fallback": True
    }


if __name__ == "__main__":
    input_data = json.loads(sys.stdin.read())
    result = generate_script(
        topic=input_data.get("topic", "Technology Trends"),
        tone=input_data.get("tone", "educational"),
        duration_minutes=input_data.get("duration_minutes", 5)
    )
    print(json.dumps(result, indent=2))
