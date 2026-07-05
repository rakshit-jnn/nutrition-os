exports.handler = async (event) => {
  // CORS headers
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
    const { imageBase64, taskType } = body;

    if (!imageBase64 || imageBase64.length < 100) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid image' }) };
    }

    // Ensure we have API key
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY not set');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
    }

    // Determine the prompt based on task type
    let systemPrompt = '';
    
    if (taskType === 'nutrition-label') {
      systemPrompt = 'Extract nutrition info from this label. Return JSON: {protein, calories, carbs, fat, fiber, serving_size}. All numbers only, null if missing.';
    } else if (taskType === 'inventory-photo') {
      systemPrompt = 'Identify all visible food items in this photo. Return JSON with key "items": array of {name, quantity} objects only.';
    } else if (taskType === 'order-screenshot') {
      systemPrompt = 'Extract items from this order screenshot. Return JSON with key "items": array of {name, quantity, price} objects only.';
    } else if (taskType === 'dish-recognition') {
      systemPrompt = 'Identify this cooked dish and estimate macros for the full portion shown. Return JSON: {dish_name, components (array), protein, calories, carbs, fat, fiber}. Numbers only.';
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown task type' }) };
    }

    // Call Anthropic API with vision
    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-1',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: imageBase64
                }
              },
              {
                type: 'text',
                text: systemPrompt
              }
            ]
          }
        ]
      })
    });

    const responseText = await claudeResponse.text();
    
    if (!claudeResponse.ok) {
      console.error('Claude API error:', claudeResponse.status, responseText.substring(0, 200));
      return { 
        statusCode: claudeResponse.status, 
        headers, 
        body: JSON.stringify({ error: 'Vision API failed: ' + claudeResponse.status }) 
      };
    }

    const responseData = JSON.parse(responseText);
    
    if (responseData.error) {
      console.error('Claude error:', responseData.error);
      return { statusCode: 400, headers, body: JSON.stringify({ error: responseData.error.message || 'Claude API error' }) };
    }

    // Extract text from response
    const extractedText = responseData.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    // Parse the JSON response from Claude
    let parsedData;
    try {
      const jsonMatch = extractedText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Could not parse response' }) };
      }
      parsedData = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('Parse error:', e);
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid response format' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, data: parsedData })
    };

  } catch (error) {
    console.error('Error:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Server error' })
    };
  }
};
