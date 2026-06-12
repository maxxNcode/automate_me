/**
 * AI Provider Service
 * Smart model cycling across Groq (primary) and OpenRouter (fallback) providers.
 * Uses OpenAI-compatible API format — no extra SDK needed.
 *
 * Strategy:
 *   1. Try Groq models in priority order (most capable first)
 *   2. If all Groq models fail → try OpenRouter free models
 *   3. If ALL cloud models fail → return null (caller uses built-in template fallback)
 *
 * Failed models are tracked per-session to avoid retrying dead endpoints.
 */

// ========================================
// Types
// ========================================

export interface AiModelConfig {
  provider: 'groq' | 'openrouter';
  /** The model identifier sent in the API request */
  modelId: string;
  /** Human-readable display name */
  displayName: string;
  /** Env var that holds the API key */
  apiKeyEnv: string;
  /** Base URL for the API */
  baseUrl: string;
}

export interface AiCompletionOptions {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AiCompletionResult {
  success: boolean;
  content: string;
  model: AiModelConfig;
  fallback: boolean;
}

export interface AiSceneResult {
  success: boolean;
  scenes: Array<{ text: string; searchTerms: string[] }>;
  model: string;
  fallback: boolean;
}

export interface AiProviderStatus {
  groq: { configured: boolean; available: boolean; models: string[] };
  openrouter: { configured: boolean; available: boolean; models: string[] };
}

// ========================================
// Model Priority List
// ========================================

/** All available Groq models */
export const GROQ_MODELS: AiModelConfig[] = [
  {
    provider: 'groq',
    modelId: 'llama-3.3-70b-versatile',
    displayName: 'Groq Llama 3.3 70B',
    apiKeyEnv: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
  {
    provider: 'groq',
    modelId: 'llama-3.1-8b-instant',
    displayName: 'Groq Llama 3.1 8B',
    apiKeyEnv: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
  {
    provider: 'groq',
    modelId: 'mixtral-8x7b-32768',
    displayName: 'Groq Mixtral 8x7B',
    apiKeyEnv: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
  },
];

/** All available OpenRouter models */
export const OPENROUTER_MODELS: AiModelConfig[] = [
  {
    provider: 'openrouter',
    modelId: 'deepseek/deepseek-v4-flash:free',
    displayName: 'OpenRouter DeepSeek V4 Flash',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    provider: 'openrouter',
    modelId: 'meta-llama/llama-3.3-70b-instruct:free',
    displayName: 'OpenRouter Llama 3.3 70B',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    provider: 'openrouter',
    modelId: 'nvidia/nemotron-3-super-120b-a12b:free',
    displayName: 'OpenRouter Nemotron 120B',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    provider: 'openrouter',
    modelId: 'google/gemma-4-31b-it:free',
    displayName: 'OpenRouter Gemma 4 31B',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    provider: 'openrouter',
    modelId: 'minimax/minimax-m2.5:free',
    displayName: 'OpenRouter MiniMax M2.5',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    provider: 'openrouter',
    modelId: 'qwen/qwen3-next-80b-a3b-instruct:free',
    displayName: 'OpenRouter Qwen 3 80B',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    provider: 'openrouter',
    modelId: 'moonshotai/kimi-k2.6:free',
    displayName: 'OpenRouter Kimi K2.6',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
  },
];

// Combine: Groq first (primary), then OpenRouter (fallback)
export const ALL_MODELS: AiModelConfig[] = [...GROQ_MODELS, ...OPENROUTER_MODELS];

/**
 * Find a model config by its composite key ("provider::modelId").
 */
export function findModelByKey(key: string): AiModelConfig | undefined {
  return ALL_MODELS.find(m => `${m.provider}::${m.modelId}` === key);
}

/**
 * Get the composite key for a model config.
 */
export function modelConfigKey(model: AiModelConfig): string {
  return `${model.provider}::${model.modelId}`;
}


// ========================================
// Model Failure Cache
// ========================================

/**
 * Tracks which models have failed to avoid retrying dead endpoints.
 * Entries expire after 60 seconds to prevent permanent blocking.
 * Reset on server restart (in-memory).
 */
const failedModels = new Map<string, number>();
const FAILED_MODEL_TTL = 60_000; // 60 seconds

function markModelFailed(model: AiModelConfig): void {
  failedModels.set(modelKey(model), Date.now() + FAILED_MODEL_TTL);
}

export function isModelFailed(model: AiModelConfig): boolean {
  const expiry = failedModels.get(modelKey(model));
  if (!expiry) return false;
  if (Date.now() > expiry) {
    failedModels.delete(modelKey(model));
    return false;
  }
  return true;
}

export function clearFailedModels(): void {
  failedModels.clear();
}

function modelKey(model: AiModelConfig): string {
  return `${model.provider}:${model.modelId}`;
}


// ========================================
// API Call
// ========================================

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAiChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
}

interface OpenAiChatResponse {
  choices: Array<{
    message: {
      content: string;
    };
    finish_reason: string;
  }>;
  error?: {
    message: string;
    type: string;
  };
}

async function callModel(
  model: AiModelConfig,
  messages: ChatMessage[],
  options: Partial<AiCompletionOptions> = {}
): Promise<string | null> {
  const apiKey = process.env[model.apiKeyEnv];
  if (!apiKey) {
    return null; // No API key configured for this provider
  }    const body: OpenAiChatRequest = {
    model: model.modelId,
    messages,
    max_tokens: options.maxTokens || 2048,
    temperature: options.temperature ?? 0.7,
  };

  try {
    const res = await fetch(`${model.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(model.provider === 'openrouter'
          ? {
              'HTTP-Referer': 'https://github.com/youtube-auto',
              'X-Title': 'YouTube Auto Workflow',
            }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000), // 30s timeout per model
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 401/403 = auth issue, not model failure
      if (res.status === 401 || res.status === 403) {
        return null;
      }
      // 429 = rate limited — mark as failed temporarily so we skip it
      if (res.status === 429) {
        markModelFailed(model);
        return null;
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as OpenAiChatResponse;

    if (data.error) {
      throw new Error(data.error.message);
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from model');
    }

    return content;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Transient errors — mark as failed so we skip to the next model
    // Being broad is okay: over-marking is harmless (just skipped this request)
    if (
      message.includes('rate') ||
      message.includes('overloaded') ||
      message.includes('timeout') ||
      message.includes('500') ||
      message.includes('502') ||
      message.includes('503')
    ) {
      markModelFailed(model);
    }
    return null;
  }
}

// ========================================
// Public API
// ========================================

/**
 * Get a completion from the best available AI model.
 * Cycles through Groq → OpenRouter → null (caller falls back to templates).
 */
/**
 * Get a completion from the best available AI model.
 * Cycles through Groq → OpenRouter → null (caller falls back to templates).
 *
 * @param preferredModelKey - Optional "provider::modelId" key to try first before cycling.
 */
export async function getCompletion(
  options: AiCompletionOptions,
  preferredModelKey?: string
): Promise<AiCompletionResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: options.systemPrompt },
    { role: 'user', content: options.userPrompt },
  ];

  // Determine the model order: preferred first (if set), then auto-cycle
  let modelsToTry: AiModelConfig[];

  if (preferredModelKey && preferredModelKey !== 'auto') {
    const preferred = findModelByKey(preferredModelKey);
    if (preferred) {
      // Try preferred first, then all remaining models
      modelsToTry = [
        preferred,
        ...ALL_MODELS.filter(m => modelConfigKey(m) !== preferredModelKey),
      ];
    } else {
      modelsToTry = ALL_MODELS;
    }
  } else {
    modelsToTry = ALL_MODELS;
  }

  // Try each model in order
  for (const model of modelsToTry) {
    // Skip models without API key configured
    if (!process.env[model.apiKeyEnv]) continue;
    // Skip models that have failed before
    if (isModelFailed(model)) continue;

    const content = await callModel(model, messages, options);
    if (content !== null) {
      return {
        success: true,
        content,
        model,
        fallback: false,
      };
    }
  }

  // Note: No immediate retry — rate limits won't clear in milliseconds.
  // The caller will fall back to built-in templates which is faster.

  return {
    success: false,
    content: '',
    model: { provider: 'groq', modelId: '', displayName: 'none', apiKeyEnv: '', baseUrl: '' },
    fallback: true,
  };
}

// ========================================
// Script Generation
// ========================================

const SCRIPT_SYSTEM_PROMPT = `You are a world-class YouTube scriptwriter. Write rich, detailed, and engaging video scripts that captivate viewers and deliver genuine value. Every script must feel substantive, not thin or generic.

# STRUCTURE

1. **HOOK** (0:00–0:20) — Explosive opening that grabs attention immediately. Use a bold claim, surprising statistic, provocative question, or counter-intuitive statement.
2. **INTRO** (0:20–1:00) — Context and preview. Tell viewers what they'll learn and why it matters to them.
3. **MAIN CONTENT** — Deep dive with 3–5 distinct points. Each point needs:
   - A clear claim
   - A specific example, data point, or real-world case
   - Why it matters to the viewer
4. **SUMMARY** (final ~10%) — Recap the 3–5 takeaways in punchy, memorable sentences.
5. **CTA** (last 15–20 seconds) — Specific call to action with a reason (e.g. "Subscribe for weekly deep-dives on [topic] — next video covers X").

# REQUIREMENTS

- **Be specific.** Every claim needs evidence. Use numbers, percentages, names, dates, real companies, real tools. No vague filler.
- **Conversational but rich.** Write in natural spoken English with varied sentence structure. Avoid lists. Use rhetorical questions, short punchy lines, and flow between ideas.
- **[VISUAL: ...]** cues every 20–40 seconds suggesting b-roll, graphics, or screen recordings.
- **[TIMESTAMP: M:SS]** markers every 30–60 seconds.
- **Build curiosity.** Tease what's coming next at the end of each section.
- **Write at ~160 words per minute.** A 5-minute script should be ~800 words. A 10-minute script ~1600 words.
- **Don't rush.** Let ideas breathe. Include mini-stories or analogies.
- **Avoid clichés.** No "let's dive in", "without further ado", "in this video we'll explore". Start with the hook directly.`;

export async function generateScript(
  topic: string,
  tone: string = 'educational',
  durationMinutes: number = 5,
  preferredModelKey?: string
): Promise<{ content: string; model: string; fallback: boolean }> {
  const wordCount = Math.round(durationMinutes * 160);

  const userPrompt = `Write a detailed, rich YouTube video script about "${topic}" in a ${tone} tone.

Target duration: ~${durationMinutes} minutes (aim for ~${wordCount} words total)

REQUIREMENTS:
- Open with a BOLD hook — surprising stat, provocative question, or counter-intuitive claim
- Cover 3-5 distinct points, each with SPECIFIC examples (real companies, tools, data, or names)
- Build curiosity throughout — tease what's coming next
- Include [VISUAL: ...] cues every 20-40 seconds for b-roll, graphics, or screen recordings
- Include [TIMESTAMP: M:SS] markers every 30-60 seconds
- End with a compelling CTA tied to the topic (not generic "like and subscribe")
- Write conversationally — like you're explaining to a friend who's curious
- Every section must deliver tangible value. No filler. No fluff.`;

  const result = await getCompletion({
    systemPrompt: SCRIPT_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: Math.min(wordCount * 2, 8192),
    temperature: 0.75,
  }, preferredModelKey);

  if (!result.success) {
    return { content: '', model: 'none', fallback: true };
  }

  return {
    content: result.content,
    model: result.model.displayName,
    fallback: false,
  };
}

// ========================================
// Inline Scene Script Generation
// ========================================

/**
 * System prompt for the "flowing script" approach.
 * The AI writes one continuous script with [visual description] markers
 * embedded inline. These markers define what footage plays during the
 * following lines, creating a coherent narrative without topic drift.
 */
// ========================================
// Stickman Story Master JSON Generation
// ========================================

const STICKMAN_STORY_SYSTEM_PROMPT = `You are a professional AI visual storyteller. Your output is used by users who paste your image prompts into external AI image generators.

=== NARRATIVE CONTINUITY (CRITICAL) ===

The story must feel like a CONTINUOUS SCENE-BY-SCENE NARRATIVE. Each scene is the immediate next moment after the previous one. The character should NOT teleport between unrelated locations.

- If the character needs to be in a new location, show them WALKING or TRAVELING there
- Each scene is cause → effect: the character does something, then reacts to the result
- The environment should feel consistent — same general world, time of day progresses naturally
- Bad: Scene 1 on Mars surface → Scene 2 in underground city (teleport!)
- Good: Scene 1 walking on Mars surface → Scene 2 approaching cave entrance → Scene 3 entering cave → Scene 4 inside city

=== FULL STORY (NEW) ===

First, write a FULL continuous story in 3-5 natural paragraphs (~500 words total). This is the exact text that will be sent to the text-to-speech engine. Write it as a proper story — with sentence variety, paragraph breaks, natural pauses, and storytelling rhythm. Use proper punctuation throughout (periods, commas, semicolons, em dashes). The TTS engine reads this text directly, so it MUST sound like a human telling a story when read aloud.

The paragraphs SHOULD flow naturally — after a few sentences, a slight pause, then continue with the next paragraph. Vary sentence length. Some short. Some longer and more descriptive. This creates natural vocal rhythm.

CRITICAL: The full_story must contain ONLY pure narrative text. No URLs, no web references, no http:// or www., no file paths, no code, no markdown formatting, no asterisks or special symbols that a TTS would read aloud as symbols. This text goes DIRECTLY to speech synthesis — if it has URLs, the robot voice will say "http colon forward slash forward slash". Just tell the story naturally.

=== SCENE STRUCTURE ===

After writing the full story, break it into 30-40 scenes. Each scene gets:
- "narration_text": a short excerpt (~10-15 words) from the full_story. When concatenated in order with spaces, all narration_text fields must exactly reconstruct the full_story. Each fragment ends naturally (period, comma, or em dash) and flows into the next.
- "image_prompt": visual description for this scene

OUTPUT FORMAT:

Return ONLY a valid JSON object with THREE keys: "full_story", "setup_guide", and "script_pipeline".

=== STEP 1 — CHARACTER BASE PROMPT (setup_guide.base_prompt) ===

Write a single descriptive paragraph covering: overall vibe, character appearance (hair, clothing), art style (sketchy outlines, colored-pencil texture, pastel tones), line quality, color palette, emotional context, and aspect ratio (16:9).

=== STEP 2 — SCENE PROMPTS (script_pipeline array) ===

Each scene object must have:

1. "narration_text": Short excerpt (~10-15 words) from the full_story. Every scene's narration_text, concatenated in order with spaces, must exactly reconstruct the full_story. The TTS reads the full_story — not individual fragments — so narration_text is only for scene timing and display.

2. "duration_seconds": Always 4-6 seconds per scene. Calculate from narration word count (~2.8 words/sec). Total scenes × avg duration should roughly match target video length.

3. "image_prompt": 2-3 sentence paragraph. Copy-pasteable into an AI image generator. Rules:
   - Start with "Use the same stickman character as before."
   - Describe character pose, action, facial expression
   - Describe the environment — MUST follow naturally from previous scene's location
   - Include props the character interacts with
   - Reference art style: hand-drawn, sketchy outlines, colored-pencil texture, soft pastel tones
   - Do NOT repeat aspect ratio

4. "sd_api_payload" (optional): Same text as image_prompt.

=== GLOBAL RULES ===
- Same character in every scene
- Continuous narrative — no teleporting, no time skips
- Cause and effect between consecutive scenes
- full_story must be the canonical source: all narration_text fragments concatenated with spaces = full_story exactly
- Scenes progress chronologically with natural flow

Output ONLY the raw JSON — no markdown, no code fences, no explanation.`;

export async function generateStickmanStoryJson(
  topic: string,
  tone: string = 'educational',
  preferredModelKey?: string,
  targetSceneCount?: number
): Promise<{ success: boolean; json: string; model: string; fallback: boolean }> {
  const sceneCount = targetSceneCount || 30; // default to ~30 scenes
  const wordsTotal = Math.round(sceneCount * 12); // ~12 words per scene excerpt
  const paragraphs = Math.min(Math.max(Math.round(sceneCount / 7), 2), 6); // ~7 scenes per paragraph

  const userPrompt = `Create a stickman story video about: "${topic}"

Tone: ${tone}
Style: Hand-drawn aesthetic, sketchy outlines, colored-pencil texture, soft pastel tones.
Aspect ratio: 16:9

First, write the full story as ${paragraphs} natural paragraphs (~${wordsTotal} words total). Then break it into exactly ${sceneCount} scenes where each scene gets a short excerpt of the narration (~10-15 words). The full_story is what the voiceover reads — it must sound like a real person telling a story, with paragraph breaks and natural pacing.

The character must NOT teleport between locations. Each scene flows naturally into the next.

Every image_prompt starts with "Use the same stickman character as before."

Write the narration_text with natural story-telling punctuation — periods at sentence endings, commas and dashes where the story continues. When joined together, it should sound like a human telling a story out loud.

Return ONLY valid JSON with "setup_guide" and "script_pipeline" keys.`;

  const result = await getCompletion({
    systemPrompt: STICKMAN_STORY_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 16384,
    temperature: 0.85,
  }, preferredModelKey);

  if (!result.success) {
    return { success: false, json: '', model: '', fallback: true };
  }

  return {
    success: true,
    json: result.content,
    model: result.model.displayName,
    fallback: false,
  };
}

const INLINE_SCRIPT_SYSTEM_PROMPT = `You are an expert short-form video scriptwriter. Your specialty is writing one continuous, flowing narrative — not disconnected scenes.

# CRITICAL: How [brackets] work

The text inside [brackets] is a **visual scene description** that will be used to search stock footage libraries (Pexels, YouTube). Each [bracket] describes WHAT THE VIEWER SEES on screen — the VISUAL STORY.

These descriptions are used as search queries to find matching video footage. Write them like a cinematographer directing a shot:

  GOOD: [dark rainy window at night soft lighting calm atmosphere] → finds matching footage
  GOOD: [person sitting alone in dim room contemplative mood] → finds matching footage
  GOOD: [sunlight streaming through trees peaceful nature scene] → finds matching footage
  GOOD: [candle on wooden table warm glow slow motion] → finds matching footage

Key tips:
- Describe MOOD, LIGHTING, ENVIRONMENT, and SUBJECT — not just the action
- Write 5-15 words painting a clear visual picture
- Focus on common, recognizable scenes that stock footage would contain
- Avoid ultra-specific details like brand names, famous locations, or rare animals
- Each description should feel like the look and feel of a scene in a movie

# RULES

Write a SINGLE continuous script about the given topic. The script must feel like one person telling one story from start to finish.

Embed visual scene descriptions INSIDE square brackets like this:
  [dark gym moody lighting person lifting heavy weights]
  Most people never push past their comfort zone. That's exactly where the gains come from.
  [sunset track runner silhouetted against sky]
  Your body adapts to intensity, not duration. Short bursts trigger real growth.

# STRUCTURE

- Start with a HOOK (first [bracket] + 1-2 sentences) that grabs attention
- Flow naturally through 5-8 segments, each with its own [bracket] + spoken text
- End with a CTA (1-2 sentences)

# REQUIREMENTS

- Every [bracket] MUST describe the visual scene in 5-15 words — mood, lighting, environment, subject
- The bracket visual MUST match the emotional tone of the spoken text
- Spoken text: conversational, specific, one clear idea per segment
- No disconnected topics — each segment builds on the last
- No markdown, no numbering, no JSON — just the raw script with [brackets]`;

// ========================================
// Inline Script Generation + Parser
// ========================================

/**
 * Call the AI to generate a single flowing script with [visual] markers.
 * Returns the raw script text (not parsed into scenes yet).
 */
export async function generateInlineScript(
  topic: string,
  tone: string = 'educational',
  durationSeconds: number = 30,
  preferredModelKey?: string
): Promise<{ content: string; model: string; fallback: boolean }> {
  const sceneCount = Math.max(4, Math.min(10, Math.round(durationSeconds / 5)));

  const totalWords = Math.round(durationSeconds * 2.8);
  const wordsPerSegment = Math.max(10, Math.round(totalWords / sceneCount));

  const userPrompt = `Write a flowing, continuous short video script about: "${topic}"

Tone: ${tone}
Target duration: ~${durationSeconds} seconds
Segments: ${sceneCount}
Total script: ~${totalWords} words (${wordsPerSegment} words per segment)

Write a SINGLE flowing script. Embed [visual scene description] markers throughout.

IMPORTANT: Every [bracket] describes what the viewer SEES — the mood, lighting, environment, and subject:
  GOOD: [dark rainy window night time calm atmosphere] [person sitting alone dim room thinking] [sunset running track silhouetted figure]
  GOOD: [candle on wooden desk warm glow peaceful mood] [empty classroom soft sunlight streaming in]

Example format:
[dog sprinting across grass field slow motion side view]
Dogs can reach 45 miles per hour. That's faster than any human.
[dog resting in sunbeam peaceful close up]
Their secret? Flexible spines that act like a spring.

YOUR SCRIPT (for topic: "${topic}", tone: ${tone}):
`;

  const result = await getCompletion({
    systemPrompt: INLINE_SCRIPT_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 4096,
    temperature: 0.85,
  }, preferredModelKey);

  if (!result.success) {
    return { content: '', model: 'builtin-fallback', fallback: true };
  }

  return {
    content: result.content,
    model: result.model.displayName,
    fallback: false,
  };
}

/**
 * Parse a script with embedded [visual markers] into scene objects.
 * 
 * Input:  "[a dog running] Did you know dogs run fast? [slow motion] They have flexible spines..."
 * Output: [{text: "Did you know dogs run fast?", searchTerms: ["a dog running"]}, ...]
 */
export function parseInlineScriptToScenes(script: string): Array<{ text: string; searchTerms: string[] }> {
  const scenes: Array<{ text: string; searchTerms: string[] }> = [];

  const stopWords = new Set([
    'the', 'and', 'with', 'that', 'this', 'from', 'they',
    'their', 'them', 'its', 'have', 'has', 'are', 'for',
    'not', 'but', 'all', 'out', 'just', 'like',
  ]);

  // Match [visual] followed by text (greedy until next [ or end of string)
  const pattern = /\[([^\]]+)\]\s*([^[]+)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(script)) !== null) {
    const visual = match[1].trim();
    const text = match[2].trim();

    if (!text || text.length < 5) continue;

    // Build search terms from the visual description
    // Keep the full description as the primary query, plus extract key words
    const words = visual
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
      .slice(0, 5);
    const searchTerms = [visual, ...words];
    // Deduplicate while preserving order
    const unique: string[] = [];
    for (const t of searchTerms) {
      if (!unique.includes(t)) unique.push(t);
    }

    scenes.push({
      text,
      searchTerms: unique.slice(0, 5),
    });
  }

  return scenes;
}

// ========================================
// Scene Generation (for short videos)
// ========================================

const SCENES_SYSTEM_PROMPT = `You are an expert short-form video scriptwriter. You write scripts that go viral using these techniques:

- **Curiosity gaps**: Tease what's coming next, make viewers need to know
- **Bold claims**: Start with something that challenges assumptions
- **Pattern interrupts**: Break expected patterns to snap attention
- **Specific data**: Use real numbers, percentages, case studies
- **Emotional triggers**: FOMO, aspiration, surprise, relatability

Each scene has two parts:
1. "text": A spoken line (15-30 words) — conversational, specific, natural when read aloud. Each line must cover ONE clear, distinct idea.
2. "searchTerms": Exactly 5 short visual search queries (each 2-6 words) describing the VISUAL SCENE for stock footage.

# How to write GREAT search terms

Search terms must describe MOOD, LIGHTING, ENVIRONMENT, and SUBJECT — like a cinematographer directing a shot. Each term is a SHORT search query (2-6 words) that can be used to find matching stock footage:

  GOOD terms:
    - ["dark rainy window", "night time mood", "soft lighting", "calm atmosphere", "lonely room"]
    - ["beach sunset run", "golden hour", "silhouette runner", "ocean waves", "warm glow"]
  
  BAD terms (too generic, won't match):
    - ["person", "running", "beach"]  ← individual keywords are terrible for stock footage search
    - ["minecraft", "game", "boxing", "music video"]  ← off-topic garbage

Key rules:
- Each term is a SHORT PHRASE (2-6 words), NOT a single keyword
- Describe what the viewer SEES: mood, lighting, environment, subject
- Terms must match the emotional tone of the spoken text
- Avoid brand names, famous locations, rare animals, ultra-specific details
- Think "stock footage search query" — common scenes that exist in Pexels/Pixabay/YouTube

# Structure

Arrange scenes in this order:
- Scene 1: HOOK — curiosity gap, bold claim, or pattern interrupt (grabs attention immediately)
- Scenes 2 to N-1: BODY — each scene covers ONE distinct angle with specific examples or data
- Final scene: CTA — compelling reason to follow/comment/share

Every scene must feel connected. No filler. No generic advice.`;

/**
 * Generate scenes for a short-form video using the AI provider.
 * Returns empty array if all cloud models fail.
 */
export async function generateScenes(
  topic: string,
  tone: string = 'educational',
  durationSeconds: number = 30,
  preferredModelKey?: string
): Promise<AiSceneResult> {
  const sceneCount = Math.max(4, Math.min(12, Math.round(durationSeconds / 5)));

  const userPrompt = `Generate ${sceneCount} scenes for a short video about: "${topic}"

Tone: ${tone}
Target duration: ~${durationSeconds} seconds (${sceneCount} scenes)

Each scene MUST have:
- "text": A spoken line (15-30 words) — specific, conversational, one CLEAR point. Each scene covers ONE distinct angle.
- "searchTerms": Exactly 5 short visual search queries (each 2-6 words) for finding matching stock footage

# Search term examples

Text: "Bees communicate food locations through a complex dance language"
Search terms: ["bee close up macro", "honeycomb natural light", "bees working hive", "insect on flower", "golden honey drip"]

Text: "Most people fail because they skip the fundamentals"
Search terms: ["person studying desk", "open book pages", "student writing notes", "quiet library", "morning study session"]

# Rules
- Each search term is 2-6 words — a SHORT PHRASE, not a single keyword
- Describe WHAT THE VIEWER SEES: mood, lighting, environment, subject
- Terms must match the emotional tone of the spoken text
- Avoid: single keywords, brand names, rare animals, "boxing", "gameplay", "minecraft", "music"

# Structure
- Scene 1: HOOK — bold claim, curiosity gap, or surprising stat
- Scenes 2 to ${sceneCount - 1}: BODY — each scene ONE unique angle with specific examples or data
- Scene ${sceneCount}: CTA — compelling reason to follow/comment/share

Return ONLY a raw JSON array of scene objects. No markdown, no code fences, no explanation.`;

  const result = await getCompletion({
    systemPrompt: SCENES_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 4096,
    temperature: 0.85,
  }, preferredModelKey);

  if (!result.success) {
    return { success: false, scenes: [], model: 'builtin-fallback', fallback: true };
  }

  // Parse JSON from the response
  try {
    // Try direct parse first
    let text = result.content.trim();
    // Strip markdown code blocks
    text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    // Try to find JSON array in the response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const jsonStr = jsonMatch ? jsonMatch[0] : text;
    
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const scenes = parsed
        .filter((s: unknown) => s && typeof s === 'object' && 'text' in (s as Record<string, unknown>))
        .slice(0, 15) // generous cap, scene count limited by prompt
        .map((s: Record<string, unknown>) => ({
          text: String(s.text || ''),
          searchTerms: Array.isArray(s.searchTerms)
            ? (s.searchTerms as string[]).filter(t => typeof t === 'string').slice(0, 5)
            : [],
        }))
        .filter(s => s.text.length > 3);

      if (scenes.length > 0) {
        return {
          success: true,
          scenes,
          model: result.model.displayName,
          fallback: false,
        };
      }
    }
  } catch {
    // JSON parse failed — try fallback extraction
  }

  // Fallback: try to extract any scene-like content
  return { success: false, scenes: [], model: result.model.displayName, fallback: true };
}

// ========================================
// Status Check
// ========================================

/**
 * Try each model of a provider until one responds successfully.
 * This avoids false negatives when one specific model is rate-limited but others work.
 */
async function tryProviderModels(models: AiModelConfig[]): Promise<boolean> {
  for (const model of models) {
    const result = await callModel(
      model,
      [{ role: 'user', content: 'Reply with just: OK' }],
      { maxTokens: 10, temperature: 0 }
    );
    if (result !== null && result.includes('OK')) {
      return true;
    }
  }
  return false;
}

/** Check which providers are configured and available */
export async function checkAiProviders(): Promise<AiProviderStatus> {
  const groqConfigured = !!process.env.GROQ_API_KEY;
  const openrouterConfigured = !!process.env.OPENROUTER_API_KEY;

  // Try ALL models per provider, not just the first one.
  // This handles the case where model #1 is rate-limited (429) but others work.
  const [groqAvailable, openrouterAvailable] = await Promise.all([
    groqConfigured ? tryProviderModels(GROQ_MODELS) : Promise.resolve(false),
    openrouterConfigured ? tryProviderModels(OPENROUTER_MODELS) : Promise.resolve(false),
  ]);

  return {
    groq: {
      configured: groqConfigured,
      available: groqAvailable,
      models: GROQ_MODELS.map(m => m.modelId),
    },
    openrouter: {
      configured: openrouterConfigured,
      available: openrouterAvailable,
      models: OPENROUTER_MODELS.map(m => m.modelId),
    },
  };
}
