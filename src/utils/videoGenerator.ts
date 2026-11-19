/**
 * Photo-to-Video Synthesis Engine for SAHIN AI.
 * Transforms still photos into high-definition cinematic motion videos
 * with dynamic camera zoom, parallax pan, atmospheric particles,
 * and baked-in SAHIN AI official logo watermarks.
 */

export interface VideoGenOptions {
  durationSeconds?: number;
  fps?: number;
  motionPreset?: "cinematic_zoom" | "pan_orbit" | "pulse_drift";
  onProgress?: (percent: number) => void;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Do not set crossOrigin for data: or blob: URIs
    if (!src.startsWith("data:") && !src.startsWith("blob:")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = () => {
      // Fallback attempt without crossOrigin
      const fallbackImg = new Image();
      fallbackImg.onload = () => resolve(fallbackImg);
      fallbackImg.onerror = (e) => reject(new Error(`Failed to load image for video rendering: ${e}`));
      fallbackImg.src = src;
    };
    img.src = src;
  });
}

export function getSupportedVideoMimeType(): string {
  const types = [
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const t of types) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) {
      return t;
    }
  }
  return "video/webm";
}

/**
 * Creates an animated video from an image using Canvas captureStream & MediaRecorder.
 */
export async function generateVideoFromPhoto(
  imageUrl: string,
  options: VideoGenOptions = {}
): Promise<{ videoUrl: string; duration: number; mimeType: string }> {
  const {
    durationSeconds = 10,
    fps = 30,
    motionPreset = "cinematic_zoom",
    onProgress,
  } = options;

  const [baseImg, logoImg] = await Promise.all([
    loadImage(imageUrl),
    loadImage("/logo.png").catch(() => null),
  ]);

  // Output video dimensions (2K / 1080p Ultra-HD standard)
  const width = 1920;
  const height = 1080;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    throw new Error("Canvas 2D context is not available.");
  }

  // Pre-render radial vignette onto an offscreen canvas once for ultra-fast frame compositing
  const vignetteCanvas = document.createElement("canvas");
  vignetteCanvas.width = width;
  vignetteCanvas.height = height;
  const vCtx = vignetteCanvas.getContext("2d");
  if (vCtx) {
    const vignette = vCtx.createRadialGradient(
      width / 2,
      height / 2,
      width * 0.25,
      width / 2,
      height / 2,
      width * 0.75
    );
    vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
    vignette.addColorStop(1, "rgba(0, 0, 0, 0.42)");
    vCtx.fillStyle = vignette;
    vCtx.fillRect(0, 0, width, height);
  }

  // Pre-generate ambient drifting particles
  const particleCount = 32;
  const particles = Array.from({ length: particleCount }).map(() => ({
    x: Math.random() * width,
    y: Math.random() * height,
    radius: Math.random() * 3.2 + 1.2,
    speedX: (Math.random() - 0.4) * 1.1,
    speedY: -Math.random() * 1.2 - 0.35,
    alpha: Math.random() * 0.45 + 0.2,
  }));

  if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") {
    throw new Error("Video recording is not supported in this browser.");
  }

  const stream = canvas.captureStream(fps);
  let mimeType = getSupportedVideoMimeType();

  const recordedChunks: Blob[] = [];
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 5000000,
    });
  } catch {
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch {
      mimeType = "video/webm";
      recorder = new MediaRecorder(stream);
    }
  }

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      recordedChunks.push(e.data);
    }
  };

  const totalDurationMs = durationSeconds * 1000;

  const drawFrameAtProgress = (tRaw: number) => {
    const t = Math.max(0, Math.min(1, tRaw));
    const ease = -(Math.cos(Math.PI * t) - 1) / 2;

    ctx.fillStyle = "#090d16";
    ctx.fillRect(0, 0, width, height);

    let zoom = 1.0;
    let panX = 0;
    let panY = 0;

    if (motionPreset === "cinematic_zoom") {
      zoom = 1.0 + ease * 0.14;
      panY = ease * 14;
    } else if (motionPreset === "pan_orbit") {
      zoom = 1.06 + Math.sin(t * Math.PI) * 0.08;
      panX = (ease - 0.5) * 36;
      panY = Math.sin(t * Math.PI) * 16;
    } else {
      zoom = 1.02 + Math.sin(t * Math.PI * 2) * 0.06;
      panX = Math.cos(t * Math.PI) * 18;
    }

    const imgAspect = (baseImg.naturalWidth || 1) / (baseImg.naturalHeight || 1);
    const canvasAspect = width / height;

    let drawW = width * zoom;
    let drawH = height * zoom;

    if (imgAspect > canvasAspect) {
      drawW = height * imgAspect * zoom;
    } else {
      drawH = (width / imgAspect) * zoom;
    }

    const offsetX = (width - drawW) / 2 + panX;
    const offsetY = (height - drawH) / 2 + panY;

    ctx.drawImage(baseImg, offsetX, offsetY, drawW, drawH);

    // Composite cached vignette in a single GPU blit
    if (vCtx) {
      ctx.drawImage(vignetteCanvas, 0, 0);
    }

    // Atmospheric dust / light particles
    for (const p of particles) {
      p.x += p.speedX;
      p.y += p.speedY;
      if (p.y < 0) p.y = height + 10;
      if (p.x < 0) p.x = width + 10;
      if (p.x > width + 10) p.x = -10;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha * (0.8 + 0.2 * Math.sin(t * 10))})`;
      ctx.fill();
    }

    // --- SAHIN AI WATERMARK & BRAND BADGE OVERLAY ---
    const badgeW = 230;
    const badgeH = 54;
    const badgeX = width - badgeW - 36;
    const badgeY = height - badgeH - 36;
    const radius = 14;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.65)";
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;

    ctx.beginPath();
    ctx.moveTo(badgeX + radius, badgeY);
    ctx.lineTo(badgeX + badgeW - radius, badgeY);
    ctx.arcTo(badgeX + badgeW, badgeY, badgeX + badgeW, badgeY + badgeH, radius);
    ctx.lineTo(badgeX + badgeW, badgeY + badgeH - radius);
    ctx.arcTo(badgeX + badgeW, badgeY + badgeH, badgeX, badgeY + badgeH, radius);
    ctx.lineTo(badgeX + radius, badgeY + badgeH);
    ctx.arcTo(badgeX, badgeY + badgeH, badgeX, badgeY, radius);
    ctx.lineTo(badgeX, badgeY + radius);
    ctx.arcTo(badgeX, badgeY, badgeX + badgeW, badgeY, radius);
    ctx.closePath();

    ctx.fillStyle = "rgba(10, 15, 29, 0.90)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    if (logoImg) {
      ctx.drawImage(logoImg, badgeX + 12, badgeY + 9, 36, 36);
    }

    ctx.fillStyle = "#FFFFFF";
    ctx.font = "bold 18px system-ui, sans-serif";
    ctx.fillText("SAHIN AI", badgeX + 56, badgeY + 26);

    ctx.fillStyle = "#2dd4bf";
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.fillText("4K ULTRA HD · VIDEO", badgeX + 56, badgeY + 42);
  };

  drawFrameAtProgress(0);

  return new Promise<{ videoUrl: string; duration: number; mimeType: string }>(
    (resolve, reject) => {
      let isCompleted = false;
      let timerId: number | null = null;

      recorder.onstop = () => {
        if (isCompleted) return;
        isCompleted = true;
        if (timerId !== null) clearTimeout(timerId);
        if (recordedChunks.length === 0) {
          reject(new Error("Video encoding produced an empty stream."));
          return;
        }
        try {
          const blob = new Blob(recordedChunks, { type: mimeType });
          const videoUrl = URL.createObjectURL(blob);
          resolve({ videoUrl, duration: durationSeconds, mimeType });
        } catch (err) {
          reject(err);
        }
      };

      recorder.onerror = (e) => {
        if (isCompleted) return;
        isCompleted = true;
        if (timerId !== null) clearTimeout(timerId);
        reject(new Error(`MediaRecorder error: ${e}`));
      };

      try {
        recorder.start(200);
      } catch (startErr) {
        reject(startErr);
        return;
      }

      const startTime = performance.now();
      const frameIntervalMs = 1000 / fps;
      let lastProgress = -1;

      const tick = () => {
        if (isCompleted) return;
        const elapsed = performance.now() - startTime;
        const progress = Math.min(1, elapsed / totalDurationMs);

        drawFrameAtProgress(progress);

        const pct = Math.min(99, Math.round(progress * 100));
        if (onProgress && pct !== lastProgress) {
          lastProgress = pct;
          onProgress(pct);
        }

        if (elapsed >= totalDurationMs) {
          try {
            if (recorder.state === "recording") {
              recorder.requestData?.();
              recorder.stop();
            }
          } catch {
            // Already stopped
          }
          return;
        }

        timerId = window.setTimeout(tick, frameIntervalMs);
      };

      timerId = window.setTimeout(tick, frameIntervalMs);
    }
  );
}
