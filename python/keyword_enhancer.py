"""
Keyword Enhancer for Stock Footage Search
Uses spaCy NLP to extract meaningful search terms from scene text.
Enhances stock footage relevance for Pexels video search.
"""

import sys
import json

try:
    import spacy
    NLP_AVAILABLE = True
except ImportError:
    NLP_AVAILABLE = False

_nlp = None


def get_nlp():
    global _nlp
    if _nlp is None and NLP_AVAILABLE:
        try:
            _nlp = spacy.load("en_core_web_sm")
        except OSError:
            pass
    return _nlp


STOCK_TERMS = {
    "success": ["success", "achievement", "celebration", "winner", "trophy"],
    "business": ["office", "corporate", "meeting", "professional", "workspace"],
    "technology": ["technology", "computer", "digital", "innovation", "coding"],
    "nature": ["nature", "landscape", "outdoor", "scenic", "environment"],
    "people": ["people", "crowd", "community", "team", "group"],
    "education": ["education", "learning", "study", "knowledge", "school"],
    "health": ["health", "fitness", "wellness", "medical", "exercise"],
    "creative": ["creative", "art", "design", "inspiration", "imagination"],
    "abstract": ["abstract", "background", "motion", "dynamic", "modern"],
    "lifestyle": ["lifestyle", "daily", "routine", "home", "living"],
}


def extract_keywords(text: str, topic: str) -> list[str]:
    keywords = set()
    topic_words = set(topic.lower().split())

    for tw in topic_words:
        if len(tw) > 2:
            keywords.add(tw)

    nlp = get_nlp()
    if nlp:
        doc = nlp(text.lower())
        for chunk in doc.noun_chunks:
            words = [t.text for t in chunk if t.pos_ in ("NOUN", "PROPN", "ADJ") and len(t.text) > 2]
            keywords.update(words)
        for token in doc:
            if token.pos_ in ("NOUN", "PROPN", "VERB") and len(token.text) > 2 and not token.is_stop:
                keywords.add(token.text)

    return list(keywords)[:8]


def map_to_stock_terms(keywords: list[str]) -> list[str]:
    results = list(keywords)
    topic_lower = " ".join(keywords).lower()

    for category, terms in STOCK_TERMS.items():
        if any(t in topic_lower for t in [category] + terms[:2]):
            results.extend(terms[:3])

    seen = set()
    unique = []
    for k in results:
        if k not in seen:
            seen.add(k)
            unique.append(k)

    return unique[:8]


if __name__ == "__main__":
    input_data = json.loads(sys.stdin.read())
    text = input_data.get("text", "")
    topic = input_data.get("topic", "")

    keywords = extract_keywords(text, topic)
    enhanced = map_to_stock_terms(keywords)

    print(json.dumps({
        "keywords": keywords,
        "enhanced_terms": enhanced,
    }))
