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
 * Reset on server restart (in-memory).
 */
const failedModels = new Set<string>();

function markModelFailed(model: AiModelConfig): void {
  failedModels.add(modelKey(model));
}

export function isModelFailed(model: AiModelConfig): boolean {
  return failedModels.has(modelKey(model));
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
// Scene Generation (for short videos)
// ========================================

const SCENES_SYSTEM_PROMPT = `You are an expert short-form video scriptwriter. You write scripts that go viral using these techniques:

- **Curiosity gaps**: Tease what's coming next, make viewers need to know
- **Bold claims**: Start with something that challenges assumptions
- **Pattern interrupts**: Break expected patterns to snap attention
- **Specific data**: Use real numbers, percentages, case studies
- **Emotional triggers**: FOMO, aspiration, surprise, relatability

Each scene has two parts:
1. "text": A spoken line (15-30 words) — conversational, specific, natural when read aloud
2. "searchTerms": 4-5 keywords describing EXACT visuals for the footage

Search terms must be ACTION-ORIENTED and SPECIFIC, not generic:
  BAD: "minecraft", "football", "cooking"
  GOOD: "player mining diamond with iron pickaxe", "crowd cheering at stadium goal celebration", "chef slicing vegetables on wooden cutting board"

Arrange scenes naturally — hook first to grab attention, body scenes each covering ONE unique angle, end with a CTA. No filler.`;

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
- "text": A spoken line (15-30 words) — specific, conversational, one clear point
- "searchTerms": 4-5 ACTION-ORIENTED keywords for stock footage matching the spoken content

STRUCTURE:
- Scene 1: HOOK — curiosity gap, bold claim, or pattern interrupt
- Scenes 2 to ${sceneCount - 1}: BODY — each scene covers ONE distinct angle with specific examples or data
- Scene ${sceneCount}: CTA — compelling reason to follow/comment/share

Example of GOOD search terms:
  Text: "Bees communicate the location of food sources through a complex dance language"
  Search terms: ["bee waggle dance explained", "honey bee communication", "bees dancing in hive macro", "how bees find flowers", "insect intelligence documentary clip"]

BAD search terms (too generic, avoid):
  ["minecraft", "game", "play", "video", "fun"]

Return ONLY a JSON array of scene objects. No markdown, no code fences.`;

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
