/**
 * Speech & Voice Synthesis Utility for SAHIN AI.
 * Dual-engine architecture:
 * 1. Server-side Gemini 3.8 Flash Lite TTS (crystal-clear studio audio/wav)
 * 2. Client-side Web Speech API fallback (zero-latency native Bengali & English speech)
 */

let sharedAudioEl: HTMLAudioElement | null = null;
let currentUtterance: SpeechSynthesisUtterance | null = null;
let activeSpeakerId: string | null = null;
let loadingSpeakerId: string | null = null;
const audioCache = new Map<string, string>();
const activeListeners = new Set<
  (state: { speakerId: string | null; loadingId: string | null }) => void
>();

export function subscribeSpeechState(
  listener: (state: { speakerId: string | null; loadingId: string | null }) => void
) {
  activeListeners.add(listener);
  listener({ speakerId: activeSpeakerId, loadingId: loadingSpeakerId });
  return () => {
    activeListeners.delete(listener);
  };
}

function notifyState(speakerId: string | null, loadingId: string | null = null) {
  activeSpeakerId = speakerId;
  loadingSpeakerId = loadingId;
  for (const listener of activeListeners) {
    listener({ speakerId, loadingId });
  }
}

export function getCachedAudioUrl(speakerId: string): string | undefined {
  return audioCache.get(speakerId);
}

export function cleanTextForSpeech(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/```[\s\S]*?```/g, "Code block omitted.")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, "$1 divided by $2")
    .replace(/\\sqrt\{([^}]+)\}/g, "square root of $1")
    .replace(/\$\$([\s\S]*?)\$\$/g, " $1 ")
    .replace(/\$([^$\n]+)\$/g, " $1 ")
    .replace(/\\(?:times|cdot)/g, " times ")
    .replace(/\\div/g, " divided by ")
    .replace(/\\pm/g, " plus or minus ")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#~>•{}]/g, " ")
    .replace(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

export function stopAllSpeech(): void {
  if (sharedAudioEl) {
    try {
      sharedAudioEl.pause();
      sharedAudioEl.currentTime = 0;
    } catch {
      // Ignore
    }
  }

  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Ignore
    }
    currentUtterance = null;
  }

  notifyState(null, null);
}

export function isSpeakingMessage(id: string): boolean {
  return activeSpeakerId === id;
}

function getOrCreateSharedAudio(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (!sharedAudioEl) {
    sharedAudioEl = new Audio();
    sharedAudioEl.preload = "auto";
  }
  return sharedAudioEl;
}

export async function speakAssistantText(
  speakerId: string,
  text: string,
  options: {
    onStart?: () => void;
    onEnd?: () => void;
    onAudioReady?: (audioUrl: string) => void;
    onAutoplayBlocked?: (audioUrl: string) => void;
    onError?: (err: unknown) => void;
  } = {}
): Promise<void> {
  // If this message is already speaking or loading, stop it (toggle off)
  if (activeSpeakerId === speakerId || loadingSpeakerId === speakerId) {
    stopAllSpeech();
    options.onEnd?.();
    return;
  }

  stopAllSpeech();

  const cleaned = cleanTextForSpeech(text);
  if (!cleaned) {
    options.onEnd?.();
    return;
  }

  // Acquire audio element immediately on user gesture
  const audio = getOrCreateSharedAudio();
  notifyState(null, speakerId);
  options.onStart?.();

  let audioUrl = audioCache.get(speakerId);

  // 1. Fetch Gemini 3.8 Flash Lite TTS if not cached
  if (!audioUrl) {
    try {
      const res = await fetch("/api/generate-speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: cleaned.slice(0, 2200) }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success && data.audioUrl) {
          audioUrl = data.audioUrl as string;
          audioCache.set(speakerId, audioUrl);
        }
      }
    } catch (err) {
      console.warn("Server TTS notice, falling back to browser speech engine:", err);
    }
  }

  // If user stopped while fetching, abort playback cleanly
  if (loadingSpeakerId !== speakerId) {
    return;
  }

  if (audioUrl && audio) {
    options.onAudioReady?.(audioUrl);
    try {
      audio.onended = null;
      audio.onerror = null;
      audio.src = audioUrl;
      audio.currentTime = 0;

      audio.onended = () => {
        if (activeSpeakerId === speakerId) {
          stopAllSpeech();
          options.onEnd?.();
        }
      };

      audio.onerror = () => {
        fallbackToBrowserSpeech(speakerId, cleaned, options);
      };

      notifyState(speakerId, null);
      await audio.play();
      return;
    } catch (playErr: unknown) {
      const errName = playErr instanceof DOMException ? playErr.name : "";
      if (errName === "NotAllowedError") {
        // Browser blocked async autoplay — expose inline audio bar so user can play in 1 tap
        notifyState(null, null);
        options.onAutoplayBlocked?.(audioUrl);
        options.onEnd?.();
        return;
      }
      console.warn("Audio element playback notice, trying browser fallback:", playErr);
    }
  }

  // 2. Client-side Web Speech fallback (guarantees voice output when TTS audio is unavailable)
  fallbackToBrowserSpeech(speakerId, cleaned, options);
}

function fallbackToBrowserSpeech(
  speakerId: string,
  text: string,
  options: {
    onStart?: () => void;
    onEnd?: () => void;
    onError?: (err: unknown) => void;
  }
) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    notifyState(null, null);
    options.onEnd?.();
    return;
  }

  try {
    window.speechSynthesis.cancel();
    const isBengali = /[\u0980-\u09FF]/.test(text);

    const utterance = new SpeechSynthesisUtterance(text.slice(0, 2200));
    utterance.rate = isBengali ? 0.95 : 1.0;
    utterance.pitch = 1.0;
    utterance.lang = isBengali ? "bn-BD" : "en-US";

    const voices = window.speechSynthesis.getVoices();
    if (voices && voices.length > 0) {
      if (isBengali) {
        const bnVoice = voices.find(
          (v) =>
            v.lang.startsWith("bn") ||
            v.lang.includes("Bengali") ||
            v.name.includes("Bangla")
        );
        if (bnVoice) utterance.voice = bnVoice;
      } else {
        const enVoice = voices.find(
          (v) =>
            v.lang.startsWith("en") &&
            (v.name.includes("Natural") || v.name.includes("Google") || v.default)
        );
        if (enVoice) utterance.voice = enVoice;
      }
    }

    utterance.onstart = () => {
      notifyState(speakerId, null);
    };

    utterance.onend = () => {
      if (activeSpeakerId === speakerId) {
        stopAllSpeech();
        options.onEnd?.();
      }
    };

    utterance.onerror = (e) => {
      console.warn("Speech synthesis notice:", e);
      stopAllSpeech();
      options.onError?.(e);
      options.onEnd?.();
    };

    currentUtterance = utterance;
    notifyState(speakerId, null);
    window.speechSynthesis.speak(utterance);
  } catch (synthErr) {
    stopAllSpeech();
    options.onError?.(synthErr);
    options.onEnd?.();
  }
}
