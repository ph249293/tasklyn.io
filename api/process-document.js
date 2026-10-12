import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://pzzxmpdwtyhsmjwtapln.supabase.co';
const MAX_TEXT_LENGTH = 12000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
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
    // 1. Download the document from Supabase Storage.
    const { data: signedUrlData, error: signError } = await supabase
      .storage
      .from('documents')
      .createSignedUrl(filePath, 120);

    if (signError) {
      throw signError;
    }

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

    if (buffer.length === 0) {
      throw new Error('The uploaded file is empty.');
    }

    // 2. Detect the document type.
    const lowerPath = String(filePath).toLowerCase();
    const normalizedFileType = String(fileType || '').toLowerCase();

    const isPDF =
      normalizedFileType.includes('pdf') ||
      lowerPath.endsWith('.pdf');

    const isWord =
      normalizedFileType.includes('word') ||
      normalizedFileType.includes('officedocument.wordprocessingml') ||
      lowerPath.endsWith('.docx');

    const isExcel =
      normalizedFileType.includes('sheet') ||
      normalizedFileType.includes('excel') ||
      lowerPath.endsWith('.xlsx') ||
      lowerPath.endsWith('.xls');

    const isImage =
      normalizedFileType.startsWith('image/') ||
      /\.(png|jpe?g|webp)$/i.test(lowerPath);

    let imageMediaType = null;

    if (
      lowerPath.endsWith('.png') ||
      normalizedFileType === 'image/png'
    ) {
      imageMediaType = 'image/png';
    } else if (
      /\.(jpg|jpeg)$/i.test(lowerPath) ||
      normalizedFileType === 'image/jpeg' ||
      normalizedFileType === 'image/jpg'
    ) {
      imageMediaType = 'image/jpeg';
    } else if (
      lowerPath.endsWith('.webp') ||
      normalizedFileType === 'image/webp'
    ) {
      imageMediaType = 'image/webp';
    }

    if (isImage && !imageMediaType) {
      throw new Error(
        'Unsupported image format. Supported formats: PNG, JPG, JPEG, and WebP.'
      );
    }

    if (!isPDF && !isWord && !isExcel && !isImage) {
      throw new Error(
        'Unsupported file format. Supported formats: PDF, DOCX, XLS, XLSX, PNG, JPG, JPEG, and WebP.'
      );
    }

    // 3. Extract text from documents.
    let text = '';

    if (isPDF) {
      // Use PDF.js instead of pdf-parse to extract PDF text.
      let pdf = null;

      try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.js');

        const loadingTask = pdfjs.getDocument({
          data: new Uint8Array(buffer),
          useSystemFonts: true,
          isEvalSupported: false
        });

        pdf = await loadingTask.promise;

        const pages = [];
        let characterCount = 0;

        for (
          let pageNumber = 1;
          pageNumber <= pdf.numPages && characterCount < MAX_TEXT_LENGTH;
          pageNumber++
        ) {
          const page = await pdf.getPage(pageNumber);
          const content = await page.getTextContent();

          const pageText = content.items
            .map(item => {
              if (typeof item.str === 'string') {
                return item.str;
              }

              return '';
            })
            .join(' ');

          pages.push(pageText);
          characterCount += pageText.length;

          if (typeof page.cleanup === 'function') {
            page.cleanup();
          }
        }

        text = pages.join('\n').trim().slice(0, MAX_TEXT_LENGTH);

        if (!text) {
          throw new Error(
            'No selectable text was found in this PDF. It may be scanned or image-based.'
          );
        }
      } catch (pdfError) {
        console.error('Tasklyn PDF extraction failed:', pdfError);

        throw new Error(
          'Could not read this PDF automatically: ' +
          (pdfError?.message || 'Unknown PDF parsing error')
        );
      } finally {
        if (pdf) {
          try {
            await pdf.destroy();
          } catch (cleanupError) {
            console.error(
              'PDF cleanup failed:',
              cleanupError
            );
          }
        }
      }
    } else if (isWord) {
      const mammoth = await import('mammoth');

      const result = await mammoth.extractRawText({
        buffer
      });

      text = String(result.value || '')
        .trim()
        .slice(0, MAX_TEXT_LENGTH);
    } else if (isExcel) {
      const XLSX = await import('xlsx');

      const workbook = XLSX.read(buffer, {
        type: 'buffer'
      });

      text = workbook.SheetNames
        .map(name => {
          return XLSX.utils.sheet_to_csv(
            workbook.Sheets[name]
          );
        })
        .join('\n')
        .trim()
        .slice(0, MAX_TEXT_LENGTH);
    }

    // 4. Prepare the analysis.
    let summary = null;
    let category = 'Other';
    let due_date = null;
    let finalStatus = 'processed';

    const systemPrompt =
      'You analyze business documents, including contracts, spreadsheets, emails, forms, and document images. ' +
      'Respond ONLY with valid JSON, without Markdown or text outside the JSON, using exactly this format: ' +
      '{"summary":"A concise, factual summary in American English, no more than 2 sentences",' +
      '"category":"one of: Contracts, Finance, Clients, Other",' +
      '"due_date":"YYYY-MM-DD if the document clearly states a due date or expiration date, otherwise null}. ' +
      'Do not invent facts or dates. Use null when no clear due date is present. ' +
      'Carefully read visible text when an image is provided. The summary must always be in American English.';

    let messageContent;

    // 5. Prepare the content for Claude.
    if (isImage) {
      const imageBase64 = buffer.toString('base64');

      messageContent = [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: imageMediaType,
            data: imageBase64
          }
        },
        {
          type: 'text',
          text:
            'Read this document image carefully. Extract its relevant information, classify it, summarize it, and identify any clearly stated due date or expiration date. Return only the requested JSON.'
        }
      ];
    } else if (text) {
      messageContent =
        'Analyze this document and return the requested JSON:\n\n' +
        text;
    } else {
      summary =
        'Text could not be extracted automatically from this file. It may be an unsupported format or contain no selectable text.';
      category = 'Other';
      finalStatus = 'needs_review';
    }

    // 6. Analyze the document using Claude.
    if (messageContent) {
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
            system: systemPrompt,
            messages: [
              {
                role: 'user',
                content: messageContent
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

      // 7. Parse and validate the AI response.
      try {
        const cleaned = raw
          .replace(/```json|```/gi, '')
          .trim();

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
          throw new Error(
            'The AI response did not contain a summary.'
          );
        }
      } catch (parseError) {
        throw new Error(
          `Could not parse Anthropic response as valid JSON: ${parseError.message}`
        );
      }
    }

    // 8. Save the result in Supabase.
    const { error: updateError } = await supabase
      .from('documents')
      .update({
        summary,
        category,
        due_date,
        status: finalStatus
      })
      .eq('id', documentId);

    if (updateError) {
      throw updateError;
    }

    return res.status(200).json({
      summary,
      category,
      due_date,
      status: finalStatus
    });
  } catch (error) {
    console.error(
      'Tasklyn document processing error:',
      error
    );

    try {
      await supabase
        .from('documents')
        .update({
          status: 'needs_review'
        })
        .eq('id', documentId);
    } catch (statusError) {
      console.error(
        'Failed to update document status:',
        statusError
      );
    }

    return res.status(500).json({
      error: error?.message || 'An unexpected error occurred.'
    });
  }
}
