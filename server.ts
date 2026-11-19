import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { Content, GenerateContentResponse, Part } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ClientAttachment {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
}

interface ClientMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: ClientAttachment[];
}

interface WebSource {
  title: string;
  uri: string;
  domain: string;
}

function getGenAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (!apiKey) {
    throw new Error(
      "API key is not configured. Please verify your API key in the Settings > Secrets panel."
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function extractBase64Payload(dataUrl: string): { mimeType: string; data: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1],
    data: match[2],
  };
}

function buildContents(messages: ClientMessage[]): Content[] {
  const contents: Content[] = [];

  for (const msg of messages) {
    const parts: Part[] = [];

    if (msg.attachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        const parsed = extractBase64Payload(att.dataUrl);
        if (parsed) {
          parts.push({
            inlineData: {
              mimeType: parsed.mimeType,
              data: parsed.data,
            },
          });
        }
      }
    }

    const trimmedText = (msg.content || "").trim();
    if (trimmedText) {
      parts.push({ text: trimmedText });
    } else if (parts.length > 0 && msg.role === "user") {
      parts.push({ text: "Please analyze this image in detail." });
    }

    if (parts.length > 0) {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts,
      });
    }
  }

  return contents;
}

function extractDomain(uri: string): string {
  try {
    const parsed = new URL(uri);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "web";
  }
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2, baseDelayMs = 600): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        msg.includes("503") ||
        msg.includes("UNAVAILABLE") ||
        msg.includes("ECONNRESET") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("fetch failed");
      if (!isTransient || attempt === maxRetries) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

function isMathOrComplexQuery(messages: ClientMessage[]): boolean {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return false;
  const text = (lastUser.content || "").toLowerCase();
  if (!text) return Boolean(lastUser.attachments?.length);
  return (
    /\b(math|calculus|algebra|geometry|trigonometry|equation|integral|derivative|matrix|probability|statistics|physics|chemistry|theorem|proof|solve|calculate|simplify|factor|limit|differential|logarithm|polynomial|quadratic)\b/i.test(
      text
    ) ||
    /(গণিত|অঙ্ক|অংক|সমাধান|সমীকরণ|মান নির্ণয়|মান বের|প্রমাণ করো|সূত্র|জ্যামিতি|ত্রিকোণমিতি|বীজগণিত|ক্যালকুলাস|শতকরা|সুদ|অনুপাত|গুণ|ভাগ|যোগ|বিয়োগ|বর্গমূল)/i.test(
      text
    ) ||
    /(onk|onko|gonit|somikoron|soman|math solve|hisab)/i.test(text) ||
    /[=^√∫∑π±×÷]|\d+\s*[*+\-/^]\s*\d+/.test(text)
  );
}

const SYSTEM_INSTRUCTION = `You are SAHIN AI, an intelligent, articulate, and versatile conversational AI assistant.

Core behavior guidelines:
- Identity: Your name is SAHIN AI. Never claim to be any other assistant, model family, or platform.
- Speed & Responsiveness: Answer immediately, directly, and concisely without filler greetings or delay. Begin delivering the primary answer in the very first sentence.
- Tone & Clarity: Write clearly, accurately, and thoughtfully. Structure complex answers with clean Markdown headings, concise bullet points, tables when comparing options, and fenced code blocks with language identifiers (e.g., \`\`\`typescript, \`\`\`python, \`\`\`bash).
- Mathematics & STEM Excellence:
  - For any math, physics, chemistry, or quantitative problem, always solve **step-by-step** showing every intermediate calculation clearly.
  - Carefully verify signs, fractions, substitutions, units, and arithmetic before writing the final result.
  - Always format inline math with single dollar signs ($x^2 + y^2 = r^2$) and standalone equations with double dollar signs ($$\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$). Never leave raw unformatted LaTeX commands outside math delimiters.
  - Conclude with a clearly highlighted **Final Answer** (or **চূড়ান্ত উত্তর** when answering in Bengali).
- Multilingual Fluency: Respond naturally in the language or script the user uses (including English, Bengali / বাংলা, Banglish, Hindi, or any other language).
- Vision & Image Analysis: When the user provides one or more images (including handwritten math problems or diagrams), inspect every detail, OCR text/equations carefully, and provide structured, accurate solutions.
- Web Search & Real-Time Grounding: When web search is enabled, synthesize up-to-date facts accurately and cite context naturally.`;

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "35mb" }));

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", app: "SAHIN AI" });
  });

  app.post("/api/chat/stream", async (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const sendEvent = (payload: Record<string, unknown>) => {
      if (!res.destroyed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    };

    try {
      const { messages, webSearchEnabled } = req.body as {
        messages?: ClientMessage[];
        webSearchEnabled?: boolean;
      };

      if (!Array.isArray(messages) || messages.length === 0) {
        sendEvent({ type: "error", error: "Please enter a message or attach an image to start." });
        res.end();
        return;
      }

      const contents = buildContents(messages);
      if (contents.length === 0) {
        sendEvent({ type: "error", error: "Message content cannot be empty." });
        res.end();
        return;
      }

      const ai = getGenAIClient();
      const isComplex = isMathOrComplexQuery(messages);

      // Select model candidates: complex math uses Gemini 4 Hydrogen with HIGH thinking level -> Flash Lite fallback
      const modelCandidates = isComplex
        ? [
            { model: "gemini-4-hydrogen", thinkingLevel: ThinkingLevel.HIGH },
            { model: "gemini-3.1-flash-lite", thinkingLevel: undefined },
          ]
        : [
            { model: "gemini-4-hydrogen", thinkingLevel: undefined },
            { model: "gemini-3.1-flash-lite", thinkingLevel: undefined },
          ];

      let streamResponse: any = null;
      let usedSearch = Boolean(webSearchEnabled);
      let lastStreamErr: unknown = null;

      for (const candidate of modelCandidates) {
        const baseConfig: Record<string, unknown> = {
          systemInstruction: SYSTEM_INSTRUCTION,
        };
        if (candidate.thinkingLevel) {
          baseConfig.thinkingConfig = { thinkingLevel: candidate.thinkingLevel };
        }

        try {
          if (usedSearch) {
            try {
              streamResponse = await withRetry(() =>
                ai.models.generateContentStream({
                  model: candidate.model,
                  contents,
                  config: {
                    ...baseConfig,
                    tools: [{ googleSearch: {} }],
                  },
                })
              );
              break;
            } catch (searchErr: unknown) {
              const sMsg = searchErr instanceof Error ? searchErr.message : "";
              if (sMsg.includes("429") || sMsg.includes("RESOURCE_EXHAUSTED") || sMsg.includes("quota")) {
                usedSearch = false;
                streamResponse = await withRetry(() =>
                  ai.models.generateContentStream({
                    model: candidate.model,
                    contents,
                    config: baseConfig,
                  })
                );
                break;
              }
              throw searchErr;
            }
          } else {
            streamResponse = await withRetry(() =>
              ai.models.generateContentStream({
                model: candidate.model,
                contents,
                config: baseConfig,
              })
            );
            break;
          }
        } catch (err: unknown) {
          lastStreamErr = err;
          const errMsg = err instanceof Error ? err.message : String(err);
          const canFallback =
            errMsg.includes("429") ||
            errMsg.includes("RESOURCE_EXHAUSTED") ||
            errMsg.includes("403") ||
            errMsg.includes("PERMISSION_DENIED") ||
            errMsg.includes("404") ||
            errMsg.includes("NOT_FOUND") ||
            errMsg.includes("503") ||
            errMsg.includes("UNAVAILABLE");
          if (!canFallback) {
            throw err;
          }
          console.warn(`Model ${candidate.model} unavailable, trying next fallback:`, errMsg);
        }
      }

      if (!streamResponse) {
        throw lastStreamErr || new Error("Unable to reach AI chat model.");
      }

      const collectedSources = new Map<string, WebSource>();
      const collectedQueries = new Set<string>();

      for await (const rawChunk of streamResponse) {
        if (res.destroyed || res.writableEnded) {
          break;
        }

        const chunk = rawChunk as GenerateContentResponse;
        const deltaText = chunk.text;
        if (deltaText) {
          sendEvent({ type: "text", delta: deltaText });
        }

        const groundingMeta = chunk.candidates?.[0]?.groundingMetadata;
        if (groundingMeta && usedSearch) {
          if (Array.isArray(groundingMeta.webSearchQueries)) {
            for (const q of groundingMeta.webSearchQueries) {
              if (typeof q === "string" && q.trim()) {
                collectedQueries.add(q.trim());
              }
            }
          }

          if (Array.isArray(groundingMeta.groundingChunks)) {
            for (const gChunk of groundingMeta.groundingChunks) {
              const web = gChunk.web;
              if (web?.uri) {
                collectedSources.set(web.uri, {
                  uri: web.uri,
                  title: web.title?.trim() || extractDomain(web.uri),
                  domain: extractDomain(web.uri),
                });
              }
            }
          }
        }
      }

      if (!res.destroyed && !res.writableEnded) {
        if (collectedSources.size > 0 || collectedQueries.size > 0) {
          sendEvent({
            type: "sources",
            sources: Array.from(collectedSources.values()),
            queries: Array.from(collectedQueries),
          });
        }
        sendEvent({ type: "done" });
        res.end();
      }
    } catch (err: unknown) {
      console.error("Stream generation error:", err);
      const rawMessage = err instanceof Error ? err.message : "Unexpected server error.";
      let friendlyMessage = rawMessage;

      if (
        rawMessage.includes("API_KEY_INVALID") ||
        rawMessage.includes("PERMISSION_DENIED") ||
        rawMessage.includes("403")
      ) {
        friendlyMessage =
          "Unable to authenticate with the AI service. Please check your API key in the Settings > Secrets panel.";
      } else if (rawMessage.includes("RESOURCE_EXHAUSTED") || rawMessage.includes("429")) {
        friendlyMessage =
          "Rate limit or quota reached. Please wait a moment and try again, or upgrade your API key quota in Settings > Secrets.";
      }

      sendEvent({ type: "error", error: friendlyMessage });
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  app.post("/api/generate-image", async (req: Request, res: Response) => {
    try {
      const { prompt, aspectRatio, referenceImageBase64, mimeType } = req.body as {
        prompt?: string;
        aspectRatio?: string;
        referenceImageBase64?: string;
        mimeType?: string;
      };

      const rawPrompt = (prompt || "").trim();
      if (!rawPrompt) {
        res.status(400).json({
          success: false,
          error: "Please provide a prompt describing the image you want to create.",
        });
        return;
      }

      const allowedRatios = ["1:1", "16:9", "9:16", "4:3", "3:4"];
      const validRatio = allowedRatios.includes(aspectRatio || "") ? aspectRatio! : "1:1";

      const ai = getGenAIClient();

      // Prompt Enrichment (and visual inspection if reference image attached) via Gemini 4 Hydrogen
      let enrichedPrompt = rawPrompt;
      try {
        const promptParts: Part[] = [];
        if (referenceImageBase64) {
          const parsed = extractBase64Payload(referenceImageBase64);
          if (parsed) {
            promptParts.push({
              inlineData: {
                data: parsed.data,
                mimeType: mimeType || parsed.mimeType || "image/png",
              },
            });
            promptParts.push({
              text: `Describe the attached image's subject, style, colors, and composition combined with this user edit/generation instruction: "${rawPrompt}". Return ONLY a single vivid English image-generation prompt paragraph without quotes.`,
            });
          }
        }

        const enrichResponse = await withRetry(() =>
          ai.models.generateContent({
            model: "gemini-4-hydrogen",
            contents:
              promptParts.length > 0
                ? { parts: promptParts }
                : `You are an expert AI image prompt designer. Translate this description to vivid English if needed and expand it into a crisp, photorealistic, high-detail 4K image generation prompt: "${rawPrompt}". Return ONLY the enhanced English prompt paragraph without quotes.`,
          })
        );
        const generated = enrichResponse.text?.trim();
        if (generated && generated.length > 5) {
          enrichedPrompt = generated.replace(/^["'`]+|["'`]+$/g, "");
        }
      } catch {
        // Fallback to raw prompt if enrichment call is briefly unavailable
      }

      const sizePresets: Record<string, Array<{ w: number; h: number }>> = {
        "16:9": [
          { w: 3840, h: 2160 },
          { w: 1920, h: 1080 },
        ],
        "9:16": [
          { w: 2160, h: 3840 },
          { w: 1080, h: 1920 },
        ],
        "4:3": [
          { w: 2560, h: 1920 },
          { w: 1600, h: 1200 },
        ],
        "3:4": [
          { w: 1920, h: 2560 },
          { w: 1200, h: 1600 },
        ],
        "1:1": [
          { w: 2560, h: 2560 },
          { w: 1536, h: 1536 },
        ],
      };

      const candidates = sizePresets[validRatio] || sizePresets["1:1"];
      const seed = Math.floor(Math.random() * 1000000);
      const promptWithQuality = `${enrichedPrompt}, ultra detailed 4k photography, natural lighting, sharp focus, rich color depth`;
      const encoded = encodeURIComponent(promptWithQuality.slice(0, 480));

      for (const dims of candidates) {
        try {
          const pollUrl = `https://image.pollinations.ai/prompt/${encoded}?model=flux&width=${dims.w}&height=${dims.h}&seed=${seed}&nologo=true&enhance=true`;
          const fetchRes = await fetch(pollUrl, { signal: AbortSignal.timeout(26000) });
          if (!fetchRes.ok) continue;

          const contentType = fetchRes.headers.get("content-type") || "image/jpeg";
          if (!contentType.startsWith("image/")) continue;

          const arrayBuffer = await fetchRes.arrayBuffer();
          if (arrayBuffer.byteLength < 1024) continue;

          const base64 = Buffer.from(arrayBuffer).toString("base64");
          res.json({
            success: true,
            imageUrl: `data:${contentType};base64,${base64}`,
            prompt: rawPrompt,
            enhancedPrompt: enrichedPrompt,
            model: "SAHIN-AI-4K-Flux",
            resolution: dims.w >= 2560 ? "4K" : `${dims.w}x${dims.h}`,
          });
          return;
        } catch {
          // Try smaller candidate dimensions on timeout
        }
      }

      throw new Error("Image synthesis service is temporarily busy. Please try again.");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to synthesize image.";
      console.warn("Image generation notice:", msg);
      res.status(500).json({
        success: false,
        error: `Could not generate image: ${msg}`,
      });
    }
  });

  app.post("/api/generate-video", async (req: Request, res: Response) => {
    try {
      const { imageBase64, motionPrompt } = req.body as {
        imageBase64?: string;
        mimeType?: string;
        motionPrompt?: string;
        aspectRatio?: string;
      };

      const promptText =
        (motionPrompt || "").trim() ||
        "Cinematic camera motion, natural lighting, fluid atmospheric movement.";

      if (!imageBase64 && !motionPrompt) {
        res.status(400).json({
          success: false,
          error: "Either a prompt or a source image is required to generate video.",
        });
        return;
      }

      // Route directly to SAHIN AI client-side Motion Studio rendering engine
      res.json({
        success: false,
        fallbackToClientEngine: true,
        motionPrompt: promptText,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Video route error";
      res.status(500).json({ success: false, fallbackToClientEngine: true, error: msg });
    }
  });

  app.post("/api/generate-speech", async (req: Request, res: Response) => {
    try {
      const { text, voice } = req.body as {
        text?: string;
        voice?: string;
      };

      const rawText = (text || "").trim();
      if (!rawText) {
        res.status(400).json({ success: false, error: "Text is required to generate speech." });
        return;
      }

      // Clean markdown & LaTeX equations for natural spoken audio
      const cleaned = rawText
        .replace(/```[\s\S]*?```/g, "Code block omitted.")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "$1 divided by $2")
        .replace(/\\sqrt\{([^}]+)\}/g, "square root of $1")
        .replace(/\$\$([\s\S]*?)\$\$/g, " $1 ")
        .replace(/\$([^$\n]+)\$/g, " $1 ")
        .replace(/\\[a-zA-Z]+/g, " ")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/[*_#~>{}]/g, " ")
        .replace(
          /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
          ""
        )
        .replace(/\s+/g, " ")
        .trim();

      const textToSpeak = cleaned.slice(0, 2200);
      const isBengali = /[\u0980-\u09FF]/.test(textToSpeak);

      // Attempt Gemini 3.8 Flash Lite TTS with retry
      try {
        const ai = getGenAIClient();
        const ttsResponse = await withRetry(() =>
          ai.models.generateContent({
            model: "gemini-3.8-flash-lite-tts",
            contents: [
              {
                role: "user",
                parts: [
                  {
                    text: textToSpeak,
                    speechMetadata: {
                      style: isBengali
                        ? "Natural, clear, articulate Bengali speaker with warm, friendly tone"
                        : "Warm, clear, and friendly voice assistant",
                    },
                  },
                ],
              },
            ],
            config: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: voice || "Kore" },
                },
              },
            },
          })
        );

        const audioPart = ttsResponse.candidates?.[0]?.content?.parts?.find(
          (p) => p.inlineData?.data
        );
        const base64Audio = audioPart?.inlineData?.data;
        const mimeType = audioPart?.inlineData?.mimeType || "audio/wav";
        if (base64Audio) {
          const audioUrl = `data:${mimeType};base64,${base64Audio}`;
          res.json({
            success: true,
            audioUrl,
            format: mimeType,
            model: "gemini-3.8-flash-lite-tts",
            cleanText: textToSpeak,
          });
          return;
        }
      } catch (geminiErr: unknown) {
        const notice = geminiErr instanceof Error ? geminiErr.message : "";
        console.info("Gemini TTS service notice, falling back to browser voice:", notice);
      }

      // Fallback: Signal client to use Web Speech API with cleanText
      res.json({
        success: false,
        fallbackToBrowserTts: true,
        cleanText: textToSpeak,
        isBengali,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Speech route error";
      res.status(500).json({ success: false, fallbackToBrowserTts: true, error: msg });
    }
  });

  app.post("/api/chat/title", async (req: Request, res: Response) => {
    try {
      const { userMessage } = req.body as {
        userMessage?: string;
        assistantMessage?: string;
      };

      const seedText = (userMessage || "").trim();
      if (!seedText) {
        res.json({ title: "Visual Analysis" });
        return;
      }

      const ai = getGenAIClient();
      const response = await ai.models.generateContent({
        model: "gemini-4-hydrogen",
        contents: `Generate a concise 3 to 5 word title for this chat: "${seedText.slice(0, 150)}". Return ONLY the plain title without quotes.`,
      });

      const cleaned = (response.text || "")
        .replace(/^["'`]+|["'`]+$/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);

      res.json({ title: cleaned || seedText.slice(0, 42) });
    } catch {
      const fallback = String(req.body?.userMessage || "New Conversation")
        .trim()
        .slice(0, 42);
      res.json({ title: fallback || "New Conversation" });
    }
  });


  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`SAHIN AI server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
