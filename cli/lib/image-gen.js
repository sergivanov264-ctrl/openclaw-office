/**
 * Office image generation via Gemini Imagen API.
 * Falls back to default image if no API key or generation fails.
 */

import { writeFileSync, existsSync, copyFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { buildPrompt } from './prompts.js';

const DEFAULT_IMAGE = 'public/sprites/office-default.svg';

/**
 * Generate an office image using Gemini Imagen API directly.
 */
export async function generateOfficeImage({
  agents,
  style,
  customDescription,
  apiKey,
  outputPath,
  cwd = process.cwd(),
}) {
  const outPath = outputPath || join(cwd, 'public/sprites/office.png');
  const outDir = dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const geminiKey = apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

  if (!geminiKey) {
    return useDefault(cwd, outPath, 'No API key provided');
  }

  const prompt = buildPrompt(agents, style, customDescription);

  // Try Gemini Imagen API (imagen-3.0-generate-002)
  try {
    const result = await generateWithGeminiImagen(prompt, geminiKey);
    if (result) {
      writeFileSync(outPath, result);
      return { imagePath: outPath, generated: true };
    }
  } catch (err) {
    console.error(`[image-gen] Imagen API failed: ${err.message}`);
  }

  // Fallback: Try Gemini generateContent with image output
  try {
    const result = await generateWithGeminiContent(prompt, geminiKey);
    if (result) {
      writeFileSync(outPath, result);
      return { imagePath: outPath, generated: true };
    }
  } catch (err) {
    console.error(`[image-gen] Gemini content API failed: ${err.message}`);
  }

  return useDefault(cwd, outPath, 'Image generation failed');
}

/**
 * Generate image using Gemini Imagen API
 */
async function generateWithGeminiImagen(prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: {
        sampleCount: 1,
        aspectRatio: '16:9',
        personGeneration: 'allow_all',
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Imagen API ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const b64 = data?.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) throw new Error('No image data in response');

  return Buffer.from(b64, 'base64');
}

/**
 * Fallback: Generate image using Gemini generateContent with responseModalities
 */
async function generateWithGeminiContent(prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

  if (!imagePart) throw new Error('No image in response');

  return Buffer.from(imagePart.inlineData.data, 'base64');
}

function useDefault(cwd, outPath, reason) {
  const defaultImg = join(cwd, DEFAULT_IMAGE);
  if (existsSync(defaultImg) && defaultImg !== outPath) {
    copyFileSync(defaultImg, outPath);
  }
  return { imagePath: outPath, generated: false, error: reason };
}
