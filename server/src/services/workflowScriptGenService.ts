import { OrchestratorContext } from './workflowContext';
import { runPythonScript, getOutputDir, findPython } from './pythonRunner';
import { ShortVideoScene } from './shortVideoMaker';
import { generateScript as aiGenerateScript, generateScenes as aiGenerateScenes } from './aiProvider';
import {
  WorkflowState,
  WorkflowStep,
  StepStatus,
  PipelineRequest,
  ScriptResult,
  VoiceoverRequest,
  VoiceoverResult,
  ThumbnailRequest,
  ThumbnailResult,
  VideoResult,
  UploadResult,
  WsEvent,
} from '../types';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export class WorkflowScriptGenService {
  private ctx: OrchestratorContext;
  activeWorkflows: Set<string> = new Set();

  constructor(ctx: OrchestratorContext) {
    this.ctx = ctx;
  }

  async generateAIScenes(workflowId: string, topic: string, tone?: string, durationMinutes?: number, preferredModel?: string): Promise<ShortVideoScene[]> {
    try {
      const durationSeconds = Math.round((durationMinutes || 0.5) * 60);
      this.ctx.emitEvent(workflowId, 'log', { message: `Generating AI scenes (${durationSeconds}s target, ${preferredModel || 'auto'})...` });
      const result = await aiGenerateScenes(topic, tone || 'educational', durationSeconds, preferredModel);

      if (!result.success || !result.scenes || result.scenes.length === 0) {
        this.ctx.emitEvent(workflowId, 'log', { message: 'AI scene generation returned no scenes', level: 'warn' });
        return [];
      }

      this.ctx.emitEvent(workflowId, 'log', { message: `AI generated ${result.scenes.length} structured scenes` });
      return result.scenes;
    } catch {
      return [];
    }
  }

  async generateScript(
    workflowId: string,
    request: PipelineRequest,
    preferredModel?: string
  ): Promise<ScriptResult> {
    this.ctx.emitEvent(workflowId, 'log', { message: `Generating script for "${request.topic}" (${request.tone || 'educational'}, ${request.duration_minutes || 5}min)` });
    this.ctx.emitEvent(workflowId, 'log', { message: `AI model: ${preferredModel || 'auto (smart cycle)'}` });
    try {
      const result = await aiGenerateScript(
        request.topic,
        request.tone || 'educational',
        request.duration_minutes || 5,
        preferredModel
      );

      if (!result.fallback && result.content) {
        this.ctx.emitEvent(workflowId, 'log', { message: `Script generated successfully using ${result.model} (${result.content.split(/\s+/).length} words)` });
        return {
          success: true,
          script: result.content,
          model: result.model,
          topic: request.topic,
          tone: request.tone || 'educational',
          duration_minutes: request.duration_minutes || 5,
          word_count: result.content.split(/\s+/).length,
          fallback: false,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.ctx.emitEvent(workflowId, 'log', { message: `AI script generation failed: ${msg}`, level: 'error' });
    }

    return {
      success: true,
      script: this.generateFallbackScript(request.topic, request.tone),
      model: 'builtin-fallback',
      topic: request.topic,
      tone: request.tone || 'educational',
      duration_minutes: request.duration_minutes || 5,
      word_count: 300,
      fallback: true,
    };
  }

  async generateVoiceover(
    workflowId: string,
    script: string,
    voice?: string
  ): Promise<VoiceoverResult> {
    this.ctx.emitEvent(workflowId, 'log', { message: `Generating voiceover (voice: ${voice || 'default'})...` });
    this.ctx.emitEvent(workflowId, 'log', { message: `Running edge-tts (${script.split(/\s+/).length} words)` });
    const input: VoiceoverRequest = {
      script,
      voice: voice || 'en-US-AriaNeural',
      use_ssml: true,
    };

    try {
      const result = await runPythonScript<VoiceoverResult>('coqui_tts.py', input as unknown as Record<string, unknown>);
      this.ctx.emitEvent(workflowId, 'log', { message: `Voiceover generated: ${result.file_path} (${result.duration_seconds}s)` });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.ctx.emitEvent(workflowId, 'log', { message: `Voiceover generation failed: ${msg}`, level: 'error' });
      this.ctx.emitEvent(workflowId, 'log', { message: 'Falling back to silent voiceover', level: 'warn' });
      return {
        success: true,
        file_path: '',
        filename: 'voiceover.wav',
        duration_seconds: 0,
        segments: 0,
        voice_model: 'fallback-silent',
        fallback: true,
      };
    }
  }

  /**
   * Generate voiceover using Kokoro-82M TTS model.
   * Falls back to edge-tts if Kokoro is unavailable.
   */
  async generateVoiceoverKokoro(
    workflowId: string,
    script: string,
    voice: string = 'af_heart'
  ): Promise<VoiceoverResult> {
    this.ctx.emitEvent(workflowId, 'log', { message: `Generating Kokoro voiceover (voice: ${voice})...` });

    const outputFilename = `voiceover_kokoro_${workflowId.slice(0, 8)}.wav`;

    try {
      const result = await runPythonScript<VoiceoverResult>('kokoro_tts.py', {
        script,
        voice,
        speed: 1.0,
        output_filename: outputFilename,
      } as unknown as Record<string, unknown>, { timeout: 180000 });

      this.ctx.emitEvent(workflowId, 'log', { message: `Voiceover generated via Kokoro: ${result.file_path} (${result.duration_seconds}s)` });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      this.ctx.emitEvent(workflowId, 'log', { message: `Kokoro voiceover failed: ${msg}`, level: 'warn' });
      this.ctx.emitEvent(workflowId, 'log', { message: 'Falling back to edge-tts...', level: 'info' });

      // Fall back to edge-tts
      return this.generateVoiceover(workflowId, script, voice);
    }
  }

  async generateThumbnail(
    workflowId: string,
    topic: string,
    style?: 'eye-catching' | 'minimalist' | 'educational'
  ): Promise<ThumbnailResult> {
    this.ctx.emitEvent(workflowId, 'log', { message: `Generating server-side thumbnail (style: ${style || 'eye-catching'})...` });
    this.ctx.emitEvent(workflowId, 'log', { message: 'stable_diffusion.py removed — using SVG fallback', level: 'warn' });
    const thumbPath = this.generateFallbackThumbnail(topic, workflowId);
    return {
      success: true,
      file_path: thumbPath,
      filename: path.basename(thumbPath),
      style: 'fallback-generated',
      dimensions: '1280x720',
      fallback: true,
    };
  }

  buildShortScenes(topic: string, tone?: string, durationMinutes?: number): ShortVideoScene[] {
    const primaryKeywords = topic.split(' ').filter(w => w.length > 2);
    const fallbackKeywords = ['motivation', 'success', 'inspiration'];
    const keywords = primaryKeywords.length >= 2 ? primaryKeywords : fallbackKeywords;

    const hooks: Record<string, string[]> = {
      educational: [
        `Most people get ${topic} completely wrong. Here's what actually works.`,
        `Here's the ${topic} strategy that 99% of people don't know about.`,
        `The truth about ${topic} that nobody tells you upfront.`,
        `Stop wasting time on ${topic}. Do this instead and thank me later.`,
        `What if I told you ${topic} is simpler than you think?`,
        `The number one reason people fail at ${topic} — and how to fix it.`,
        `You've been doing ${topic} backwards. Let me explain.`,
        `Before you spend another minute on ${topic}, watch this.`,
        `I wish I knew this about ${topic} when I started.`,
        `Three words that will change how you approach ${topic}.`,
      ],
      entertaining: [
        `You won't believe what I just found out about ${topic}. Mind blown.`,
        `Okay, so ${topic} is way more interesting than anyone tells you. Watch this.`,
        `This ${topic} secret will completely change how you see everything.`,
        `Everybody talks about ${topic}. Nobody tells you THIS part.`,
        `I went down a ${topic} rabbit hole and found something WILD.`,
        `Hold onto your seat — this ${topic} revelation changes everything.`,
        `${topic} just got a lot more interesting. Trust me on this.`,
        `You think you know ${topic}? Think again.`,
        `This ${topic} story is insane. You won't believe how it ends.`,
        `The ${topic} industry doesn't want you to know this.`,
      ],
      professional: [
        `Here's the ${topic} strategy that top performers swear by.`,
        `The ${topic} advice that actually makes you money in 2026.`,
        `Stop losing opportunities because of bad ${topic}. Fix it now.`,
        `The ROI of getting ${topic} right? Life changing. Here's how.`,
        `Here's the ${topic} framework I use with my clients.`,
        `Three ${topic} metrics that actually matter. Ignore the rest.`,
        `I analyzed 100 ${topic} case studies. Here's the common thread.`,
        `The gap between average and elite ${topic}? It's smaller than you think.`,
        `This ${topic} audit revealed a massive efficiency gap. Here's how to close it.`,
        `Your ${topic} strategy is leaking money. Here's the fix.`,
      ],
      casual: [
        `So apparently everyone is wrong about ${topic}. Here's the truth.`,
        `Real talk about ${topic} that nobody wants to admit.`,
        `If you're into ${topic}, this video is literally for you.`,
        `Before you go deeper into ${topic}, you NEED to know this.`,
        `Can we talk about ${topic}? Like, actually talk about it?`,
        `${topic} doesn't have to be this hard. Seriously.`,
        `Let's cut the BS about ${topic} and talk about what actually works.`,
        `I need to get something off my chest about ${topic}.`,
        `You're overthinking ${topic}. Here's the simple version.`,
        `Hot take: most ${topic} advice is garbage. Here's what's not.`,
      ],
    };

    const valueLines: Record<string, string[]> = {
      educational: [
        `${topic} isn't as complicated as people make it. Strip away the noise and focus on ONE core principle. Master that before anything else.`,
        `Stop trying to learn everything at once. Pick the one area of ${topic} that matters most to YOU and go deep. Depth beats breadth every time.`,
        `Consistency over intensity. Small daily progress in ${topic} compounds into massive results. 1% better every day.`,
        `Find your ${topic} community. Learning alone is 10x harder. Learn with others and you'll grow 10x faster.`,
        `Think of ${topic} like building a house. You wouldn't put on the roof before pouring the foundation. Get the basics rock solid first.`,
        `The 80/20 rule applies to ${topic}: 80% of results come from 20% of effort. Find that 20% and double down. Everything else is optional.`,
        `Instead of asking "what should I learn about ${topic}", ask "what problem am I solving". Start with the problem, work backward to the knowledge.`,
        `Deliberate practice is the difference between knowing about ${topic} and being good at it. Not just doing it, but doing it with intention.`,
        `Don't optimize everything at once. Pick one thing about ${topic}, make it a habit, then move to the next. Small wins compound.`,
        `Try explaining ${topic} to a friend in one minute. If you can't simplify it, you don't understand it well enough yet.`,
      ],
      entertaining: [
        `The more you dig into ${topic}, the weirder it gets. The things you think you know? Half of them are wrong. And the real story is way more interesting.`,
        `The biggest plot twist? The people who are best at ${topic} started out TERRIBLE. They just refused to quit. That's literally the only difference.`,
        `Most ${topic} "experts" are just people who were curious longer than everyone else. That's it. Curiosity beats talent every time.`,
        `The secret nobody tells you about ${topic}? It's supposed to be fun. If you're not enjoying it, you're doing it wrong.`,
        `The history of ${topic} is full of happy accidents that changed everything. The biggest breakthroughs happened by complete mistake.`,
        `The irony of ${topic}: the more seriously you take it, the worse you get. The best in the world treat it like a game.`,
        `Everything you think you know about ${topic} was probably designed to sell you something. The real story is way more interesting.`,
        `The most successful ${topic} stories start with embarrassing failure. The kind most people would quit over. That's the real secret.`,
      ],
      professional: [
        `Companies investing in ${topic} outperform competitors by 3x. But only if they do it right. Top performers prioritize systems over talent.`,
        `Measure what matters. Track progress in ${topic} with clear KPIs. What gets measured gets improved. Stop guessing, start knowing.`,
        `Iterate fast. The best ${topic} teams ship, learn, and improve. They don't wait for perfection. Speed of execution is the competitive advantage.`,
        `The ${topic} stack that delivers: right tooling, right process, right people. Skip any one and it falls apart.`,
        `Framework I use with clients: Assess, Prioritize, Execute, Review. Most skip straight to Execute and wonder why nothing changes.`,
        `Don't copy what successful companies do with ${topic} without understanding their context. Your situation is different. Your solution should be too.`,
        `Stop measuring activity in ${topic}. Start measuring outcomes. Hours spent means nothing. What changed as a result?`,
        `The most profitable ${topic} investment? Documentation. Every dollar spent on clarity saves ten on confusion.`,
        `The best ${topic} teams don't wait for perfect. They launch, learn, and iterate. Speed beats perfection.`,
      ],
      casual: [
        `Everyone overcomplicates ${topic}. Strip it back to basics and suddenly everything clicks.`,
        `Nobody knows what they're doing with ${topic} at first. The ones who succeed just kept showing up. That's it.`,
        `The easiest way to get started with ${topic}? Literally just start. Perfect is the enemy of done.`,
        `I tried being perfect at ${topic} for years. Nothing happened. The moment I allowed myself to be messy, everything changed.`,
        `The vibe with ${topic}: do it badly until you can do it well. There's no shortcut. Just showing up again and again.`,
        `The first six months of ${topic} will feel like you're getting nowhere. Push through. That's where the magic happens.`,
        `You don't need a detailed ${topic} plan. You need to take one step today. Tomorrow, another. That's the entire secret.`,
        `Nobody in ${topic} has it all figured out. We're all figuring it out as we go. That's the honest truth.`,
        `If ${topic} feels hard right now, good. That means you're growing. The day it feels easy is the day you stopped learning.`,
      ],
    };

    const ctas: Record<string, string[]> = {
      educational: [
        `If this helped, follow for more ${topic} insights. Save this for later.`,
        `Drop a comment with your biggest ${topic} challenge. Let's figure it out together.`,
        `Follow for daily ${topic} tips. Save this so you can come back to it.`,
        `Comment your biggest ${topic} struggle — I'll answer the best ones in my next video.`,
        `Save this as your ${topic} cheat sheet. Follow for part two.`,
        `Take ONE thing from this and apply it today. Comment what you picked.`,
      ],
      entertaining: [
        `Like if this surprised you. Follow for more. Comment your thoughts.`,
        `Save this to show your friends. They won't believe it either.`,
        `Follow for more mind-blowing content. This is just the beginning.`,
        `Comment "more" if you want a deep dive on this.`,
        `Share this with someone who needs to hear this today.`,
        `Like if you made it this far. You're part of the 1%. Respect.`,
      ],
      professional: [
        `Save this strategy. Follow for more ${topic} insights. Share with your team.`,
        `Follow for actionable ${topic} advice. This is how winners operate.`,
        `Drop a comment: what's your biggest ${topic} goal right now?`,
        `Bookmark this for your next ${topic} planning session.`,
        `Share this with a colleague who needs to level up their ${topic} game.`,
        `Like if this added value. Comment your biggest takeaway.`,
      ],
      casual: [
        `Save this for later. Follow for more real talk. Share if you agree.`,
        `Comment your hot take. I read every single one.`,
        `Like if this resonated. Follow for more. We're just getting started.`,
        `Share this with a friend who's struggling with ${topic}. They need to hear it.`,
        `Save this for days when ${topic} feels impossible. Come back to it.`,
        `Follow for unfiltered ${topic} advice. No BS, just real talk.`,
      ],
    };

    const safeTone = (tone || 'educational') as keyof typeof hooks;
    const toneHooks = hooks[safeTone] || hooks.educational;
    const toneValues = valueLines[safeTone] || valueLines.educational;
    const toneCtas = ctas[safeTone] || ctas.educational;

    const scenes: ShortVideoScene[] = [];

    // Scene 1: Hook
    const hookText = toneHooks[Math.floor(Math.random() * toneHooks.length)];
    scenes.push({
      text: hookText,
      searchTerms: this.extractSearchTermsFromText(hookText, keywords),
    });

    // Calculate value scene count from duration (0.25min=15s -> 1, 0.5min=30s -> 2, 1min=60s -> 3, 2min=120s -> 3)
    const maxValueScenes = Math.min(Math.max(Math.round((durationMinutes || 0.5) * 3), 1), 4);
    // Pick value scenes randomly (not sequential by index)
    const shuffledValues = [...toneValues].sort(() => Math.random() - 0.5);
    const selectedValues = shuffledValues.slice(0, Math.min(maxValueScenes, shuffledValues.length));
    for (const valueText of selectedValues) {
      scenes.push({
        text: valueText,
        searchTerms: this.extractSearchTermsFromText(valueText, keywords),
      });
    }

    // Final scene: CTA
    const ctaText = toneCtas[Math.floor(Math.random() * toneCtas.length)];
    scenes.push({
      text: ctaText,
      searchTerms: this.extractSearchTermsFromText(ctaText, keywords),
    });

    return scenes;
  }

  topicToScenes(topic: string, script: string): ShortVideoScene[] {
    const searchTerms = topic.split(' ').filter(w => w.length > 3);
    if (searchTerms.length === 0) {
      searchTerms.push('motivation', 'inspiration', 'success');
    }

    const sentences = script
      .replace(/\[.*?\]/g, '')
      .split(/[.!?]\s+/)
      .filter(s => s.trim().length > 20)
      .slice(0, 8);

    if (sentences.length === 0) {
      return [
        { text: `Let's talk about ${topic}.`, searchTerms: searchTerms.slice(0, 3) },
        { text: `This is something everyone should know.`, searchTerms: searchTerms.slice(0, 3) },
        { text: `Drop a comment if you agree!`, searchTerms: ['motivation'] },
      ];
    }

    return sentences.map((sentence) => ({
      text: sentence.trim(),
      searchTerms: searchTerms.slice(0, 3),
    }));
  }

  private extractSearchTermsFromText(text: string, topicKeywords: string[]): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
      'may', 'might', 'shall', 'can', 'need', 'dare', 'ought', 'used',
      'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they',
      'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their',
      'mine', 'yours', 'hers', 'ours', 'theirs',
      'in', 'on', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into',
      'through', 'during', 'before', 'after', 'above', 'below', 'from', 'up', 'down',
      'to', 'of', 'off', 'out', 'over', 'under', 'again', 'further', 'then', 'once',
      'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'because', 'if', 'when', 'where',
      'how', 'why', 'as', 'until', 'while', 'both', 'each', 'every', 'few', 'more',
      'most', 'other', 'some', 'such', 'no', 'only', 'own', 'same', 'just', 'like',
      'here', 'there', 'than', 'too', 'very', 'really', 'actually', 'literally',
      'just', 'even', 'still', 'already', 'get', 'got', 'getting', 'make', 'made',
      'making', 'take', 'took', 'taken', 'go', 'went', 'gone', 'going', 'come',
      'came', 'coming', 'know', 'knew', 'known', 'think', 'thought', 'want',
      'wanted', 'see', 'saw', 'seen', 'say', 'said', 'tell', 'told', 'ask', 'asked',
      'try', 'tried', 'need', 'needed', 'help', 'helped', 'working', 'work', 'works',
    ]);

    // Extract content words from text (lowercase, filter stop words, filter short words)
    const textWords = text
      .toLowerCase()
      .replace(/[^a-zA-Z\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w));

    // Remove duplicates while preserving order
    const uniqueTextWords: string[] = [];
    for (const w of textWords) {
      if (!uniqueTextWords.includes(w)) uniqueTextWords.push(w);
    }

    const results: string[] = [];

    // 1. Add topic keywords as a combined search phrase
    if (topicKeywords.length > 0) {
      const phrase = topicKeywords.slice(0, 3).join(' ');
      if (phrase.length > 0) results.push(phrase);
    }

    // 2. Add the most distinctive text words (up to 4)
    for (const w of uniqueTextWords.slice(0, 4)) {
      results.push(w);
    }

    // 3. Remove any empty strings and ensure we have at least 3 terms
    const filtered = results.filter(w => w.length > 0);
    const fallbacks = ['footage', 'scene', 'background', 'visual', 'stock video'];
    while (filtered.length < 3) {
      filtered.push(fallbacks[filtered.length - 1]);
    }

    // Remove duplicates and slice to 5
    const unique = [...new Set(filtered)].slice(0, 5);
    return unique;
  }

  private generateFallbackScript(topic: string, tone?: string): string {
    const tones = tone || 'educational';
    return `In this video, we explore ${topic} from a ${tones} perspective. 
    
First, let's understand the fundamentals. ${topic} is a fascinating subject that has gained significant attention in recent years. The key concepts revolve around understanding how different components work together.

Let me walk you through the most important aspects. When you break it down, there are three main areas to focus on:

1. The core principles that define ${topic}
2. Real-world applications and use cases
3. Best practices for implementation

What makes ${topic} particularly interesting is how it continues to evolve. New developments emerge regularly, and staying up to date is crucial.

In practice, you'll find that mastering ${topic} opens up numerous opportunities. Whether you're a beginner or an experienced professional, there's always something new to learn.

To summarize what we've covered: understanding ${topic} requires patience, practice, and a willingness to explore. Start with the basics, build your knowledge gradually, and don't be afraid to experiment.

Thanks for watching! If you found this helpful, please like and subscribe for more content. Let me know in the comments what you'd like to learn about next.`;
  }

  /**
   * Generate a fallback thumbnail image (server-side).
   */
  private generateFallbackThumbnail(topic: string, workflowId: string): string {
    const { createCanvas } = require('canvas') || {};
    const thumbDir = getOutputDir('assets/thumbnails');
    const filename = this.ctx.generateFilename(topic, 'fallback', workflowId, '.png');
    const filePath = path.join(thumbDir, filename);

    try {
      // Try using canvas if available
      const canvas = createCanvas?.(1280, 720);
      if (canvas) {
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createLinearGradient(0, 0, 0, 720);
        gradient.addColorStop(0, '#1a1a2e');
        gradient.addColorStop(1, '#16213e');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 1280, 720);

        ctx.fillStyle = '#e94560';
        ctx.fillRect(0, 300, 1280, 6);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 48px Arial';
        ctx.textAlign = 'center';
        
        const words = topic.split(' ');
        const lines: string[] = [];
        let currentLine = '';
        for (const word of words) {
          if ((currentLine + ' ' + word).length > 25) {
            lines.push(currentLine);
            currentLine = word;
          } else {
            currentLine += (currentLine ? ' ' : '') + word;
          }
        }
        if (currentLine) lines.push(currentLine);

        const startY = 360 - ((lines.length - 1) * 30);
        lines.forEach((line, i) => {
          ctx.fillText(line, 640, startY + i * 60);
        });

        ctx.fillStyle = '#e94560';
        ctx.font = 'bold 28px Arial';
        ctx.fillText('▶ WATCH NOW', 640, 620);

        const buffer = canvas.toBuffer('image/png');
        require('fs').writeFileSync(filePath, buffer);
      }
    } catch {
      // Canvas not available - skip server-side thumbnail
    }

    return filePath;
  }
}
