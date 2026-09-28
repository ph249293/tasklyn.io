// ============================================================
// Tasklyn AI — Server function that analyzes documents
// Reads PDF/Word/Excel files, summarizes and categorizes them,
// detects due dates, and saves the result to the database.
//
// Required Vercel environment variables:
// - ANTHROPIC_API_KEY
// - SUPABASE_SERVICE_ROLE_KEY (server-side only; never expose it
//   in frontend code or send it to the browser).
// ============================================================

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://pzzxmpdwtyhsmjwtapln.supabase.co';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { documentId, filePath, fileType } = req.body || {};

  if (!documentId || !filePath) {
    return res.status(400).json({
      error: 'documentId or filePath is missing'
    });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!serviceKey) {
    return res.status(500).json({
      error: 'SUPABASE_SERVICE_ROLE_KEY is missing on the server.'
    });
  }

  if (!anthropicKey) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY is missing on the server.'
    });
  }

  const supabase = createClient(SUPABASE_URL, serviceKey);

  try {
    // 1) Download the file from Supabase Storage.
    const { data: signedUrlData, error: signError } = await supabase
      .storage
      .from('documents')
      .createSignedUrl(filePath, 120);

    if (signError) throw signError;

    if (!signedUrlData?.signedUrl) {
      throw new Error('Supabase did not return a signed download URL.');
    }

    const fileResponse = await fetch(signedUrlData.signedUrl);

    if (!fileResponse.ok) {
      throw new Error(
        `Failed to download file from storage: HTTP ${fileResponse.status}`
      );
    }

    const buffer = Buffer.from(await fileResponse.arrayBuffer());

    // 2) Extract text based on the file type.
    let text = '';

    const lowerPath = String(filePath).toLowerCase();
    const normalizedFileType = String(fileType || '').toLowerCase();

    if (
      normalizedFileType.includes('pdf') ||
      lowerPath.endsWith('.pdf')
    ) {
      const { default: pdfParse } = await import('pdf-parse');
      const parsed = await pdfParse(buffer);
      text = parsed.text || '';

    } else if (
      normalizedFileType.includes('word') ||
      lowerPath.endsWith('.docx')
    ) {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      text = result.value || '';

    } else if (
      normalizedFileType.includes('sheet') ||
      normalizedFileType.includes('excel') ||
      lowerPath.endsWith('.xlsx') ||
      lowerPath.endsWith('.xls')
    ) {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(buffer, { type: 'buffer' });

      text = workbook.SheetNames
        .map(name => XLSX.utils.sheet_to_csv(workbook.Sheets[name]))
        .join('\n');
    }

    // Images are not OCR-processed by this function.

    text = String(text).trim().slice(0, 12000);

    let summary = null;
    let category = 'Other';
    let due_date = null;
    let finalStatus = 'processed';

    if (text) {
      const aiResponse = await fetch(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 400,

            system: 'You analyze business documents, including contracts, spreadsheets, emails, and forms. Respond ONLY with valid JSON, without Markdown or text outside the JSON, using exactly this format: {"summary":"A concise, factual summary in American English, no more than 2 sentences.","category":"one of: Contracts, Finance, Clients, Other","due_date":"YYYY-MM-DD if the document clearly states a due date or expiration date, otherwise null"}. Do not invent facts or dates. Use null when no clear due date is present. The summary must always be in American English, regardless of the document language.',

            messages: [
              {
                role: 'user',
                content: `Analyze this document and return the requested JSON:\n\n${text}`
              }
            ]
          })
        }
      );

      if (!aiResponse.ok) {
        const errorText = await aiResponse.text();

        throw new Error(
          `Anthropic API error (${aiResponse.status}): ${errorText.slice(0, 500)}`
        );
      }

      const data = await aiResponse.json();

      const raw =
        data.content?.find(item => item.type === 'text')?.text || '{}';

      try {
        const cleaned = raw.replace(/```json|```/gi, '').trim();
        const parsed = JSON.parse(cleaned);

        summary =
          typeof parsed.summary === 'string'
            ? parsed.summary
            : null;

        category = [
          'Contracts',
          'Finance',
          'Clients',
          'Other'
        ].includes(parsed.category)
          ? parsed.category
          : 'Other';

        const candidateDate = parsed.due_date;

        due_date =
          typeof candidateDate === 'string' &&
          /^\d{4}-\d{2}-\d{2}$/.test(candidateDate) &&
          !Number.isNaN(
            Date.parse(`${candidateDate}T00:00:00Z`)
          )
            ? candidateDate
            : null;

        if (!summary) {
          throw new Error('The AI response did not contain a summary.');
        }

      } catch (parseErr) {
        throw new Error(
          `Could not parse Anthropic response as valid JSON: ${parseErr.message}`
        );
      }

    } else {
      summary =
        'Text could not be extracted automatically from this file. It may be an image or an unsupported format.';

      category = 'Other';
      finalStatus = 'needs_review';
    }

    // 3) Save the result to the database.
    const { error: updateError } = await supabase
      .from('documents')
      .update({
        summary,
        category,
        due_date,
        status: finalStatus
      })
      .eq('id', documentId);

    if (updateError) throw updateError;

    return res.status(200).json({
      summary,
      category,
      due_date,
      status: finalStatus
    });

  } catch (err) {
    try {
      await supabase
        .from('documents')
        .update({ status: 'needs_review' })
        .eq('id', documentId);

    } catch (secondaryError) {
      // Ignore secondary status-update errors.
    }

    return res.status(500).json({
      error: err.message || 'Document processing failed.'
    });
  }
}
