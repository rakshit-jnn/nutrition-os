exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body);
    const { imageBase64, imageType, taskType } = body;

    if (!imageBase64 || imageBase64.length < 100) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid image' }) };
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured' }) };
    }

    const prompts = {
      'nutrition-label': 'Extract nutrition info from this label. Return JSON only: {"protein":0,"calories":0,"carbs":0,"fat":0,"fiber":0,"serving_size":""}. Numbers only, null if missing.',
      'inventory-photo': 'This image is EITHER a photo of food/groceries (a shelf, fridge, counter or bag) OR a screenshot of a grocery order or receipt (Blinkit, Zepto, Instamart, BigBasket, DMart, Swiggy). Work out which, then list every food item with its quantity. For a screenshot, read the quantity from the listing (e.g. "500 g", "1 L", "6 pieces") and ignore prices, delivery fees, offers and totals. For a photo, estimate the quantity from what is visible. Indian grocery names. Return JSON only: {"items":[{"name":"","quantity":""}]}',
      'order-screenshot': 'Extract all ordered items. Return JSON only: {"items":[{"name":"","quantity":"","price":0}]}',
      'dish-recognition': 'Identify this dish and estimate macros for the full portion. Return JSON only: {"dish_name":"","components":[],"protein":0,"calories":0,"carbs":0,"fat":0,"fiber":0}'
    };

    const prompt = prompts[taskType];
    if (!prompt) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown task type: ' + taskType }) };
    }

    // Claude's vision API accepts only these four. The v2 frontend re-encodes
    // everything to JPEG before sending, but v1 (and any older client) forwards
    // the raw type, and an iPhone HEIC there would 400 with an opaque message.
    // Falling back to jpeg is the honest guess for anything unrecognised.
    const OK_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const sent = String(imageType || '').toLowerCase();
    const mediaType = OK_TYPES.includes(sent) ? sent
                    : sent === 'image/jpg' ? 'image/jpeg'
                    : 'image/jpeg';

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: imageBase64
              }
            },
            {
              type: 'text',
              text: prompt
            }
          ]
        }]
      })
    });

    const responseText = await claudeResp.text();

    if (!claudeResp.ok) {
      let errMsg = 'Claude API error ' + claudeResp.status;
      try {
        const errData = JSON.parse(responseText);
        errMsg = errData.error?.message || errMsg;
      } catch(e) {}
      console.error('Claude error:', errMsg, responseText.substring(0, 300));
      return { statusCode: 500, headers, body: JSON.stringify({ error: errMsg }) };
    }

    const responseData = JSON.parse(responseText);
    const extractedText = responseData.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Extract JSON from response
    const jsonMatch = extractedText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: { raw: extractedText } }) };
    }

    const parsedData = JSON.parse(jsonMatch[0]);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, data: parsedData })
    };

  } catch (error) {
    console.error('Handler error:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
