// ============================================================
// Tasklyn AI — Server function that analyzes documents for real.
// Reads the file (PDF / Word / Excel / PNG / JPG / JPEG), sends it
// to the AI to summarize/categorize/find a due date, and saves the
// result to the database.
//
// Needs TWO environment variables on Vercel:
// - ANTHROPIC_API_KEY          (already set up for the chat)
// - SUPABASE_SERVICE_ROLE_KEY  (Supabase > Settings > API,
//   "service_role secret" field. NEVER put this key in the site,
//   only here, as a server environment variable.)
// ============================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://pzzxmpdwtyhsmjwtapln.supabase.co';

// Images larger than this are skipped (not sent to the AI) to avoid
// oversized requests that can crash or time out the function.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB

const IMAGE_EXTENSIONS = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

function detectKind(fileType, lowerPath) {
  const ft = fileType || '';
  if (ft.includes('pdf') || lowerPath.endsWith('.pdf')) return 'pdf';
  if (ft.includes('word') || lowerPath.endsWith('.docx') || lowerPath.endsWith('.doc')) return 'word';
  if (ft.includes('sheet') || ft.includes('excel') || lowerPath.endsWith('.xlsx') || lowerPath.endsWith('.xls')) return 'excel';
  for (const ext of Object.keys(IMAGE_EXTENSIONS)) {
    if (lowerPath.endsWith(ext)) return 'image:' + ext;
  }
  if (ft.startsWith('image/')) {
    if (ft.includes('png')) return 'image:.png';
    if (ft.includes('jpeg') || ft.includes('jpg')) return 'image:.jpg';
  }
  return 'unknown';
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout (${label})`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { documentId, filePath, fileType } = req.body || {};
  if (!documentId || !filePath) {
    return res.status(400).json({ error: 'documentId or filePath missing' });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!serviceKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY missing on the server.' });
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing on the server.' });

  const supabase = createClient(SUPABASE_URL, serviceKey);
  const lowerPath = (filePath || '').toLowerCase();
  const kind = detectKind(fileType, lowerPath);

  let summary = null;
  let category = 'Other';
  let due_date = null;
  let finalStatus = 'processed';

  try {
    // 1) Download the file from Storage via a signed URL (avoids an unrelated
    //    bug in some environments when using the SDK's .download() directly).
    const { data: signedUrlData, error: signError } = await supabase
      .storage.from('documents').createSignedUrl(filePath, 120);
    if (signError) throw new Error('Could not sign the file URL: ' + signError.message);

    const fileResponse = await withTimeout(fetch(signedUrlData.signedUrl), 20000, 'file download');
    if (!fileResponse.ok) throw new Error('Failed to download file from storage: ' + fileResponse.status);
    const buffer = Buffer.from(await fileResponse.arrayBuffer());

    // 2) Build the AI request content depending on file kind.
    let messageContent = null;

    if (kind === 'pdf') {
      try {
        const { default: pdfParse } = await import('pdf-parse');
        const parsed = await pdfParse(buffer);
        const text = (parsed.text || '').trim().slice(0, 12000);
        if (text) messageContent = `Analyze this document and respond in the requested format:\n\n${text}`;
      } catch (e) {
        summary = 'Could not read this PDF automatically: ' + e.message;
        finalStatus = 'needs_review';
      }
    } else if (kind === 'word') {
      try {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        const text = (result.value || '').trim().slice(0, 12000);
        if (text) messageContent = `Analyze this document and respond in the requested format:\n\n${text}`;
      } catch (e) {
        summary = 'Could not read this Word file automatically: ' + e.message;
        finalStatus = 'needs_review';
      }
    } else if (kind === 'excel') {
      try {
        const XLSX = await import('xlsx');
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const text = workbook.SheetNames
          .map(name => XLSX.utils.sheet_to_csv(workbook.Sheets[name]))
          .join('\n')
          .trim()
          .slice(0, 12000);
        if (text) messageContent = `Analyze this document and respond in the requested format:\n\n${text}`;
      } catch (e) {
        summary = 'Could not read this spreadsheet automatically: ' + e.message;
        finalStatus = 'needs_review';
      }
    } else if (kind.startsWith('image:')) {
      if (buffer.length > MAX_IMAGE_BYTES) {
        summary = `This image is too large to analyze automatically (${(buffer.length / (1024 * 1024)).toFixed(1)} MB, limit ${MAX_IMAGE_BYTES / (1024 * 1024)} MB). Try a smaller photo.`;
      } else {
        const ext = kind.split(':')[1];
        const mediaType = IMAGE_EXTENSIONS[ext] || 'image/jpeg';
        const base64Image = buffer.toString('base64');
        messageContent = [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
          { type: 'text', text: 'Analyze this document image and respond in the requested format.' }
        ];
      }
    } else {
      summary = 'This file format is not supported for automatic analysis yet.';
    }

    // 3) Send to the AI, if we have something to send.
    if (messageContent) {
      const systemPrompt = 'You analyze administrative business documents (contracts, spreadsheets, emails, forms, scanned paperwork). Reply with ONLY valid JSON, no markdown, no text outside the JSON, in this exact shape: {"summary": "a concise 1-2 sentence summary", "category": "one of: Contracts, Financial, Clients, Other", "due_date": "YYYY-MM-DD if a clear due date is present, or null if not"}';

      let aiResponse;
      try {
        aiResponse = await withTimeout(
          fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              max_tokens: 400,
              system: systemPrompt,
              messages: [{ role: 'user', content: messageContent }]
            })
          }),
          45000,
          'AI request'
        );
      } catch (e) {
        summary = 'AI request failed or timed out: ' + e.message;
        finalStatus = 'needs_review';
        aiResponse = null;
      }

      if (aiResponse) {
        if (aiResponse.ok) {
          const data = await aiResponse.json();
          const raw = data.content?.[0]?.text || '{}';
          try {
            const cleaned = raw.replace(/```json|```/g, '').trim();
            const parsed = JSON.parse(cleaned);
            summary = parsed.summary || null;
            category = parsed.category || 'Other';
            due_date = (parsed.due_date && parsed.due_date !== 'null') ? parsed.due_date : null;
          } catch (parseErr) {
            summary = raw.slice(0, 300);
          }
        } else {
          const errText = await aiResponse.text();
          summary = `AI error (${aiResponse.status}): ${errText.slice(0, 200)}`;
          finalStatus = 'needs_review';
        }
      }
    }

    // 4) Save the result (this always runs, even on partial failures above).
    const { error: updateError } = await supabase
      .from('documents')
      .update({ summary, category, due_date, status: finalStatus })
      .eq('id', documentId);
    if (updateError) throw new Error('Failed to save result: ' + updateError.message);

    return res.status(200).json({ summary, category, due_date, status: finalStatus });
  } catch (err) {
    // Last-resort safety net: never let the function die without marking
    // the document so the UI doesn't stay stuck on "processing" forever.
    try {
      await supabase
        .from('documents')
        .update({ status: 'needs_review', summary: 'Processing error: ' + err.message })
        .eq('id', documentId);
    } catch (e) { /* ignore secondary error */ }
    return res.status(500).json({ error: err.message });
  }
}
